import type { ActionItem, Decision, TranscriptSegment } from "@/lib/meeting";
import { normalizeMeetingSummary } from "@/lib/meeting-summary-normalizer";
import { isPlaceholderMeetingSummary } from "@/lib/meeting-result-quality";
import {
  diagnoseTranscriptQuality,
  formatTranscriptQualityDiagnostic,
  isPlaceholderTranscriptText,
  type TranscriptQualityReport,
} from "@/lib/transcript-quality";
import {
  isDefinitiveVolcanoNonAcceptance,
  transcribeWithVolcanoFileAsr,
  type VolcanoAsrConfig,
} from "@/lib/volcano-asr";
import type { MeetingProcessingRoute } from "@/lib/processing-route";
import { buildNoSpeechMeetingSummary } from "@/lib/no-speech-summary";
import {
  DEFAULT_MEETING_CONTENT_LOCALE,
  getMeetingContentCopy,
  type MeetingContentLocale,
} from "@/lib/meeting-content-locale";
import { postArkJson } from "@/lib/server/ark-endpoint-security";

export type MeetingSummary = {
  summary: string;
  topics: string[];
  speakerViews: Array<{
    speaker: string;
    view: string;
  }>;
  decisions: Decision[];
  actionItems: ActionItem[];
  risks: string[];
  openQuestions: string[];
  knowledgePoints: string[];
};

export type MeetingResult = {
  audioRevision?: string;
  audioSha256?: string;
  meetingId: string;
  title: string;
  generatedAt: string;
  provider: "mock" | "openai" | "volcano";
  adapter: string;
  transcript: TranscriptSegment[];
  summary: MeetingSummary;
  obsidianMarkdown: string;
  diagnostics: string[];
  contentLocale?: MeetingContentLocale;
  processingRoute?: MeetingProcessingRoute;
  processedMinutes?: number;
  officialMinutesCharged?: number;
  processingOperationKey?: string;
};

export type MeetingProviderRuntime = {
  volcanoAsr?: VolcanoAsrConfig;
  ark?: {
    apiKey?: string;
    model?: string;
    baseUrl?: string;
  };
  source?: "user" | "env";
};

export type MeetingProviderPolicy = {
  asrMaxAttempts?: number;
  summaryMaxAttempts?: number;
};

export type MeetingProviderStage = "asr" | "summary";

