export const recordingStorageMiB = 1024 * 1024;
export const recordingStoragePcmBytesPerSecond = 16000 * 1 * 2;
export const recordingStorageTargetMaximumSeconds = 120 * 60;
export const recordingStorageEstimatedMaximumBytes = recordingStoragePcmBytesPerSecond * recordingStorageTargetMaximumSeconds;
export const recordingDurationMaximumMs = recordingStorageTargetMaximumSeconds * 1000;
export const recordingDurationWarningLeadMs = 10 * 60 * 1000;
export const recordingStorageStartMinimumBytes = 512 * recordingStorageMiB;
export const recordingStorageWarningBytes = 1024 * recordingStorageMiB;
export const recordingStorageEmergencyStopBytes = 128 * recordingStorageMiB;

export type RecordingStoragePhase = "preflight" | "recording";
export type RecordingStorageStatus = "unknown" | "ready" | "warning" | "blocked" | "critical" | "unavailable";

export type RecordingStorageHealth = {
  canStart: boolean;
  checkedAt: number;
  freeBytes: number | null;
  shouldStop: boolean;
  status: RecordingStorageStatus;
};

export type RecordingDurationLimit = {
  elapsedMs: number;
  remainingMs: number;
  shouldStop: boolean;
  shouldWarn: boolean;
};

export type NativeRecordingCompletionDisposition =
  | "duration-limit"
  | "ignore"
  | "media-services-reset"
  | "native-error";

export function classifyNativeRecordingCompletion(input: {
  armed: boolean;
  durationMs: number;
  hasError: boolean;
  isFinished: boolean;
  mediaServicesDidReset?: boolean;
  stopInFlight: boolean;
}): NativeRecordingCompletionDisposition {
  if (!input.isFinished || !input.armed || input.stopInFlight) return "ignore";
  // expo-audio re-prepares AVAudioRecorder after an iOS media-services reset
  // before emitting the completion event. Its new URI points at a fresh file,
  // not at the interrupted recording. Keep this path distinct so callers never
  // replace the durable recovery index with the freshly prepared empty file.
  if (input.mediaServicesDidReset) return "media-services-reset";
  if (input.hasError) return "native-error";
  // iOS can finish AVAudioRecorder early after an audio-route or system
  // interruption without setting hasError. Only treat a completion as the
  // intentional two-hour deadline when the recorded media is actually close
  // to that limit; every earlier finish needs the interruption recovery path.
  const durationMs = Number.isFinite(input.durationMs) ? Math.max(0, input.durationMs) : 0;
  return durationMs >= recordingDurationMaximumMs - 2_000 ? "duration-limit" : "native-error";
}

export function assessRecordingDurationLimit(elapsedMsInput: number): RecordingDurationLimit {
  const elapsedMs = Number.isFinite(elapsedMsInput) ? Math.max(0, Math.floor(elapsedMsInput)) : 0;
  const remainingMs = Math.max(0, recordingDurationMaximumMs - elapsedMs);
  const shouldStop = elapsedMs >= recordingDurationMaximumMs;

  return {
    elapsedMs,
    remainingMs,
    shouldStop,
    shouldWarn: shouldStop || remainingMs <= recordingDurationWarningLeadMs,
  };
}

export function remainingRecordingDurationSeconds(elapsedMsInput: number): number {
  return Math.ceil(assessRecordingDurationLimit(elapsedMsInput).remainingMs / 1000);
}

export function createUnknownRecordingStorageHealth(now = 0): RecordingStorageHealth {
  return {
    canStart: true,
    checkedAt: now,
    freeBytes: null,
    shouldStop: false,
    status: "unknown",
  };
}

export function unavailableRecordingStorageHealth(now = Date.now()): RecordingStorageHealth {
  return {
    canStart: true,
    checkedAt: now,
    freeBytes: null,
    shouldStop: false,
    status: "unavailable",
  };
}

export function assessRecordingStorageHealth(
  freeBytesInput: number,
  phase: RecordingStoragePhase,
  now = Date.now(),
): RecordingStorageHealth {
  const freeBytes = Number.isFinite(freeBytesInput) ? Math.max(0, Math.floor(freeBytesInput)) : 0;

  if (phase === "preflight" && freeBytes < recordingStorageStartMinimumBytes) {
    return {
      canStart: false,
      checkedAt: now,
      freeBytes,
      shouldStop: false,
      status: "blocked",
    };
  }

  if (phase === "recording" && freeBytes < recordingStorageEmergencyStopBytes) {
    return {
      canStart: true,
      checkedAt: now,
      freeBytes,
      shouldStop: true,
      status: "critical",
    };
  }

  if (freeBytes < recordingStorageWarningBytes) {
    return {
      canStart: true,
      checkedAt: now,
      freeBytes,
      shouldStop: false,
      status: "warning",
    };
  }

  return {
    canStart: true,
    checkedAt: now,
    freeBytes,
    shouldStop: false,
    status: "ready",
  };
}
