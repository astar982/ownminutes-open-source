import crypto from "node:crypto";
import type { TranscriptSegment } from "@/lib/meeting";
import { normalizeAudioForVolcanoAsr } from "./audio-normalization.ts";

export type VolcanoAsrDiagnostic = {
  ready: boolean;
  missing: string[];
  present: Record<string, boolean>;
  notes: string[];
};

export type VolcanoFileTranscriptionResult = {
  provider: "volcano";
  adapter: "volcano-file-asr";
  transcript: TranscriptSegment[];
  text: string;
  raw: unknown;
  requestId: string;
  attempts: number;
  noSpeech: boolean;
  transcoded: boolean;
  providerSpeakerInfoPresent: boolean;
  providerSpeakerCount: number;
  providerUtteranceCount: number;
  mode: "flash" | "standard";
  resourceId: string;
  fallbackUsed: boolean;
  fallbackReason: VolcanoTurboFallbackReason | null;
};

export type VolcanoAsrStrategy = "single" | "standard_then_turbo";

export type VolcanoTurboFallbackReason =
  | "standard_submit_rate_limited"
  | "standard_submit_server_error"
  | "standard_submit_overloaded";

export type VolcanoTranscriptStructure = {
  utteranceCount: number;
  providerSpeakerInfoPresent: boolean;
  providerSpeakerIds: string[];
  providerSpeakerCount: number;
};

export type VolcanoAsrConfig = {
  apiKey?: string;
  appId?: string;
  token?: string;
  mode?: "flash" | "standard";
  recognizeUrl?: string;
  turboRecognizeUrl?: string;
  submitUrl?: string;
  queryUrl?: string;
  resourceId?: string;
  uid?: string;
  model?: string;
  vadSegmentDuration?: string;
  maxAttempts?: number;
  strategy?: VolcanoAsrStrategy;
  standardResourceId?: string;
  turboResourceId?: string;
  turboFallbackEnabled?: boolean;
  turboFallbackMaxAudioMinutes?: number;
};

type VolcanoSubmitResponse = {
  requestId: string;
  headers: Record<string, string | null>;
  body: unknown;
};

type VolcanoQueryResponse = {
  headers: Record<string, string | null>;
  body: unknown;
};

type VolcanoRecognitionRouteResult = VolcanoQueryResponse & {
  requestId: string;
  attempts?: number;
  mode: "flash" | "standard";
  resourceId: string;
  fallbackUsed: boolean;
  fallbackReason: VolcanoTurboFallbackReason | null;
};

export class VolcanoRequestRejectedError extends Error {
  readonly phase: "recognize" | "submit";
  readonly httpStatus: number;
  readonly statusCode: string | null;

  constructor(input: {
    phase: "recognize" | "submit";
    httpStatus: number;
    statusCode: string | null;
    message?: string;
  }) {
    super(
      input.message ??
        `Volcano ASR ${input.phase} was rejected: HTTP ${input.httpStatus}, status ${input.statusCode || "unknown"}`,
    );
    this.name = "VolcanoRequestRejectedError";
    this.phase = input.phase;
    this.httpStatus = input.httpStatus;
    this.statusCode = input.statusCode;
  }
}

export function isDefinitiveVolcanoNonAcceptance(error: unknown): error is VolcanoRequestRejectedError {
  return error instanceof VolcanoRequestRejectedError;
}

const defaultSubmitUrl = "https://openspeech.bytedance.com/api/v3/auc/bigmodel/submit";
const defaultQueryUrl = "https://openspeech.bytedance.com/api/v3/auc/bigmodel/query";
const defaultRecognizeUrl = "https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash";
const defaultStandardResourceId = "volc.seedasr.auc";
const defaultFlashResourceId = "volc.bigasr.auc_turbo";
const officialVolcanoRuntimeHost = "openspeech.bytedance.com";

export function resolveVolcanoRuntimeEndpoint(
  value: string,
  environment: Record<string, string | undefined> = process.env,
) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Volcano ASR runtime endpoint is invalid.");
  }
  if (url.username || url.password || url.hash) {
    throw new Error("Volcano ASR runtime endpoint contains unsupported credentials or fragments.");
  }

  const localFixture = ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
  if (
    localFixture &&
    environment.NODE_ENV !== "production" &&
    environment.OWNMINUTES_ALLOW_LOCAL_PROVIDER_ENDPOINTS === "1"
  ) {
    return url.toString();
  }

  if (url.protocol !== "https:" || url.hostname !== officialVolcanoRuntimeHost || url.port) {
    throw new Error(`Volcano ASR runtime endpoint must use https://${officialVolcanoRuntimeHost}.`);
  }
  return url.toString();
}