export async function processMeetingAudio(input: {
  meetingId: string;
  title?: string;
  audio: {
    audioUrl?: string;
    buffer?: Buffer;
    delivery?: "private-presigned-url" | "local-buffer-fallback";
    mimeType: string;
    fileName: string;
    durationMs: number;
    transcoded?: boolean;
  };
  runtime?: MeetingProviderRuntime;
  providerPolicy?: MeetingProviderPolicy;
  contentLocale?: MeetingContentLocale;
  preferredTranscript?: {
    adapter: string;
    diagnostic: string;
    noSpeech?: boolean;
    transcript: TranscriptSegment[];
  };
  preferredSummary?: {
    diagnostic: string;
    summary: MeetingSummary;
  };
  onProviderStageStart?: (stage: MeetingProviderStage) => Promise<void>;
  onProviderStageComplete?: (stage: MeetingProviderStage) => Promise<void>;
  onProviderStageRejected?: (stage: MeetingProviderStage, error: unknown) => Promise<void>;
  onTranscriptReady?: (checkpoint: { adapter: string; noSpeech: boolean; transcript: TranscriptSegment[] }) => Promise<void>;
  onSummaryReady?: (checkpoint: { summary: MeetingSummary }) => Promise<void>;
}) {
  const contentLocale = input.contentLocale ?? DEFAULT_MEETING_CONTENT_LOCALE;
  const copy = getMeetingContentCopy(contentLocale);
  const provider = getProvider();
  const diagnostics: string[] = [];
  let transcript: TranscriptSegment[];
  let adapter = "mock-file-transcriber";
  let noSpeech = false;
  let paidAsrAttempted = false;

  if (provider === "volcano" && input.preferredTranscript && (input.preferredTranscript.transcript.length > 0 || input.preferredTranscript.noSpeech)) {
    transcript = input.preferredTranscript.transcript;
    adapter = input.preferredTranscript.adapter;
    noSpeech = input.preferredTranscript.noSpeech === true;
    diagnostics.push(input.preferredTranscript.diagnostic);
  } else if (provider === "volcano") {
    try {
      const result = await transcribeWithVolcanoFileAsr({
        meetingId: input.meetingId,
        audioUrl: input.audio.audioUrl,
        buffer: input.audio.buffer,
        mimeType: input.audio.mimeType,
        fileName: input.audio.fileName,
        durationMs: input.audio.durationMs,
        transcoded: input.audio.transcoded,
        config: input.providerPolicy?.asrMaxAttempts
          ? { ...input.runtime?.volcanoAsr, maxAttempts: input.providerPolicy.asrMaxAttempts }
          : input.runtime?.volcanoAsr,
        beforeProviderRequest: async () => {
          await input.onProviderStageStart?.("asr");
          paidAsrAttempted = true;
        },
      });

      transcript = result.transcript;
      adapter = result.adapter;
      noSpeech = result.noSpeech;
      diagnostics.push(
        `asr_route: mode=${result.mode}; resource=${result.resourceId}; turbo_escalated=${result.fallbackUsed ? "yes" : "no"}; reason=${result.fallbackReason ?? "none"}.`,
      );
      if (noSpeech) diagnostics.push(copy.asrNoSpeechDiagnostic);
      if (result.attempts > 1) diagnostics.push(`Volcano file ASR succeeded after ${result.attempts} attempts.`);
      if (result.transcoded) diagnostics.push("Audio was loudness-normalized, converted to mono speech input, and encoded as 48 kbps OGG Opus before Volcano ASR.");
      if (input.audio.delivery === "private-presigned-url") diagnostics.push("Audio was delivered to Volcano through a short-lived private object URL.");
      if (input.runtime?.source === "user" && input.runtime.volcanoAsr) diagnostics.push("Using user BYOK Volcano ASR configuration.");
    } catch (error) {
      if (paidAsrAttempted && isDefinitiveVolcanoNonAcceptance(error)) {
        await input.onProviderStageRejected?.("asr", error);
        paidAsrAttempted = false;
      }
      // A paid provider attempt must never be converted into a completed placeholder
      // result. Propagating the original error keeps the audio durable, leaves the
      // provider fence reconcilable, and prevents publishing or billing a fake result.
      throw error;
    }
  } else {
    transcript = buildFallbackTranscript(contentLocale);
    diagnostics.push(`${provider} post-meeting transcription is not wired yet; using fallback transcript.`);
  }

  if (paidAsrAttempted) {
    if (input.onProviderStageComplete && !input.onTranscriptReady) {
      throw new Error("ASR provider step cannot complete without a durable transcript checkpoint callback.");
    }
    await input.onTranscriptReady?.({ adapter, noSpeech, transcript });
    await input.onProviderStageComplete?.("asr");
  }

  const transcriptQuality = diagnoseTranscriptQuality(transcript);
  if (transcriptQuality.status !== "usable") {
    diagnostics.push(formatTranscriptQualityDiagnostic(transcriptQuality));
  }

  const title = input.title || copy.defaultTitle(input.meetingId);
  const summary = await summarizeTranscript({
    title,
    transcript,
    diagnostics,
    noSpeech,
    runtime: input.runtime,
    transcriptQuality,
    contentLocale,
    preferredSummary: input.preferredSummary,
    summaryMaxAttempts: input.providerPolicy?.summaryMaxAttempts,
    onProviderStageStart: input.onProviderStageStart,
    onProviderStageComplete: input.onProviderStageComplete,
    onProviderStageRejected: input.onProviderStageRejected,
    onSummaryReady: input.onSummaryReady,
  });
  const shareUrl = `/share/${input.meetingId}`;
  const obsidianMarkdown = buildMeetingMarkdown({
    title,
    meetingId: input.meetingId,
    shareUrl,
    transcript,
    summary,
    contentLocale,
  });

  return {
    meetingId: input.meetingId,
    title,
    generatedAt: new Date().toISOString(),
    provider,
    adapter,
    transcript,
    summary,
    obsidianMarkdown,
    diagnostics,
    contentLocale,
  } satisfies MeetingResult;
}

