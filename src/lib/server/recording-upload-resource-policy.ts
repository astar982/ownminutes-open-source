import { getAudioUploadPolicy } from "./audio-upload-policy.ts";

const mebibyte = 1024 * 1024;
const hourMs = 60 * 60 * 1000;

export type RecordingUploadResourcePolicy = {
  maxActiveUploadsPerUser: number;
  maxStagedBytesPerUser: number;
  staleAfterMs: number;
};

export type RecordingUploadResourceViolation = "active-upload-limit" | "staged-bytes-limit" | null;

export const defaultRecordingUploadMaxActivePerUser = 4;
export const defaultRecordingUploadMaxStagedBytesPerUser = 256 * mebibyte;
export const defaultRecordingUploadStaleHours = 72;

export function getRecordingUploadResourcePolicy(): RecordingUploadResourcePolicy {
  const minimumStagedBytes = getAudioUploadPolicy().fullRecordingMaxBytes;
  return {
    maxActiveUploadsPerUser: integerEnv(
      "OWNMINUTES_RECORDING_UPLOAD_MAX_ACTIVE_PER_USER",
      defaultRecordingUploadMaxActivePerUser,
      1,
      20,
    ),
    maxStagedBytesPerUser: integerEnv(
      "OWNMINUTES_RECORDING_UPLOAD_MAX_STAGED_BYTES_PER_USER",
      Math.max(defaultRecordingUploadMaxStagedBytesPerUser, minimumStagedBytes),
      minimumStagedBytes,
      2 * 1024 * mebibyte,
    ),
    staleAfterMs:
      integerEnv("OWNMINUTES_RECORDING_UPLOAD_STALE_HOURS", defaultRecordingUploadStaleHours, 1, 30 * 24) * hourMs,
  };
}

export function isRecordingUploadStale(updatedAt: string, policy = getRecordingUploadResourcePolicy(), nowMs = Date.now()) {
  const updatedAtMs = Date.parse(updatedAt);
  return !Number.isFinite(updatedAtMs) || nowMs - updatedAtMs >= policy.staleAfterMs;
}

export function recordingUploadResourceViolation(
  usage: { activeUploads: number; stagedBytes: number },
  policy = getRecordingUploadResourcePolicy(),
): RecordingUploadResourceViolation {
  if (usage.activeUploads > policy.maxActiveUploadsPerUser) return "active-upload-limit";
  if (usage.stagedBytes > policy.maxStagedBytesPerUser) return "staged-bytes-limit";
  return null;
}

function integerEnv(name: string, fallback: number, minimum: number, maximum: number) {
  const raw = String(process.env[name] || "").trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) return fallback;
  return parsed;
}