export function getVolcanoFileAsrDiagnostic(config?: VolcanoAsrConfig): VolcanoAsrDiagnostic {
  const primaryMode = resolvePrimaryMode(config);
  const primaryResourceId = resolvePrimaryResourceId(config);
  const present = {
    VOLCANO_ASR_API_KEY: Boolean(config?.apiKey || process.env.VOLCANO_ASR_API_KEY),
    VOLCANO_ASR_APP_ID: Boolean(getVolcanoAppKey(config)),
    VOLCANO_ASR_TOKEN: Boolean(getVolcanoAccessToken(config)),
    VOLCANO_ASR_SUBMIT_URL: Boolean(config?.submitUrl || process.env.VOLCANO_ASR_SUBMIT_URL || defaultSubmitUrl),
    VOLCANO_ASR_QUERY_URL: Boolean(config?.queryUrl || process.env.VOLCANO_ASR_QUERY_URL || defaultQueryUrl),
    VOLCANO_ASR_RECOGNIZE_URL: Boolean(config?.recognizeUrl || process.env.VOLCANO_ASR_RECOGNIZE_URL || defaultRecognizeUrl),
    VOLCANO_ASR_RESOURCE_ID: Boolean(primaryResourceId),
  };

  const hasApiKey = present.VOLCANO_ASR_API_KEY;
  const hasLegacyPair = present.VOLCANO_ASR_APP_ID && present.VOLCANO_ASR_TOKEN;
  const missing = hasApiKey || hasLegacyPair ? [] : ["VOLCANO_ASR_API_KEY or VOLCANO_ASR_APP_ID+VOLCANO_ASR_TOKEN"];

  return {
    ready: missing.length === 0,
    missing,
    present,
    notes: [
      `Post-meeting Volcano file ASR uses ${resolveStrategy(config)} strategy with ${primaryMode} as its primary mode and either VOLCANO_ASR_API_KEY or the speech product runtime AppID/AppKey and Token/AccessKey.`,
      "Cloud account AK/SK alone normally cannot call the speech recognition runtime API.",
      "Audio is always saved locally before this adapter is called.",
    ],
  };
}

export async function transcribeWithVolcanoFileAsr(input: {
  meetingId: string;
  audioUrl?: string;
  buffer?: Buffer;
  mimeType: string;
  fileName: string;
  durationMs: number;
  transcoded?: boolean;
  config?: VolcanoAsrConfig;
  beforeProviderRequest?: () => Promise<void>;
}) {
  const diagnostic = getVolcanoFileAsrDiagnostic(input.config);

  if (!diagnostic.ready) {
    throw new Error(`Volcano file ASR config is incomplete. Missing: ${diagnostic.missing.join(", ")}`);
  }

  assertVolcanoAudioSource(input);
  const normalized = input.audioUrl
    ? { audioUrl: input.audioUrl, fileName: input.fileName, mimeType: input.mimeType, transcoded: input.transcoded === true }
    : await normalizeAudioForVolcanoAsr({ buffer: input.buffer!, fileName: input.fileName, mimeType: input.mimeType });
  validateConfiguredStrategyBeforeDispatch(input.config, input.durationMs);
  let providerRequestStarted = false;
  const beforeProviderRequest = async () => {
    if (providerRequestStarted) return;
    await input.beforeProviderRequest?.();
    providerRequestStarted = true;
  };
  const normalizedInput = { ...input, ...normalized, beforeProviderRequest };
  const result = await recognizeWithConfiguredStrategy(normalizedInput);
  const noSpeech = result.headers["x-api-status-code"] === "20000003";
  const transcript = noSpeech ? [] : normalizeVolcanoTranscript(result.body);
  const text = transcript.map((segment) => segment.text).join("\n").trim();
  const structure = inspectVolcanoTranscriptStructure(result.body);

  return {
    provider: "volcano",
    adapter: "volcano-file-asr",
    transcript,
    text,
    raw: result.body,
    requestId: result.requestId,
    attempts: result.attempts ?? 1,
    noSpeech,
    transcoded: normalized.transcoded,
    providerSpeakerInfoPresent: structure.providerSpeakerInfoPresent,
    providerSpeakerCount: structure.providerSpeakerCount,
    providerUtteranceCount: structure.utteranceCount,
    mode: result.mode,
    resourceId: result.resourceId,
    fallbackUsed: result.fallbackUsed,
    fallbackReason: result.fallbackReason,
  } satisfies VolcanoFileTranscriptionResult;
}