export function requiresMeetingAudioForProcessing() {
  return getProvider() === "volcano";
}

async function summarizeTranscript(input: {
  title: string;
  transcript: TranscriptSegment[];
  diagnostics: string[];
  noSpeech: boolean;
  runtime?: MeetingProviderRuntime;
  transcriptQuality: TranscriptQualityReport;
  contentLocale: MeetingContentLocale;
  preferredSummary?: {
    diagnostic: string;
    summary: MeetingSummary;
  };
  summaryMaxAttempts?: number;
  onProviderStageStart?: (stage: MeetingProviderStage) => Promise<void>;
  onProviderStageComplete?: (stage: MeetingProviderStage) => Promise<void>;
  onProviderStageRejected?: (stage: MeetingProviderStage, error: unknown) => Promise<void>;
  onSummaryReady?: (checkpoint: { summary: MeetingSummary }) => Promise<void>;
}) {
  const arkApiKey = input.runtime?.ark?.apiKey || process.env.ARK_API_KEY;
  const arkModel = input.runtime?.ark?.model || process.env.ARK_CHAT_MODEL;
  const arkBaseUrl = input.runtime?.ark?.baseUrl || process.env.ARK_BASE_URL || "https://ark.cn-beijing.volces.com/api/v3";

  if (input.preferredSummary) {
    input.diagnostics.push(input.preferredSummary.diagnostic);
    return input.preferredSummary.summary;
  }

  if (input.transcriptQuality.status !== "usable") {
    input.diagnostics.push("Transcript quality is not usable enough for model summarization; using deterministic local meeting summary.");
    return buildLocalSummary(input.transcript, { noSpeech: input.noSpeech, contentLocale: input.contentLocale });
  }

  if (!arkApiKey || !arkModel) {
    input.diagnostics.push("ARK_API_KEY or ARK_CHAT_MODEL is missing; using deterministic local meeting summary.");
    return buildLocalSummary(input.transcript, { contentLocale: input.contentLocale });
  }

  await input.onProviderStageStart?.("summary");
  let summary: MeetingSummary;
  try {
    const content = await generateArkSummaryContent({
      apiKey: arkApiKey,
      baseUrl: arkBaseUrl,
      diagnostics: input.diagnostics,
      model: arkModel,
      title: input.title,
      transcript: input.transcript,
      contentLocale: input.contentLocale,
      maxAttempts: input.summaryMaxAttempts,
    });
    if (input.runtime?.ark?.apiKey) input.diagnostics.push("Using user BYOK Ark summary configuration.");

    summary = normalizeMeetingSummary(JSON.parse(extractJsonObject(content)), input.contentLocale);
  } catch (error) {
    if (!isDefinitiveArkSummaryNonAcceptance(error)) throw error;
    await input.onProviderStageRejected?.("summary", error);
    throw error;
  }
  if (input.onProviderStageComplete && !input.onSummaryReady) {
    throw new Error("Summary provider step cannot complete without a durable summary checkpoint callback.");
  }
  await input.onSummaryReady?.({ summary });
  await input.onProviderStageComplete?.("summary");
  return summary;
}

class ArkSummaryRequestRejectedError extends Error {
  readonly httpStatus: number;

  constructor(httpStatus: number) {
    super(`Ark summary request was rejected: HTTP ${httpStatus}`);
    this.name = "ArkSummaryRequestRejectedError";
    this.httpStatus = httpStatus;
  }
}

function isDefinitiveArkSummaryNonAcceptance(error: unknown): error is ArkSummaryRequestRejectedError {
  return error instanceof ArkSummaryRequestRejectedError;
}

