const mebibyte = 1024 * 1024;
const multipartAllowanceBytes = mebibyte;

export class AudioUploadPolicyError extends Error {
  readonly code: string;
  readonly retryAfterSeconds?: number;
  readonly status: number;

  constructor(input: { code: string; message: string; retryAfterSeconds?: number; status: number }) {
    super(input.message);
    this.name = "AudioUploadPolicyError";
    this.code = input.code;
    this.retryAfterSeconds = input.retryAfterSeconds;
    this.status = input.status;
  }
}

export type AudioUploadPolicy = {
  fullRecordingMaxBytes: number;
  fullRecordingMaxDurationMs: number;
  fullRecordingMaxParallel: number;
  regularChunkMaxBytes: number;
};

type AdmissionState = { active: number };

const admissionStateKey = Symbol.for("ownminutes.full-audio-upload-admission");

export function getAudioUploadPolicy(): AudioUploadPolicy {
  return {
    fullRecordingMaxBytes: readBoundedInteger("OWNMINUTES_FULL_AUDIO_MAX_BYTES", 8 * mebibyte, 1024 * mebibyte, 256 * mebibyte),
    fullRecordingMaxDurationMs: readBoundedInteger("OWNMINUTES_FULL_AUDIO_MAX_DURATION_MS", 60_000, 12 * 60 * 60_000, 2 * 60 * 60_000),
    fullRecordingMaxParallel: readBoundedInteger("OWNMINUTES_FULL_AUDIO_MAX_PARALLEL", 1, 16, 2),
    regularChunkMaxBytes: readBoundedInteger("OWNMINUTES_AUDIO_CHUNK_MAX_BYTES", 64 * 1024, 64 * mebibyte, 16 * mebibyte),
  };
}

export function requestClaimsFullRecording(request: Request) {
  const url = new URL(request.url);
  return url.searchParams.get("fullRecording") === "1" || request.headers.get("x-ownminutes-full-recording") === "1";
}

export function validateAudioRequestContentLength(request: Request, policy = getAudioUploadPolicy()) {
  const rawLength = request.headers.get("content-length");
  if (!rawLength) return null;
  const contentLength = Number(rawLength);
  if (!Number.isFinite(contentLength) || contentLength < 0) {
    throw new AudioUploadPolicyError({ code: "INVALID_CONTENT_LENGTH", message: "音频上传长度无效，请重新上传。", status: 400 });
  }
  if (contentLength > policy.fullRecordingMaxBytes + multipartAllowanceBytes) {
    throw new AudioUploadPolicyError({
      code: "AUDIO_UPLOAD_TOO_LARGE",
      message: `录音文件超过 ${formatMebibytes(policy.fullRecordingMaxBytes)}MB 上限，本地录音仍已保留。`,
      status: 413,
    });
  }
  return contentLength;
}

export function getAudioUploadRequestMaxBytes(policy = getAudioUploadPolicy()) {
  return policy.fullRecordingMaxBytes + multipartAllowanceBytes;
}

export function shouldAcquireFullRecordingAdmission(input: {
  claimedFullRecording: boolean;
  contentLength: number | null;
  policy?: AudioUploadPolicy;
}) {
  const policy = input.policy ?? getAudioUploadPolicy();
  return (
    input.claimedFullRecording ||
    input.contentLength === null ||
    input.contentLength > policy.regularChunkMaxBytes + multipartAllowanceBytes
  );
}

export function acquireFullRecordingAdmission(policy = getAudioUploadPolicy()) {
  const state = getAdmissionState();
  if (state.active >= policy.fullRecordingMaxParallel) {
    throw new AudioUploadPolicyError({
      code: "AUDIO_UPLOAD_BUSY",
      message: "完整录音上传通道正忙，本地录音已保留，稍后会自动重试。",
      retryAfterSeconds: 15,
      status: 429,
    });
  }
  state.active += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    state.active = Math.max(0, state.active - 1);
  };
}

export function validateUploadedAudio(input: {
  fullRecording: boolean;
  mimeType: string;
  size: number;
  policy?: AudioUploadPolicy;
}) {
  const policy = input.policy ?? getAudioUploadPolicy();
  if (!Number.isFinite(input.size) || input.size <= 0) {
    throw new AudioUploadPolicyError({ code: "EMPTY_AUDIO_UPLOAD", message: "录音文件为空，请检查本地录音后重试。", status: 400 });
  }
  const normalizedMimeType = input.mimeType.split(";", 1)[0].trim().toLowerCase();
  if (!allowedAudioMimeTypes.has(normalizedMimeType)) {
    throw new AudioUploadPolicyError({ code: "UNSUPPORTED_AUDIO_TYPE", message: "录音格式不受支持，请保留本地文件并联系支持。", status: 415 });
  }
  const maxBytes = input.fullRecording ? policy.fullRecordingMaxBytes : policy.regularChunkMaxBytes;
  if (input.size > maxBytes) {
    throw new AudioUploadPolicyError({
      code: "AUDIO_UPLOAD_TOO_LARGE",
      message: input.fullRecording
        ? `录音文件超过 ${formatMebibytes(maxBytes)}MB 上限，本地录音仍已保留。`
        : `音频分片超过 ${formatMebibytes(maxBytes)}MB 上限。`,
      status: 413,
    });
  }
}

export function validateFullRecordingDuration(durationMs: number, policy = getAudioUploadPolicy()) {
  if (durationMs > policy.fullRecordingMaxDurationMs) {
    throw new AudioUploadPolicyError({
      code: "AUDIO_DURATION_TOO_LONG",
      message: `单场会议暂时支持最长 ${Math.round(policy.fullRecordingMaxDurationMs / 60_000)} 分钟，本地录音仍已保留。`,
      status: 413,
    });
  }
}

export function audioUploadPolicyErrorResponse(error: AudioUploadPolicyError) {
  return {
    body: { ok: false, code: error.code, error: error.message },
    headers: error.retryAfterSeconds ? { "Retry-After": String(error.retryAfterSeconds) } : undefined,
    status: error.status,
  };
}

function getAdmissionState(): AdmissionState {
  const registry = globalThis as typeof globalThis & { [admissionStateKey]?: AdmissionState };
  registry[admissionStateKey] ??= { active: 0 };
  return registry[admissionStateKey];
}

function readBoundedInteger(name: string, min: number, max: number, fallback: number) {
  const value = Number(process.env[name]);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function formatMebibytes(bytes: number) {
  return Math.round(bytes / mebibyte);
}

const allowedAudioMimeTypes = new Set([
  "audio/aac",
  "audio/caf",
  "audio/mp4",
  "audio/m4a",
  "audio/mpeg",
  "audio/mp3",
  "audio/ogg",
  "audio/opus",
  "audio/wav",
  "audio/webm",
  "audio/x-caf",
  "audio/x-m4a",
  "audio/x-wav",
]);