export async function probeVolcanoFileAsrSubmit(input: {
  meetingId: string;
  audioUrl?: string;
  buffer?: Buffer;
  mimeType: string;
  fileName: string;
  durationMs: number;
  transcoded?: boolean;
  config?: VolcanoAsrConfig;
}) {
  const diagnostic = getVolcanoFileAsrDiagnostic(input.config);

  if (!diagnostic.ready) {
    throw new Error(`Volcano file ASR config is incomplete. Missing: ${diagnostic.missing.join(", ")}`);
  }

  assertVolcanoAudioSource(input);

  const mode = resolvePrimaryMode(input.config);
  const resourceId = resolvePrimaryResourceId(input.config);
  const routeConfig = { ...input.config, mode, resourceId } satisfies VolcanoAsrConfig;
  const submitted =
    mode === "flash" ? await recognizeAudio({ ...input, config: routeConfig }) : await submitAudio({ ...input, config: routeConfig });
  return {
    ok: true,
    requestId: submitted.requestId,
    statusCode: submitted.headers["x-api-status-code"],
    message: submitted.headers["x-api-message"],
    mode,
    resourceId,
    fallbackUsed: false,
    fallbackReason: null,
  };
}

async function recognizeWithConfiguredStrategy(input: {
  meetingId: string;
  audioUrl?: string;
  buffer?: Buffer;
  mimeType: string;
  fileName: string;
  durationMs: number;
  transcoded?: boolean;
  config?: VolcanoAsrConfig;
  beforeProviderRequest?: () => Promise<void>;
}): Promise<VolcanoRecognitionRouteResult> {
  if (resolveStrategy(input.config) === "single") {
    const mode = resolveMode(input.config);
    const resourceId = resolveResourceId(input.config);
    const routeConfig = { ...input.config, mode, resourceId } satisfies VolcanoAsrConfig;
    const result =
      mode === "flash"
        ? await recognizeAudio({ ...input, config: routeConfig })
        : await recognizeStandardAudio({ ...input, config: routeConfig });
    return { ...result, mode, resourceId, fallbackUsed: false, fallbackReason: null };
  }

  const standardResourceId = resolveStandardResourceId(input.config);
  const standardConfig = {
    ...input.config,
    mode: "standard",
    resourceId: standardResourceId,
  } satisfies VolcanoAsrConfig;

  try {
    const result = await recognizeStandardAudio({ ...input, config: standardConfig });
    return {
      ...result,
      mode: "standard",
      resourceId: standardResourceId,
      fallbackUsed: false,
      fallbackReason: null,
    };
  } catch (error) {
    const fallbackReason = classifyTurboFallbackReason(error);
    if (
      !fallbackReason ||
      !isTurboFallbackEnabled(input.config) ||
      !isWithinTurboFallbackDurationCap(input.durationMs, input.config)
    ) {
      throw error;
    }

    const turboResourceId = resolveTurboResourceId(input.config);
    const turboConfig = {
      ...input.config,
      mode: "flash",
      resourceId: turboResourceId,
      recognizeUrl: resolveTurboRecognizeUrl(input.config),
      maxAttempts: 1,
    } satisfies VolcanoAsrConfig;
    const result = await recognizeAudio({ ...input, config: turboConfig });
    return {
      ...result,
      mode: "flash",
      resourceId: turboResourceId,
      fallbackUsed: true,
      fallbackReason,
    };
  }
}

async function recognizeStandardAudio(input: {
  meetingId: string;
  audioUrl?: string;
  buffer?: Buffer;
  mimeType: string;
  fileName: string;
  durationMs: number;
  transcoded?: boolean;
  config?: VolcanoAsrConfig;
  beforeProviderRequest?: () => Promise<void>;
}) {
  const submitted = await submitAudio(input);
  const queried = await pollAudioResult(submitted.requestId, input.config);
  return { ...queried, requestId: submitted.requestId };
}