async function generateArkSummaryContent(input: {
  apiKey: string;
  baseUrl: string;
  diagnostics: string[];
  model: string;
  title: string;
  transcript: TranscriptSegment[];
  contentLocale: MeetingContentLocale;
  maxAttempts?: number;
}) {
  const retryConfig = getArkSummaryRetryConfig(input.maxAttempts);
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= retryConfig.maxAttempts; attempt += 1) {
    try {
      const content = await requestArkSummaryContent(input, retryConfig.timeoutMs);
      const normalized = normalizeMeetingSummary(JSON.parse(extractJsonObject(content)), input.contentLocale);
      if (isPlaceholderMeetingSummary(normalized.summary)) {
        throw new Error("Ark summary returned a non-actionable placeholder summary.");
      }
      return content;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error("Ark summary failed.");
      const retryable = isRetryableArkSummaryError(lastError);

      if (attempt >= retryConfig.maxAttempts || !retryable) {
        throw lastError;
      }

      input.diagnostics.push(`Ark summary attempt ${attempt} failed; retrying with transcript-grounded JSON prompt.`);
      await sleep(retryConfig.retryDelayMs * attempt);
    }
  }

  throw lastError ?? new Error("Ark summary failed.");
}

async function requestArkSummaryContent(input: {
  apiKey: string;
  baseUrl: string;
  diagnostics: string[];
  model: string;
  title: string;
  transcript: TranscriptSegment[];
  contentLocale: MeetingContentLocale;
}, timeoutMs: number) {
  const copy = getMeetingContentCopy(input.contentLocale);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await postArkJson({
      apiKey: input.apiKey,
      baseUrl: input.baseUrl,
      signal: controller.signal,
      body: {
        model: input.model,
        temperature: 0.2,
        thinking: {
          type: "disabled",
        },
        max_tokens: getArkSummaryMaxTokens(),
        messages: [
          {
            role: "system",
            content: copy.summarySystemPrompt,
          },
          {
            role: "user",
            content: JSON.stringify({
              title: input.title,
              output_language: copy.outputLanguage,
              required_schema: {
                summary: "string",
                topics: ["string"],
                speakerViews: [{ speaker: "string", view: "string" }],
                decisions: [{ id: "string", title: "string", detail: "string", status: "candidate|confirmed" }],
                actionItems: [{ id: "string", owner: "string", task: "string", due: "string", status: "candidate|confirmed" }],
                risks: ["string"],
                openQuestions: ["string"],
                knowledgePoints: ["string"],
              },
              transcript: input.transcript,
            }),
          },
        ],
      },
      maxResponseBytes: 2 * 1024 * 1024,
    });

    if (!response.ok) {
      throw new ArkSummaryRequestRejectedError(response.status);
    }

    const data = JSON.parse(response.bodyText) as unknown;
    const usageDiagnostic = formatArkSummaryUsageDiagnostic(parseArkSummaryUsage(data));
    if (usageDiagnostic) input.diagnostics.push(usageDiagnostic);
    const content = readArkSummaryContent(data);

    if (!content) throw new Error("Ark summary returned empty content.");

    return content;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`Ark summary timed out after ${timeoutMs}ms.`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function getArkSummaryRetryConfig(maxAttempts?: number) {
  return {
    maxAttempts: clampInteger(maxAttempts === undefined ? process.env.OWNMINUTES_SUMMARY_MAX_ATTEMPTS : String(maxAttempts), 1, 3, 1),
    retryDelayMs: clampInteger(process.env.OWNMINUTES_SUMMARY_RETRY_DELAY_MS, 0, 5000, 300),
    timeoutMs: clampInteger(process.env.OWNMINUTES_SUMMARY_TIMEOUT_MS, 3000, 120000, 30000),
  };
}

function getArkSummaryMaxTokens() {
  return clampInteger(process.env.OWNMINUTES_SUMMARY_MAX_TOKENS, 256, 4096, 4096);
}

type ArkSummaryUsage = {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedTokens?: number;
  reasoningTokens?: number;
};

function parseArkSummaryUsage(payload: unknown): ArkSummaryUsage | null {
  if (!isRecord(payload) || !isRecord(payload.usage)) return null;

  const usage = payload.usage;
  const promptDetails = isRecord(usage.prompt_tokens_details) ? usage.prompt_tokens_details : null;
  const completionDetails = isRecord(usage.completion_tokens_details) ? usage.completion_tokens_details : null;
  const inputTokens = readNonNegativeInteger(usage.prompt_tokens) ?? readNonNegativeInteger(usage.input_tokens);
  const outputTokens = readNonNegativeInteger(usage.completion_tokens) ?? readNonNegativeInteger(usage.output_tokens);
  const explicitTotal = readNonNegativeInteger(usage.total_tokens);
  const totalTokens = explicitTotal ?? (inputTokens !== undefined && outputTokens !== undefined ? inputTokens + outputTokens : undefined);
  const parsed = {
    inputTokens,
    outputTokens,
    totalTokens,
    cachedTokens: readNonNegativeInteger(promptDetails?.cached_tokens),
    reasoningTokens: readNonNegativeInteger(completionDetails?.reasoning_tokens),
  } satisfies ArkSummaryUsage;

  return Object.values(parsed).some((value) => value !== undefined) ? parsed : null;
}

function formatArkSummaryUsageDiagnostic(usage: ArkSummaryUsage | null) {
  if (!usage) return null;

  const fields = [
    usage.inputTokens === undefined ? null : `input=${usage.inputTokens}`,
    usage.outputTokens === undefined ? null : `output=${usage.outputTokens}`,
    usage.totalTokens === undefined ? null : `total=${usage.totalTokens}`,
    usage.cachedTokens === undefined ? null : `cached=${usage.cachedTokens}`,
    usage.reasoningTokens === undefined ? null : `reasoning=${usage.reasoningTokens}`,
  ].filter((value): value is string => Boolean(value));

  return fields.length > 0 ? `Ark summary token usage: ${fields.join(", ")}.` : null;
}

function readArkSummaryContent(payload: unknown) {
  if (!isRecord(payload) || !Array.isArray(payload.choices)) return undefined;
  const firstChoice = payload.choices[0];
  if (!isRecord(firstChoice) || !isRecord(firstChoice.message)) return undefined;
  return typeof firstChoice.message.content === "string" ? firstChoice.message.content : undefined;
}

function readNonNegativeInteger(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRetryableArkSummaryError(error: Error) {
  return /HTTP (408|409|425|429|5\d\d)|timed out|fetch failed|network|terminated|empty content|non-actionable placeholder summary/i.test(error.message);
}

function clampInteger(value: string | undefined, min: number, max: number, fallback: number) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractJsonObject(content: string) {
  const trimmed = content.trim();

  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return trimmed;
  }

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    return fenced[1].trim();
  }

  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");

  if (start >= 0 && end > start) {
    return trimmed.slice(start, end + 1);
  }

  return trimmed;
}

