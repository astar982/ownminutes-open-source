import type { MeetingResult } from "@/lib/meeting-processing";
import { diagnoseTranscriptQuality, isPlaceholderTranscriptText } from "./transcript-quality";

export type MeetingResultQualityStatus = "verified" | "unverified";

export type MeetingResultQuality = {
  status: MeetingResultQualityStatus;
  publishLabel: string;
  shareWarningTitle: string;
  shareWarningDetail: string;
  markdownNotice: string;
  reasons: string[];
  canTreatAsFormal: boolean;
};

const BENIGN_DIAGNOSTICS = new Set(["Using user BYOK Volcano ASR configuration.", "Using user BYOK Ark summary configuration."]);

const UNVERIFIED_DIAGNOSTIC_PATTERN =
  /(fallback|not wired|missing|failed|not usable|low_confidence|empty|placeholder|deterministic local|ARK_API_KEY|ARK_CHAT_MODEL|Transcript quality|等待正式识别|没有可用逐字稿|本地保守纪要|尚未|未完成)/i;

const UNVERIFIED_TRANSCRIPT_DIAGNOSTIC_PATTERN =
  /(post-meeting transcription is not wired|file ASR[^.]*failed|asr_incomplete|transcript quality (?:low_confidence|empty)|正式识别尚未完成|等待正式识别|没有可用逐字稿|会后识别服务尚未)/i;

const PLACEHOLDER_SUMMARY_PATTERN =
  /^(?:无|暂无|没有|未发现|未检测到|无法提取|无法生成).{0,12}(?:相关)?(?:会议|讨论|有效|可用)?(?:内容|信息|纪要)?[。.!！]?$/i;

export function assessMeetingResultQuality(result: MeetingResult | null | undefined): MeetingResultQuality {
  const reasons: string[] = [];

  if (!result) {
    reasons.push("missing meeting result");
    return buildQuality("unverified", reasons);
  }

  const transcriptQuality = diagnoseTranscriptQuality(result.transcript);
  if (transcriptQuality.status !== "usable") {
    reasons.push(`transcript quality ${transcriptQuality.status}`);
  }

  if (result.provider === "mock") {
    reasons.push("mock provider");
  }

  if (/fallback/i.test(result.adapter)) {
    reasons.push("fallback adapter");
  }

  if (result.transcript.some((segment) => isPlaceholderTranscriptText(segment.text))) {
    reasons.push("placeholder transcript text");
  }

  if (isPlaceholderMeetingSummary(result.summary.summary)) {
    reasons.push("placeholder meeting summary");
  }

  const unverifiedDiagnostics = result.diagnostics.filter((diagnostic) => !BENIGN_DIAGNOSTICS.has(diagnostic) && UNVERIFIED_DIAGNOSTIC_PATTERN.test(diagnostic));
  if (unverifiedDiagnostics.length > 0) {
    reasons.push("unverified diagnostics");
  }

  return buildQuality(reasons.length > 0 ? "unverified" : "verified", uniqueReasons(reasons));
}

export function canReuseFormalTranscript(result: MeetingResult | null | undefined) {
  if (!result) return false;
  if (result.provider === "mock") return false;
  if (/(fallback|mock|not[-_ ]?wired|placeholder)/i.test(result.adapter)) return false;
  if (diagnoseTranscriptQuality(result.transcript).status !== "usable") return false;
  if (result.transcript.some((segment) => isPlaceholderTranscriptText(segment.text))) return false;

  return !result.diagnostics.some((diagnostic) => UNVERIFIED_TRANSCRIPT_DIAGNOSTIC_PATTERN.test(diagnostic));
}

export function isPlaceholderMeetingSummary(value: unknown) {
  if (typeof value !== "string") return true;
  const normalized = value.trim().replace(/\s+/g, " ");
  if (!normalized) return true;
  if (/^(?:不确定|暂无|无|none|null|n\/a)[。.!！]?$/i.test(normalized)) return true;
  if (PLACEHOLDER_SUMMARY_PATTERN.test(normalized)) return true;
  return /(当前没有可用逐字稿|音频已保存.*等待正式识别|无法根据.{0,10}逐字稿.{0,10}(?:总结|生成))/i.test(normalized);
}

export function applyMeetingResultQualityNotice(markdown: string, result: MeetingResult | null | undefined) {
  const quality = assessMeetingResultQuality(result);
  if (quality.status === "verified") return markdown;
  if (markdown.includes(quality.markdownNotice) || markdown.includes("质量提示：这份纪要尚未通过正式识别验收")) return markdown;

  if (markdown.trimStart().startsWith("---")) {
    const closingIndex = markdown.indexOf("\n---", 3);
    if (closingIndex >= 0) {
      const noticeStart = closingIndex + "\n---".length;
      return `${markdown.slice(0, noticeStart)}\n\n${quality.markdownNotice}\n\n${markdown.slice(noticeStart).trimStart()}`;
    }
  }

  return `${quality.markdownNotice}\n\n${markdown}`;
}

function buildQuality(status: MeetingResultQualityStatus, reasons: string[]): MeetingResultQuality {
  if (status === "verified") {
    return {
      status,
      publishLabel: "正式纪要",
      shareWarningTitle: "",
      shareWarningDetail: "",
      markdownNotice: "",
      reasons: [],
      canTreatAsFormal: true,
    };
  }

  return {
    status,
    publishLabel: "未验证纪要",
    shareWarningTitle: "质量提示",
    shareWarningDetail: "这份纪要尚未通过正式识别验收，可能包含兜底转写或本地保守纪要；请勿作为正式会议事实归档。",
    markdownNotice: "> 质量提示：这份纪要尚未通过正式识别验收，可能包含兜底转写或本地保守纪要；请勿作为正式会议事实归档。",
    reasons,
    canTreatAsFormal: false,
  };
}

function uniqueReasons(reasons: string[]) {
  return Array.from(new Set(reasons));
}