async function recognizeAudio(input: {
  meetingId: string;
  audioUrl?: string;
  buffer?: Buffer;
  mimeType: string;
  fileName: string;
  durationMs: number;
  transcoded?: boolean;
  config?: VolcanoAsrConfig;
  beforeProviderRequest?: () => Promise<void>;
}) {
  const maxAttempts = flashRecognitionMaxAttempts(input.config);
  let lastResponse: { httpStatus: number; statusCode: string | null } | null = null;
  let attemptsUsed = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    attemptsUsed = attempt;
    const requestId = `${input.meetingId}-${crypto.randomUUID()}`;
    const recognizeUrl = resolveVolcanoRuntimeEndpoint(
      input.config?.recognizeUrl || process.env.VOLCANO_ASR_RECOGNIZE_URL || defaultRecognizeUrl,
    );
    const requestInit = {
      method: "POST",
      headers: buildVolcanoHeaders(requestId, "-1", input.config),
      body: JSON.stringify(buildRecognitionRequest(input)),
    };
    await input.beforeProviderRequest?.();
    const response = await fetch(
      recognizeUrl,
      requestInit,
    );
    const body = await readJsonBody(response);
    const headers = readVolcanoResponseHeaders(response);
    const statusCode = headers["x-api-status-code"];
    const acceptedStatus = statusCode === "20000000" || statusCode === "20000003";
    if (response.ok && acceptedStatus) {
      return { requestId, headers, body, attempts: attempt };
    }

    lastResponse = { httpStatus: response.status, statusCode };
    if (!isRetryableVolcanoFlashResponse(lastResponse) || attempt === maxAttempts) break;
    await wait(volcanoFlashRetryDelayMs(attempt));
  }

  const attempts = attemptsUsed;
  const statusCode = lastResponse?.statusCode || "unknown";
  if (lastResponse && isDefinitiveVolcanoRejectionResponse(lastResponse)) {
    throw new VolcanoRequestRejectedError({
      phase: "recognize",
      httpStatus: lastResponse.httpStatus,
      statusCode: lastResponse.statusCode,
      message:
        statusCode === "45000000"
          ? `火山会后识别暂时不可用（状态 45000000，已重试 ${attempts} 次）。可能是并发/额度限制或资源授权问题；本地音频已保留，可稍后重新生成纪要。`
          : `Volcano ASR flash recognition failed after ${attempts} attempt(s): HTTP ${lastResponse.httpStatus}, status ${statusCode}`,
    });
  }
  throw new Error(
    `Volcano ASR flash recognition returned an ambiguous response after ${attempts} attempt(s): HTTP ${lastResponse?.httpStatus ?? "unknown"}, status ${statusCode}. Provider acceptance could not be determined.`,
  );
}

export function isRetryableVolcanoFlashResponse(input: { httpStatus: number; statusCode: string | null }) {
  return input.httpStatus === 429 || input.httpStatus >= 500 || input.statusCode === "45000000";
}

export function isDefinitiveVolcanoRejectionResponse(input: { httpStatus: number; statusCode: string | null }) {
  if (input.httpStatus < 200 || input.httpStatus >= 300) return true;
  return typeof input.statusCode === "string" && /^[45]\d{7}$/.test(input.statusCode);
}

export function volcanoFlashRetryDelayMs(attempt: number, baseMs = flashRecognitionRetryBaseMs()) {
  const boundedAttempt = Math.max(1, Math.min(4, Math.round(attempt)));
  return Math.min(5000, Math.max(100, baseMs) * 2 ** (boundedAttempt - 1));
}

function flashRecognitionMaxAttempts(config?: VolcanoAsrConfig) {
  const parsed = Number(config?.maxAttempts ?? process.env.VOLCANO_ASR_FLASH_ATTEMPTS ?? 3);
  return Number.isFinite(parsed) ? Math.min(5, Math.max(1, Math.round(parsed))) : 3;
}

function flashRecognitionRetryBaseMs() {
  const parsed = Number(process.env.VOLCANO_ASR_FLASH_RETRY_MS || 750);
  return Number.isFinite(parsed) ? Math.min(5000, Math.max(100, Math.round(parsed))) : 750;
}