function buildLocalSummary(
  transcript: TranscriptSegment[],
  options: { noSpeech?: boolean; contentLocale?: MeetingContentLocale } = {},
): MeetingSummary {
  const contentLocale = options.contentLocale ?? DEFAULT_MEETING_CONTENT_LOCALE;
  const copy = getMeetingContentCopy(contentLocale);
  const meaningfulSegments = transcript.filter((segment) => segment.text.trim() && segment.speaker !== "System" && !isPlaceholderTranscriptText(segment.text));
  const sourceSegments = meaningfulSegments.length > 0 ? meaningfulSegments : [];
  const speakers = Array.from(new Set(sourceSegments.map((segment) => segment.speaker))).filter(Boolean);
  const preview = sourceSegments.slice(0, 6).map((segment) => segment.text.trim()).join(" ");
  const decisions = inferDecisions(sourceSegments, contentLocale);
  const actionItems = inferActionItems(sourceSegments, contentLocale);
  const risks = inferRisks(sourceSegments, contentLocale);
  const openQuestions = inferOpenQuestions(sourceSegments, contentLocale);

  if (options.noSpeech) {
    return buildNoSpeechMeetingSummary(contentLocale);
  }

  return {
    summary: preview ? `${copy.localSummaryPrefix}${preview}` : copy.noTranscriptSummary,
    topics: inferTopics(sourceSegments, contentLocale),
    speakerViews: speakers.map((speaker) => ({
      speaker,
      view: summarizeSpeakerView(speaker, sourceSegments, contentLocale),
    })),
    decisions,
    actionItems,
    risks: risks.length > 0 ? risks : [copy.conservativeRisk],
    openQuestions: openQuestions.length > 0 ? openQuestions : [copy.setupQuestion],
    knowledgePoints: inferKnowledgePoints(sourceSegments, contentLocale),
  };
}

