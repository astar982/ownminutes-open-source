import type { PendingRecording } from "./recording-store";

export type PendingSyncOptions = { force?: boolean; onlyMeetingId?: string; showActiveResult?: boolean };

export function mergeDeferredSyncOptions(
  current: PendingSyncOptions | null,
  incoming: PendingSyncOptions,
): PendingSyncOptions {
  if (!current) return { ...incoming };
  if (current.onlyMeetingId && incoming.onlyMeetingId && current.onlyMeetingId !== incoming.onlyMeetingId) {
    return { force: current.force === true || incoming.force === true };
  }
  const onlyMeetingId = incoming.onlyMeetingId ?? current.onlyMeetingId;
  return {
    force: current.force === true || incoming.force === true,
    onlyMeetingId,
    showActiveResult:
      Boolean(onlyMeetingId) &&
      (current.showActiveResult === true || incoming.showActiveResult === true),
  };
}

export function shouldDrainDeferredSync(input: {
  hasDeferredOptions: boolean;
  recordingLifecycleBusy: boolean;
  syncInFlight: boolean;
  uploadInFlight: boolean;
}) {
  return (
    input.hasDeferredOptions &&
    !input.recordingLifecycleBusy &&
    !input.syncInFlight &&
    !input.uploadInFlight
  );
}

export function pendingRetryDelayMs(attempt: number, retryAfterSeconds = 0) {
  const boundedAttempt = Math.max(1, Math.min(attempt, 7));
  const exponentialDelayMs = 15_000 * 2 ** (boundedAttempt - 1);
  const serverDelayMs = Number.isFinite(retryAfterSeconds) ? Math.max(0, retryAfterSeconds * 1000) : 0;
  return Math.min(15 * 60 * 1000, Math.max(exponentialDelayMs, serverDelayMs));
}

export function selectPendingSyncTargets(
  recordings: PendingRecording[],
  options: {
    force?: boolean;
    now?: number;
    onlyMeetingId?: string;
    userId: string;
  },
) {
  const now = options.now ?? Date.now();
  return recordings
    .filter((recording) => recording.userId === options.userId)
    .filter((recording) => recording.localRecoveryOnly !== true)
    .filter((recording) => !options.onlyMeetingId || recording.meetingId === options.onlyMeetingId)
    .filter((recording) => !recording.localDeletionPendingAt)
    .filter((recording) => recording.activeRecording !== true)
    .filter((recording) => !recording.finalizedAt || (options.force === true && options.onlyMeetingId === recording.meetingId))
    .filter((recording) => {
      if (options.force || !recording.nextRetryAt) return true;
      const retryAt = Date.parse(recording.nextRetryAt);
      return !Number.isFinite(retryAt) || retryAt <= now;
    })
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}