async function submitAudio(input: {
  meetingId: string;
  audioUrl?: string;
  buffer?: Buffer;
  mimeType: string;
  fileName: string;
  durationMs: number;
  transcoded?: boolean;
  config?: VolcanoAsrConfig;
  beforeProviderRequest?: () => Promise<void>;
}): Promise<VolcanoSubmitResponse> {
  const requestId = `${input.meetingId}-${crypto.randomUUID()}`;
  const config = input.config;
  const submitUrl = resolveVolcanoRuntimeEndpoint(config?.submitUrl || process.env.VOLCANO_ASR_SUBMIT_URL || defaultSubmitUrl);
  const requestInit = {
    method: "POST",
    headers: buildVolcanoHeaders(requestId, "-1", config),
    body: JSON.stringify(buildRecognitionRequest(input)),
  };
  await input.beforeProviderRequest?.();
  const response = await fetch(submitUrl, requestInit);

  const body = await readJsonBody(response);
  const headers = readVolcanoResponseHeaders(response);
  const statusCode = headers["x-api-status-code"];

  if (!response.ok || statusCode !== "20000000") {
    if (isDefinitiveVolcanoRejectionResponse({ httpStatus: response.status, statusCode })) {
      throw new VolcanoRequestRejectedError({ phase: "submit", httpStatus: response.status, statusCode });
    }
    throw new Error(
      `Volcano ASR submit returned an ambiguous response: HTTP ${response.status}, status ${statusCode || "unknown"}. Provider acceptance could not be determined.`,
    );
  }

  return { requestId, headers, body };
}

async function pollAudioResult(requestId: string, config?: VolcanoAsrConfig): Promise<VolcanoQueryResponse> {
  const maxAttempts = Number(process.env.VOLCANO_ASR_QUERY_ATTEMPTS || 40);
  const intervalMs = Number(process.env.VOLCANO_ASR_QUERY_INTERVAL_MS || 3000);

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const queryUrl = resolveVolcanoRuntimeEndpoint(config?.queryUrl || process.env.VOLCANO_ASR_QUERY_URL || defaultQueryUrl);
    const response = await fetch(queryUrl, {
      method: "POST",
      headers: buildVolcanoHeaders(requestId, String(attempt), config),
      body: "{}",
    });

    const body = await readJsonBody(response);
    const headers = readVolcanoResponseHeaders(response);
    const statusCode = headers["x-api-status-code"];

    if (!response.ok) {
      throw new Error(`Volcano ASR query failed: HTTP ${response.status}, status ${statusCode || "unknown"}`);
    }

    if (statusCode && isCompleteStatus(statusCode)) {
      return { headers, body };
    }

    if (statusCode && !isPendingStatus(statusCode)) {
      throw new Error(`Volcano ASR query returned terminal status ${statusCode}`);
    }

    await wait(intervalMs);
  }

  throw new Error("Volcano ASR query timed out before the transcript was ready.");
}

function buildVolcanoHeaders(requestId: string, sequence: string, config?: VolcanoAsrConfig) {
  const sharedHeaders = {
    "Content-Type": "application/json",
    "X-Api-Resource-Id": resolveResourceId(config),
    "X-Api-Request-Id": requestId,
    "X-Api-Sequence": sequence,
  };

  const apiKey = config?.apiKey || process.env.VOLCANO_ASR_API_KEY;
  if (apiKey) {
    return {
      ...sharedHeaders,
      "X-Api-Key": apiKey,
    };
  }

  return {
    ...sharedHeaders,
    "X-Api-App-Key": getVolcanoAppKey(config),
    "X-Api-Access-Key": getVolcanoAccessToken(config),
  };
}

function buildRecognitionRequest(input: {
  audioUrl?: string;
  buffer?: Buffer;
  mimeType: string;
  fileName: string;
  config?: VolcanoAsrConfig;
}) {
  const config = input.config;
  assertVolcanoAudioSource(input);
  return {
    user: {
      uid: config?.uid || process.env.VOLCANO_ASR_UID || "ownminutes",
    },
    audio: input.audioUrl
      ? { url: input.audioUrl, format: inferAudioFormat(input.mimeType, input.fileName) }
      : { data: input.buffer!.toString("base64"), format: inferAudioFormat(input.mimeType, input.fileName) },
    request: {
      model_name: config?.model || process.env.VOLCANO_ASR_MODEL || "bigmodel",
      enable_itn: true,
      enable_punc: true,
      enable_ddc: true,
      show_utterances: true,
      enable_speaker_info: true,
      ssd_version: "200",
      result_type: "full",
      vad_segment_duration: Number(config?.vadSegmentDuration || process.env.VOLCANO_ASR_VAD_SEGMENT_DURATION || 3000),
    },
  };
}