export function buildMeetingMarkdown(input: {
  title: string;
  meetingId: string;
  shareUrl: string;
  transcript: TranscriptSegment[];
  summary: MeetingSummary;
  contentLocale?: MeetingContentLocale;
}) {
  const copy = getMeetingContentCopy(input.contentLocale ?? DEFAULT_MEETING_CONTENT_LOCALE);
  const markdown = copy.markdown;
  const date = new Date().toISOString().slice(0, 10);
  const transcript = input.transcript.map((segment) => `- **${segment.timestamp} ${segment.speaker}**${markdown.separator}${segment.text}`).join("\n");
  const actions = input.summary.actionItems.length
    ? input.summary.actionItems
        .map((item) => `| ${escapeMarkdownTable(item.task)} | ${escapeMarkdownTable(item.owner)} | ${escapeMarkdownTable(item.due)} | ${item.status === "confirmed" ? markdown.confirmed : markdown.candidate} |`)
        .join("\n")
    : `| ${copy.unknown} | ${copy.unknown} | ${copy.unknown} | ${markdown.candidate} |`;
  const decisions = input.summary.decisions.length
    ? input.summary.decisions.map((item) => `- **${item.title}**${markdown.separator}${item.detail || copy.unknown}`).join("\n")
    : `- ${copy.unknown}`;

  return `---
type: meeting
project: OwnMinutes
date: ${date}
tags:
  - meeting
  - ownminutes
share_url: ${input.shareUrl}
---

# ${input.title}

## ${markdown.summary}

${input.summary.summary}

## ${markdown.decisions}

${decisions}

## ${markdown.actions}

| ${markdown.action} | ${markdown.owner} | ${markdown.due} | ${markdown.status} |
|---|---|---|---|
${actions}

## ${markdown.risks}

${input.summary.risks.map((item) => `- ${item}`).join("\n")}

## ${markdown.knowledge}

${input.summary.knowledgePoints.map((item) => `- ${item}`).join("\n")}

## ${markdown.topics}

${input.summary.topics.map((topic) => `- ${topic}`).join("\n")}

## ${markdown.speakerViews}

${input.summary.speakerViews.map((item) => `- **${item.speaker}**${markdown.separator}${item.view}`).join("\n")}

## ${markdown.openQuestions}

${input.summary.openQuestions.map((item) => `- ${item}`).join("\n")}

## ${markdown.transcript}

${transcript}
`;
}

function inferTopics(segments: TranscriptSegment[], contentLocale: MeetingContentLocale) {
  const candidates = segments
    .map((segment) => cleanupSentence(segment.text))
    .filter(Boolean)
    .slice(0, 4);

  return candidates.length > 0 ? candidates : [...getMeetingContentCopy(contentLocale).defaultTopics];
}

function inferDecisions(segments: TranscriptSegment[], contentLocale: MeetingContentLocale): Decision[] {
  const decisionPattern = contentLocale === "en"
    ? /\b(decide[ds]?|decision|confirm(?:ed)?|agree[sd]?|adopt(?:ed)?|will use|must|default|prioriti[sz]e[ds]?)\b/i
    : /(决定|決定|确认|確認|确定|確定|同意|采用|採用|不做|先做|必须|必須|默认|預設|优先|優先)/;
  const separator = getMeetingContentCopy(contentLocale).markdown.separator;
  return segments
    .filter((segment) => decisionPattern.test(segment.text))
    .slice(0, 6)
    .map((segment, index) => ({
      id: `local-d${index + 1}`,
      title: truncateText(cleanupSentence(segment.text), 36),
      detail: `${segment.speaker} ${segment.timestamp}${separator}${segment.text}`,
      status: "candidate",
    }));
}

