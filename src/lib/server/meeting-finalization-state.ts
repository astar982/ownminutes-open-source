import { buildMeetingObjectKey, getMeetingObjectStore, readOptionalMeetingObject } from "@/lib/server/meeting-object-store";
import { sanitizeFinalizationMessage } from "@/lib/server/finalization-error-policy";
import { withMeetingWriteFence } from "@/lib/server/meeting-write-lock";
import { isUserProcessingMode, type UserProcessingMode } from "@/lib/processing-route";

export type MeetingFinalizationStatus = "queued" | "processing" | "completed" | "failed";

export type MeetingFinalizationState = {
  meetingId: string;
  ownerUserId: string;
  title: string;
  status: MeetingFinalizationStatus;
  attempt: number;
  jobId?: string;
  processingOperationKey?: string;
  processingMode?: UserProcessingMode;
  audioRevision?: string;
  requestedAt: string;
  queuedAt?: string;
  startedAt?: string;
  updatedAt: string;
  nextAttemptAt?: string;
  leaseExpiresAt?: string;
  completedAt?: string;
  failedAt?: string;
  resultGeneratedAt?: string;
  qualityStatus?: "verified" | "unverified";
  error?: {
    code: string;
    message: string;
    retryable: boolean;
  };
};

const objectStore = getMeetingObjectStore();

export async function queueMeetingFinalization(input: {
  meetingId: string;
  ownerUserId: string;
  title: string;
  jobId: string;
  processingOperationKey?: string;
  processingMode?: UserProcessingMode;
  audioRevision?: string;
  nextAttemptAt?: string;
}) {
  return withMeetingWriteFence(input.meetingId, async (meetingId) => {
    const previous = await readMeetingFinalizationState(meetingId);
    const now = new Date().toISOString();
    const state: MeetingFinalizationState = {
      meetingId,
      ownerUserId: input.ownerUserId,
      title: input.title,
      status: "queued",
      attempt: Math.max(0, Number(previous?.attempt || 0)),
      jobId: input.jobId,
      processingOperationKey: input.processingOperationKey ?? previous?.processingOperationKey,
      processingMode: input.processingMode ?? previous?.processingMode,
      audioRevision: input.audioRevision ?? previous?.audioRevision,
      requestedAt: previous?.requestedAt || now,
      queuedAt: now,
      updatedAt: now,
      nextAttemptAt: input.nextAttemptAt,
    };
    await writeState(state);
    return state;
  });
}

export async function readMeetingFinalizationState(meetingId: string): Promise<MeetingFinalizationState | null> {
  return readOptionalMeetingObject(async () => {
    return normalizeState(JSON.parse(await objectStore.getText(buildMeetingObjectKey(meetingId, "processing"))), meetingId);
  });
}

export async function readUserMeetingFinalizationState(meetingId: string, ownerUserId: string) {
  const state = await readMeetingFinalizationState(meetingId);
  if (!state) return null;
  if (state.ownerUserId !== ownerUserId) throw new Error("Meeting finalization state belongs to another user.");
  return state;
}

export async function startMeetingFinalization(input: {
  meetingId: string;
  ownerUserId: string;
  title: string;
  leaseMs: number;
  processingOperationKey?: string;
  processingMode?: UserProcessingMode;
  audioRevision?: string;
}) {
  return withMeetingWriteFence(input.meetingId, async (meetingId) => {
    const previous = await readMeetingFinalizationState(meetingId);
    const sameRun = previous ? sameFinalizationIdentity(previous, {
      audioRevision: input.audioRevision,
      jobId: previous.jobId,
      ownerUserId: input.ownerUserId,
      processingOperationKey: input.processingOperationKey,
    }) : false;
    if (previous?.status === "completed" && sameRun) return previous;
    const now = new Date();
    const state: MeetingFinalizationState = {
      meetingId,
      ownerUserId: input.ownerUserId,
      title: input.title,
      status: "processing",
      attempt: Math.max(0, Number(previous?.attempt || 0)) + 1,
      jobId: sameRun ? previous?.jobId : undefined,
      processingOperationKey: input.processingOperationKey ?? previous?.processingOperationKey,
      processingMode: input.processingMode ?? (sameRun ? previous?.processingMode : undefined),
      audioRevision: input.audioRevision ?? previous?.audioRevision,
      requestedAt: sameRun ? previous?.requestedAt || now.toISOString() : now.toISOString(),
      queuedAt: sameRun ? previous?.queuedAt : undefined,
      startedAt: now.toISOString(),
      updatedAt: now.toISOString(),
      leaseExpiresAt: new Date(now.getTime() + input.leaseMs).toISOString(),
    };
    await writeState(state);
    return state;
  });
}

export async function refreshMeetingFinalizationLease(input: {
  audioRevision?: string;
  jobId?: string;
  meetingId: string;
  ownerUserId: string;
  processingOperationKey?: string;
  leaseMs: number;
}) {
  return withMeetingWriteFence(input.meetingId, async (meetingId) => {
    const current = await readMeetingFinalizationState(meetingId);
    if (
      !current ||
      current.status !== "processing" ||
      !sameFinalizationIdentity(current, input)
    ) return current;
    const now = new Date();
    const state: MeetingFinalizationState = {
      ...current,
      meetingId,
      updatedAt: now.toISOString(),
      leaseExpiresAt: new Date(now.getTime() + input.leaseMs).toISOString(),
    };
    await writeState(state);
    return state;
  });
}