function assertVolcanoAudioSource(input: { audioUrl?: string; buffer?: Buffer }) {
  if (Boolean(input.audioUrl) === Boolean(input.buffer)) {
    throw new Error("Volcano file ASR requires exactly one audio URL or audio buffer.");
  }
  if (!input.audioUrl) return;
  const url = new URL(input.audioUrl);
  const localHttp = url.protocol === "http:" && ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
  if (url.protocol !== "https:" && !localHttp) throw new Error("Volcano ASR audio URL must use HTTPS.");
  if (url.username || url.password || url.hash) throw new Error("Volcano ASR audio URL contains unsupported credentials or fragments.");
}

function resolveMode(config?: VolcanoAsrConfig) {
  const configured = config?.mode || process.env.VOLCANO_ASR_MODE;
  return configured === "standard" ? "standard" : "flash";
}

function resolveStrategy(config?: VolcanoAsrConfig): VolcanoAsrStrategy {
  const configured = config?.strategy || process.env.OWNMINUTES_ASR_FILE_STRATEGY;
  return configured === "standard_then_turbo" ? "standard_then_turbo" : "single";
}

function resolvePrimaryMode(config?: VolcanoAsrConfig) {
  return resolveStrategy(config) === "standard_then_turbo" ? "standard" : resolveMode(config);
}

function resolvePrimaryResourceId(config?: VolcanoAsrConfig) {
  return resolveStrategy(config) === "standard_then_turbo" ? resolveStandardResourceId(config) : resolveResourceId(config);
}

function resolveResourceId(config?: VolcanoAsrConfig) {
  return config?.resourceId || process.env.VOLCANO_ASR_RESOURCE_ID || (resolveMode(config) === "flash" ? defaultFlashResourceId : defaultStandardResourceId);
}

function isTurboResourceId(resourceId: string, config?: VolcanoAsrConfig) {
  const normalized = resourceId.trim().toLowerCase();
  const configuredTurboResourceId = (
    config?.turboResourceId ||
    process.env.VOLCANO_ASR_TURBO_RESOURCE_ID ||
    defaultFlashResourceId
  )
    .trim()
    .toLowerCase();
  return normalized.includes("turbo") || Boolean(configuredTurboResourceId && normalized === configuredTurboResourceId);
}

function resolveStandardResourceId(config?: VolcanoAsrConfig) {
  const resourceId = (
    config?.standardResourceId || config?.resourceId || process.env.VOLCANO_ASR_RESOURCE_ID || defaultStandardResourceId
  ).trim();
  const turboResourceId = resolveTurboResourceId(config);
  if (!resourceId || isTurboResourceId(resourceId, config) || resourceId.toLowerCase() === turboResourceId.toLowerCase()) {
    throw new Error(
      `Volcano ASR standard_then_turbo primary resource must not use Turbo resource ${resourceId}; refusing an unbounded-cost route.`,
    );
  }
  return resourceId;
}

function resolveTurboResourceId(config?: VolcanoAsrConfig) {
  const resourceId = (config?.turboResourceId || process.env.VOLCANO_ASR_TURBO_RESOURCE_ID || defaultFlashResourceId).trim();
  if (!resourceId || !resourceId.toLowerCase().includes("turbo")) {
    throw new Error("Volcano ASR Turbo fallback resource must be an explicit Turbo resource.");
  }
  return resourceId;
}

function resolveTurboRecognizeUrl(config?: VolcanoAsrConfig) {
  return config?.turboRecognizeUrl || process.env.VOLCANO_ASR_TURBO_RECOGNIZE_URL || defaultRecognizeUrl;
}

function isTurboFallbackEnabled(config?: VolcanoAsrConfig) {
  if (typeof config?.turboFallbackEnabled === "boolean") return config.turboFallbackEnabled;
  return process.env.OWNMINUTES_ASR_TURBO_FALLBACK_ENABLED?.trim() === "1";
}

function isWithinTurboFallbackDurationCap(durationMs: number, config?: VolcanoAsrConfig) {
  const configuredMinutes = Number(
    config?.turboFallbackMaxAudioMinutes ?? process.env.OWNMINUTES_ASR_TURBO_FALLBACK_MAX_AUDIO_MINUTES ?? 30,
  );
  if (!Number.isInteger(configuredMinutes) || configuredMinutes < 1 || configuredMinutes > 30) return false;
  return Number.isFinite(durationMs) && durationMs > 0 && durationMs <= configuredMinutes * 60_000;
}

