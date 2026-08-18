export type MeetingDeletionResponse = {
  cleanupPending?: boolean;
  meetingId?: string;
  ok: boolean;
};

export type MeetingDeletionResolution =
  | {
      confirmedBy: "history" | "response" | "retry";
      deletion: MeetingDeletionResponse;
      status: "deleted";
    }
  | {
      error: unknown;
      status: "failed";
    }
  | {
      error: unknown;
      status: "pending_confirmation";
    };

export function isMeetingDeletionBlocked(input: {
  currentMeetingId: string;
  recordingLifecycleBusy: boolean;
  targetMeetingId: string;
}) {
  return input.recordingLifecycleBusy && input.currentMeetingId === input.targetMeetingId;
}

export async function deleteMeetingWithConfirmation(input: {
  meetingId: string;
  listMeetingIds: () => Promise<string[]>;
  requestDelete: () => Promise<MeetingDeletionResponse>;
}): Promise<MeetingDeletionResolution> {
  const errors: unknown[] = [];
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return {
        confirmedBy: attempt === 0 ? "response" : "retry",
        deletion: await input.requestDelete(),
        status: "deleted",
      };
    } catch (error) {
      lastError = error;
      errors.push(error);
    }
  }

  const deleteWasDeterministicallyRejected =
    errors.length > 0 && errors.every(isDeterministicDeleteRejection);

  try {
    const meetingIds = await input.listMeetingIds();
    if (!meetingIds.includes(input.meetingId)) {
      return {
        confirmedBy: "history",
        // The logical deletion is confirmed, but a lost DELETE response cannot
        // prove whether deferred server-object cleanup is already complete.
        deletion: { cleanupPending: true, meetingId: input.meetingId, ok: true },
        status: "deleted",
      };
    }
    // A timeout or transport failure can mean the server committed and the
    // history replica has not caught up yet. Keep the meeting visible and
    // retryable instead of reporting a false failure.
    return deleteWasDeterministicallyRejected
      ? { error: lastError, status: "failed" }
      : { error: lastError, status: "pending_confirmation" };
  } catch {
    if (deleteWasDeterministicallyRejected) return { error: lastError, status: "failed" };
    // Never convert an unknown transport outcome into a false failure. The
    // meeting remains visible and retryable until a later refresh can confirm
    // whether the idempotent server deletion committed.
    return { error: lastError, status: "pending_confirmation" };
  }
}

function isDeterministicDeleteRejection(error: unknown) {
  if (!error || typeof error !== "object") return false;
  const status = Number((error as { status?: unknown }).status);
  return Number.isInteger(status) && status >= 400 && status < 500 && status !== 408 && status !== 429;
}
