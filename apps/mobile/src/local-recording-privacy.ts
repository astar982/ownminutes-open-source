import type { PendingRecording } from "./recording-store";

export function selectAccountLocalRecordings(
  recordings: PendingRecording[],
  userId: string | null | undefined,
) {
  if (!userId) return [];
  return recordings.filter(
    (recording) =>
      recording.userId === userId &&
      recording.localRecoveryOnly !== true &&
      !recording.localDeletionPendingAt,
  );
}

export function selectDeviceLegacyRecoveryRecordings(recordings: PendingRecording[]) {
  return recordings.filter(
    (recording) =>
      !recording.userId &&
      recording.localRecoveryOnly === true &&
      !recording.localDeletionPendingAt,
  );
}