function validateConfiguredStrategyBeforeDispatch(config: VolcanoAsrConfig | undefined, durationMs: number) {
  if (resolveStrategy(config) === "single") {
    const mode = resolveMode(config);
    const resourceId = resolveResourceId(config);
    if (mode === "flash") {
      resolveVolcanoRuntimeEndpoint(config?.recognizeUrl || process.env.VOLCANO_ASR_RECOGNIZE_URL || defaultRecognizeUrl);
      return;
    }
    if (isTurboResourceId(resourceId, config)) {
      throw new Error(
        `Volcano ASR standard mode must not use Turbo resource ${resourceId}; refusing a cost-cap bypass.`,
      );
    }
    resolveVolcanoRuntimeEndpoint(config?.submitUrl || process.env.VOLCANO_ASR_SUBMIT_URL || defaultSubmitUrl);
    resolveVolcanoRuntimeEndpoint(config?.queryUrl || process.env.VOLCANO_ASR_QUERY_URL || defaultQueryUrl);
    return;
  }

  resolveStandardResourceId(config);
  resolveVolcanoRuntimeEndpoint(config?.submitUrl || process.env.VOLCANO_ASR_SUBMIT_URL || defaultSubmitUrl);
  resolveVolcanoRuntimeEndpoint(config?.queryUrl || process.env.VOLCANO_ASR_QUERY_URL || defaultQueryUrl);
  if (isTurboFallbackEnabled(config) && isWithinTurboFallbackDurationCap(durationMs, config)) {
    resolveTurboResourceId(config);
    resolveVolcanoRuntimeEndpoint(resolveTurboRecognizeUrl(config));
  }
}

function classifyTurboFallbackReason(error: unknown): VolcanoTurboFallbackReason | null {
  if (!(error instanceof VolcanoRequestRejectedError) || error.phase !== "submit") return null;

  // These statuses represent authorization/configuration failures, not capacity pressure.
  if (error.httpStatus === 403 || error.statusCode === "45000030") return null;
  if (error.httpStatus === 429) return "standard_submit_rate_limited";
  if (error.httpStatus >= 500 && error.httpStatus <= 599) return "standard_submit_server_error";
  if (error.statusCode === "45000000") return "standard_submit_overloaded";
  return null;
}

function getVolcanoAppKey(config?: VolcanoAsrConfig) {
  return config?.appId || process.env.VOLCANO_ASR_APP_ID || process.env.VOLCANO_ASR_APP_KEY || process.env.VOLCANO_APP_ID || "";
}

function getVolcanoAccessToken(config?: VolcanoAsrConfig) {
  return config?.token || process.env.VOLCANO_ASR_TOKEN || process.env.VOLCANO_ASR_ACCESS_KEY || "";
}

function inferAudioFormat(mimeType: string, fileName: string) {
  const normalized = `${mimeType} ${fileName}`.toLowerCase();

  if (normalized.includes("wav")) return "wav";
  if (normalized.includes("webm")) return "webm";
  if (normalized.includes("mpeg") || normalized.includes(".mp3")) return "mp3";
  if (normalized.includes("mp4") || normalized.includes("m4a") || normalized.includes("aac")) return "m4a";
  if (normalized.includes("ogg") || normalized.includes("opus")) return "ogg";

  return "m4a";
}

function readVolcanoResponseHeaders(response: Response) {
  return {
    "x-api-status-code": response.headers.get("x-api-status-code"),
    "x-api-message": response.headers.get("x-api-message"),
    "x-api-request-id": response.headers.get("x-api-request-id"),
  };
}

async function readJsonBody(response: Response) {
  const text = await response.text();

  if (!text) return null;

  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { text };
  }
}

export function normalizeVolcanoTranscript(raw: unknown): TranscriptSegment[] {
  const root = asRecord(raw);
  const result = asOptionalRecord(root.result) ?? root;
  const utterances = findArray(root, ["utterances", "utterance", "segments", "sentences", "utterance_list"]);

  if (utterances.length > 0) {
    const rawSpeakers = utterances.map((item) => readSpeaker(asRecord(item)));
    const shiftZeroBasedSpeakerIds = rawSpeakers.some((speaker) => speaker === "0");

    return utterances.map((item, index) => {
      const row = asRecord(item) ?? {};
      const startMs = readStartMs(row);
      const speaker = normalizeSpeakerLabel(rawSpeakers[index], index, shiftZeroBasedSpeakerIds);
      const text = readText(row);

      return {
        id: `final-${index + 1}`,
        speaker,
        timestamp: formatMs(startMs),
        text: text || "该发言段没有返回可解析文本。",
      };
    });
  }

  const text = readText(result) || readText(root) || (typeof root.result === "string" ? root.result.trim() : "");

  return [
    {
      id: "final-1",
      speaker: "Speaker 1",
      timestamp: "00:00",
      text: text || "火山识别已完成，但返回结果中没有可解析的逐字稿文本。",
    },
  ];
}