function inferActionItems(segments: TranscriptSegment[], contentLocale: MeetingContentLocale): ActionItem[] {
  const copy = getMeetingContentCopy(contentLocale);
  const actionPattern = contentLocale === "en"
    ? /\b(need(?:s|ed)? to|next step|action item|responsible|complete|implement|configure|verify|check|confirm|prepare|add|handle|follow up)\b/i
    : /(需要|下一步|待办|待辦|负责|負責|完成|实现|實現|配置|設定|验证|驗證|检查|檢查|确认|確認|准备|準備|补充|補充|处理|處理)/;
  return segments
    .filter((segment) => actionPattern.test(segment.text))
    .slice(0, 8)
    .map((segment, index) => ({
      id: `local-a${index + 1}`,
      owner: segment.speaker || copy.unknown,
      task: truncateText(cleanupSentence(segment.text), 60),
      due: inferDue(segment.text, contentLocale),
      status: "candidate",
    }));
}

function inferRisks(segments: TranscriptSegment[], contentLocale: MeetingContentLocale) {
  const riskPattern = contentLocale === "en"
    ? /\b(risk|block(?:er|ed|ing)?|issue|fail(?:ed|ure)?|cannot|can't|unable|missing|waiting|uncertain|leak)\b/i
    : /(风险|風險|阻塞|问题|問題|失败|失敗|不能|无法|無法|缺少|尚未|等待|不确定|不確定|误判|誤判|泄露|洩漏)/;
  return segments
    .filter((segment) => riskPattern.test(segment.text))
    .slice(0, 6)
    .map((segment) => cleanupSentence(segment.text));
}

function inferOpenQuestions(segments: TranscriptSegment[], contentLocale: MeetingContentLocale) {
  const questionPattern = contentLocale === "en"
    ? /[?？]|\b(whether|how|why|should we|need to confirm|uncertain)\b/i
    : /(？|\?|是否|怎么|怎麼|如何|为什么|為什麼|需要确认|需要確認|不确定|不確定)/;
  return segments
    .filter((segment) => questionPattern.test(segment.text))
    .slice(0, 6)
    .map((segment) => cleanupSentence(segment.text));
}

function inferKnowledgePoints(segments: TranscriptSegment[], contentLocale: MeetingContentLocale) {
  const points = segments
    .filter((segment) => segment.speaker !== "System")
    .map((segment) => cleanupSentence(segment.text))
    .filter(Boolean)
    .slice(0, 6);

  return points.length > 0 ? points : [getMeetingContentCopy(contentLocale).knowledgeFallback];
}

function summarizeSpeakerView(speaker: string, segments: TranscriptSegment[], contentLocale: MeetingContentLocale) {
  const texts = segments.filter((segment) => segment.speaker === speaker).map((segment) => cleanupSentence(segment.text)).filter(Boolean);
  if (texts.length === 0) return getMeetingContentCopy(contentLocale).unknown;
  return truncateText(texts.slice(0, 3).join(" "), 100);
}

function inferDue(text: string, contentLocale: MeetingContentLocale) {
  const copy = getMeetingContentCopy(contentLocale);
  if (/今天|today/i.test(text)) return copy.due.today;
  if (/明天|tomorrow/i.test(text)) return copy.due.tomorrow;
  if (/本周|本週|this week/i.test(text)) return copy.due.thisWeek;
  if (/下周|下週|next week/i.test(text)) return copy.due.nextWeek;
  if (/月底|end of (?:the )?month/i.test(text)) return copy.due.monthEnd;
  return copy.unknown;
}

function cleanupSentence(text: string) {
  return text.replace(/\s+/g, " ").trim();
}

function truncateText(text: string, maxLength: number) {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1)}…`;
}

function escapeMarkdownTable(text: string) {
  return text.replace(/\|/g, "\\|").replace(/\n/g, " ");
}

function buildFallbackTranscript(contentLocale: MeetingContentLocale, message?: string): TranscriptSegment[] {
  return [
    {
      id: "final-fallback-1",
      speaker: "System",
      timestamp: "00:00",
      text: message || getMeetingContentCopy(contentLocale).fallbackTranscript,
    },
  ];
}

function getProvider() {
  const provider = process.env.TRANSCRIPTION_PROVIDER?.trim().toLowerCase();
  if (provider === "openai" || provider === "volcano") return provider;
  return "mock";
}