export async function completeMeetingFinalization(input: {
  state: MeetingFinalizationState;
  resultGeneratedAt: string;
  qualityStatus: "verified" | "unverified";
}) {
  return withMeetingWriteFence(input.state.meetingId, async (meetingId) => {
    const current = await readMeetingFinalizationState(meetingId);
    if (current?.status === "completed") return current;
    if (current && !sameFinalizationRun(current, input.state)) return current;
    const completedAt = new Date().toISOString();
    const state: MeetingFinalizationState = {
      ...(current ?? input.state),
      meetingId,
      status: "completed",
      updatedAt: completedAt,
      completedAt,
      leaseExpiresAt: undefined,
      resultGeneratedAt: input.resultGeneratedAt,
      qualityStatus: input.qualityStatus,
      error: undefined,
    };
    await writeState(state);
    return state;
  });
}

export async function failMeetingFinalization(input: {
  state: MeetingFinalizationState;
  code: string;
  message: string;
  retryable: boolean;
}) {
  return withMeetingWriteFence(input.state.meetingId, async (meetingId) => {
    const current = await readMeetingFinalizationState(meetingId);
    if (current?.status === "completed") return current;
    if (current && !sameFinalizationRun(current, input.state)) return current;
    const failedAt = new Date().toISOString();
    const state: MeetingFinalizationState = {
      ...(current ?? input.state),
      meetingId,
      status: "failed",
      updatedAt: failedAt,
      failedAt,
      leaseExpiresAt: undefined,
      error: {
        code: sanitizeCode(input.code),
        message: sanitizeMessage(input.message),
        retryable: input.retryable,
      },
    };
    await writeState(state);
    return state;
  });
}

export function isFinalizationLeaseActive(state: MeetingFinalizationState | null, now = Date.now()) {
  if (state?.status !== "processing" || !state.leaseExpiresAt) return false;
  const expiresAt = new Date(state.leaseExpiresAt).getTime();
  return Number.isFinite(expiresAt) && expiresAt > now;
}

async function writeState(state: MeetingFinalizationState) {
  await withMeetingWriteFence(state.meetingId, async (meetingId) => {
    const canonicalState = state.meetingId === meetingId ? state : { ...state, meetingId };
    await objectStore.putText(buildMeetingObjectKey(meetingId, "processing"), `${JSON.stringify(canonicalState, null, 2)}\n`);
  });
}

function sameFinalizationRun(current: MeetingFinalizationState, expected: MeetingFinalizationState) {
  return sameFinalizationIdentity(current, expected);
}

function sameFinalizationIdentity(
  current: MeetingFinalizationState,
  expected: Pick<MeetingFinalizationState, "ownerUserId"> &
    Partial<Pick<MeetingFinalizationState, "audioRevision" | "jobId" | "processingOperationKey">>,
) {
  return current.ownerUserId === expected.ownerUserId &&
    current.jobId === expected.jobId &&
    current.processingOperationKey === expected.processingOperationKey &&
    current.audioRevision === expected.audioRevision;
}

function normalizeState(input: Partial<MeetingFinalizationState>, meetingId: string): MeetingFinalizationState {
  const now = new Date().toISOString();
  const status: MeetingFinalizationStatus =
    input.status === "queued" || input.status === "completed" || input.status === "failed" ? input.status : "processing";
  return {
    meetingId: input.meetingId || meetingId,
    ownerUserId: input.ownerUserId || "",
    title: input.title || `OwnMinutes 会议 ${meetingId}`,
    status,
    attempt: Math.max(status === "queued" ? 0 : 1, Number(input.attempt ?? (status === "queued" ? 0 : 1))),
    jobId: input.jobId,
    processingOperationKey: sanitizeOptionalContextValue(input.processingOperationKey, 240),
    processingMode: isUserProcessingMode(input.processingMode) ? input.processingMode : undefined,
    audioRevision: sanitizeOptionalContextValue(input.audioRevision, 128),
    requestedAt: input.requestedAt || input.startedAt || input.updatedAt || now,
    queuedAt: input.queuedAt,
    startedAt: input.startedAt,
    updatedAt: input.updatedAt || now,
    nextAttemptAt: input.nextAttemptAt,
    leaseExpiresAt: input.leaseExpiresAt,
    completedAt: input.completedAt,
    failedAt: input.failedAt,
    resultGeneratedAt: input.resultGeneratedAt,
    qualityStatus: input.qualityStatus === "verified" ? "verified" : input.qualityStatus === "unverified" ? "unverified" : undefined,
    error: input.error
      ? {
          code: sanitizeCode(input.error.code),
          message: sanitizeMessage(input.error.message),
          retryable: Boolean(input.error.retryable),
        }
      : undefined,
  };
}

function sanitizeCode(value: string) {
  return value.replace(/[^a-z0-9_-]/gi, "_").slice(0, 80) || "processing_failed";
}

function sanitizeMessage(value: string) {
  return sanitizeFinalizationMessage(value);
}

function sanitizeOptionalContextValue(value: string | undefined, maxLength: number) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized ? normalized.slice(0, maxLength) : undefined;
}
