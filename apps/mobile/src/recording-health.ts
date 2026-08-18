export type RecordingFileHealthStatus = "idle" | "waiting" | "healthy" | "paused" | "stalled" | "missing";

export type RecordingFileHealth = {
  bytes: number;
  lastCheckedAt: number;
  lastGrowthAt: number;
  status: RecordingFileHealthStatus;
};

export const recordingFileStallThresholdMs = 15_000;

export function createRecordingFileHealth(now = Date.now(), bytes = 0): RecordingFileHealth {
  return {
    bytes: Math.max(0, bytes),
    lastCheckedAt: now,
    lastGrowthAt: now,
    status: "waiting",
  };
}

export function assessRecordingFileHealth(
  previous: RecordingFileHealth,
  sample: {
    durationMs: number;
    exists: boolean;
    now: number;
    recording: boolean;
    size: number;
  },
): RecordingFileHealth {
  const bytes = Math.max(0, sample.size);
  if (!sample.exists) {
    return { ...previous, lastCheckedAt: sample.now, status: "missing" };
  }

  const grew = bytes > previous.bytes;
  const lastGrowthAt = grew ? sample.now : previous.lastGrowthAt;
  if (!sample.recording) {
    return { bytes, lastCheckedAt: sample.now, lastGrowthAt, status: "paused" };
  }
  if (grew) {
    return { bytes, lastCheckedAt: sample.now, lastGrowthAt, status: "healthy" };
  }

  const stalled =
    sample.durationMs >= recordingFileStallThresholdMs &&
    sample.now - lastGrowthAt >= recordingFileStallThresholdMs;
  return {
    bytes,
    lastCheckedAt: sample.now,
    lastGrowthAt,
    status: stalled ? "stalled" : "waiting",
  };
}