export function inspectVolcanoTranscriptStructure(raw: unknown): VolcanoTranscriptStructure {
  const root = asRecord(raw);
  const utterances = findArray(root, ["utterances", "utterance", "segments", "sentences", "utterance_list"]);
  const providerSpeakerIds = [
    ...new Set(
      utterances
        .map((item) => readSpeaker(asRecord(item)))
        .filter((speaker): speaker is string => Boolean(speaker)),
    ),
  ].sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));

  return {
    utteranceCount: utterances.length,
    providerSpeakerInfoPresent: providerSpeakerIds.length > 0,
    providerSpeakerIds,
    providerSpeakerCount: providerSpeakerIds.length,
  };
}

function findArray(input: Record<string, unknown>, keys: string[]): unknown[] {
  for (const key of keys) {
    if (Array.isArray(input[key])) return input[key];
  }

  for (const value of Object.values(input)) {
    if (value && typeof value === "object") {
      const nested = findArray(value as Record<string, unknown>, keys);
      if (nested.length > 0) return nested;
    }
  }

  return [];
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  return {};
}

function asOptionalRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
  return null;
}

function readSpeaker(row: Record<string, unknown>) {
  const additions = asOptionalRecord(row.additions) ?? {};
  const value =
    row.speaker ??
    row.spk ??
    row.spk_id ??
    row.speaker_id ??
    row.speakerId ??
    row.speakerID ??
    row.user_id ??
    row.userId ??
    additions.speaker ??
    additions.speaker_id ??
    additions.spk_id ??
    additions.channel_id;

  return value === undefined || value === null || value === "" ? null : String(value).trim();
}

function normalizeSpeakerLabel(raw: string | null, _index: number, shiftZeroBasedSpeakerIds: boolean) {
  if (!raw) return "Speaker 1";
  if (/^speaker\s+/i.test(raw)) return raw.replace(/^speaker/i, "Speaker").trim();

  const numeric = Number(raw);
  if (Number.isFinite(numeric)) {
    return `Speaker ${shiftZeroBasedSpeakerIds ? numeric + 1 : numeric}`;
  }

  return `Speaker ${raw}`;
}

function readText(row: Record<string, unknown>): string {
  const direct = row.text ?? row.result ?? row.transcript ?? row.sentence ?? row.content ?? row.utterance;
  if (typeof direct === "string" && direct.trim()) return direct.trim();

  const nestedResult = asOptionalRecord(row.result);
  if (nestedResult) {
    const nestedText: string = readText(nestedResult);
    if (nestedText) return nestedText;
  }

  const wordList = findArray(row, ["words", "word_list", "wordList"]);
  if (wordList.length > 0) {
    return wordList
      .map((word) => {
        const item = asRecord(word);
        return String(item.text ?? item.word ?? item.result ?? item.content ?? "").trim();
      })
      .filter(Boolean)
      .join("");
  }

  return "";
}

function readStartMs(row: Record<string, unknown>) {
  const msValue =
    row.start_time ??
    row.startTime ??
    row.start_ms ??
    row.startMs ??
    row.begin_time ??
    row.beginTime ??
    row.begin_ms ??
    row.beginMs;
  const secondsValue = row.start_sec ?? row.startSec ?? row.begin_sec ?? row.beginSec;

  if (msValue !== undefined) return toNumber(msValue);
  if (secondsValue !== undefined) return toNumber(secondsValue) * 1000;

  return toNumber(row.start ?? row.begin ?? row.offset ?? 0);
}

function toNumber(value: unknown) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
}

function formatMs(ms: number) {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function isCompleteStatus(statusCode: string) {
  return statusCode === "20000000" || statusCode === "20000003";
}

function isPendingStatus(statusCode: string) {
  return statusCode === "20000001" || statusCode === "20000002";
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
