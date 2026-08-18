import type { TranscriptSegment } from "@/lib/meeting";
import { getMeetingObjectStore } from "@/lib/server/meeting-object-store";
import { withMeetingWriteFence } from "@/lib/server/meeting-write-lock";
import type { TranscriptionProvider } from "@/lib/transcription-adapter";

export type RealtimeSessionStatus =
  | "accepted"
  | "draft"
  | "not_configured"
  | "pending_protocol"
  | "provider_error"
  | "reconnecting"
  | "completed"
  | "rejected_format";

export type RealtimeSessionSummary = {
  meetingId: string;
  ownerUserId: string;
  createdAt: string;
  updatedAt: string;
  chunkCount: number;
  acceptedChunkCount: number;
  rejectedChunkCount: number;
  totalBytes: number;
  totalDurationMs: number;
  sampleRate?: number;
  channels?: number;
  lastSequence?: number;
  highestSequence?: number;
  duplicateSequenceCount: number;
  outOfOrderCount: number;
  lastByteDrift?: number;
  maxAbsByteDrift: number;
  formatMismatchCount: number;
  provider: TranscriptionProvider;
  adapter: string;
  sessionId?: string;
  lastProviderStatus?: RealtimeSessionStatus;
  lastDiagnostic?: string;
  transcriptCount: number;
  transcriptSegments: TranscriptSegment[];
  lastTranscriptSegment?: TranscriptSegment;
  statusCounts: Record<RealtimeSessionStatus, number>;
};

export class RealtimeSessionAccessError extends Error {
  status: number;

  constructor(message: string, status = 403) {
    super(message);
    this.status = status;
  }
}

const objectStore = getMeetingObjectStore();
const realtimeSessionOperations = new Map<string, Promise<void>>();

export function classifyRealtimeSequence(highestSequence: number | undefined, sequence: number) {
  const highest = Math.max(0, Number(highestSequence || 0));
  const expectedSequence = highest + 1;
  return {
    expectedSequence,
    status: sequence <= highest ? ("duplicate" as const) : sequence === expectedSequence ? ("next" as const) : ("out_of_order" as const),
  };
}

export async function withRealtimeSessionLock<T>(meetingId: string, operation: () => Promise<T>) {
  const key = sanitizeSegment(meetingId);
  const previous = realtimeSessionOperations.get(key) ?? Promise.resolve();
  const waitForPrevious = previous.catch(() => undefined);
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const current = waitForPrevious.then(() => gate);
  realtimeSessionOperations.set(key, current);
  await waitForPrevious;

  try {
    return await operation();
  } finally {
    release();
    if (realtimeSessionOperations.get(key) === current) realtimeSessionOperations.delete(key);
  }
}

export async function ensureRealtimeSessionOwnership(input: {
  meetingId: string;
  ownerUserId: string;
  provider: TranscriptionProvider;
}) {
  return withMeetingWriteFence(input.meetingId, async (meetingId) => {
    const current = await readRealtimeSession(meetingId);
    if (current) {
      if (current.ownerUserId !== input.ownerUserId) {
        throw new RealtimeSessionAccessError("This realtime session belongs to another user.", 403);
      }
      return current;
    }
    const now = new Date().toISOString();
    const created = {
      ...emptyRealtimeSession(meetingId, input.ownerUserId, now),
      provider: input.provider,
      adapter: "provider-preflight",
    };
    await objectStore.putText(realtimeSessionKey(meetingId), `${JSON.stringify(created, null, 2)}\n`);
    return created;
  });
}

export async function recordRealtimeSessionChunk(input: {
  meetingId: string;
  ownerUserId: string;
  sequence: number;
  receivedBytes: number;
  durationMs: number;
  sampleRate?: number;
  channels?: number;
  byteDrift?: number;
  formatOk?: boolean;
  provider: TranscriptionProvider;
  adapter: string;
  sessionId?: string;
  providerStatus?: RealtimeSessionStatus;
  diagnostic?: string;
  transcriptSegment?: TranscriptSegment;
}) {
  return withMeetingWriteFence(input.meetingId, async (meetingId) => {
  const key = realtimeSessionKey(meetingId);
  const now = new Date().toISOString();
  const current = (await readRealtimeSession(meetingId)) ?? emptyRealtimeSession(meetingId, input.ownerUserId, now);

  if (current.ownerUserId !== input.ownerUserId) {
    throw new RealtimeSessionAccessError("This realtime session belongs to another user.", 403);
  }

  const providerStatus = input.providerStatus ?? "accepted";
  const transcriptSegments = upsertTranscriptSegment(current.transcriptSegments, input.transcriptSegment);
  const next: RealtimeSessionSummary = {
    ...current,
    updatedAt: now,
    chunkCount: current.chunkCount + 1,
    acceptedChunkCount: current.acceptedChunkCount + (providerStatus === "rejected_format" ? 0 : 1),
    rejectedChunkCount: current.rejectedChunkCount + (providerStatus === "rejected_format" ? 1 : 0),
    totalBytes: current.totalBytes + input.receivedBytes,
    totalDurationMs: current.totalDurationMs + input.durationMs,
    sampleRate: input.sampleRate ?? current.sampleRate,
    channels: input.channels ?? current.channels,
    lastSequence: input.sequence,
    highestSequence: Math.max(current.highestSequence ?? 0, input.sequence),
    duplicateSequenceCount: current.duplicateSequenceCount + (input.sequence <= (current.highestSequence ?? 0) ? 1 : 0),
    outOfOrderCount: current.outOfOrderCount + (current.lastSequence && input.sequence < current.lastSequence ? 1 : 0),
    lastByteDrift: input.byteDrift ?? current.lastByteDrift,
    maxAbsByteDrift: Math.max(current.maxAbsByteDrift, Math.abs(input.byteDrift ?? 0)),
    formatMismatchCount: current.formatMismatchCount + (input.formatOk === false ? 1 : 0),
    provider: input.provider,
    adapter: input.adapter,
    sessionId: input.sessionId ?? current.sessionId,
    lastProviderStatus: providerStatus,
    lastDiagnostic: scrubDiagnostic(input.diagnostic) ?? current.lastDiagnostic,
    transcriptCount: transcriptSegments.length,
    transcriptSegments,
    lastTranscriptSegment: input.transcriptSegment ?? current.lastTranscriptSegment,
    statusCounts: incrementStatusCounts(current.statusCounts, providerStatus),
  };

  await objectStore.putText(key, `${JSON.stringify(next, null, 2)}\n`);
  return next;
  });
}

export async function recordRealtimeSessionEvent(input: {
  meetingId: string;
  ownerUserId: string;
  provider: TranscriptionProvider;
  adapter: string;
  sessionId?: string;
  providerStatus: RealtimeSessionStatus;
  diagnostic?: string;
  transcriptSegment?: TranscriptSegment;
}) {
  return withMeetingWriteFence(input.meetingId, async (meetingId) => {
  const key = realtimeSessionKey(meetingId);
  const now = new Date().toISOString();
  const current = (await readRealtimeSession(meetingId)) ?? emptyRealtimeSession(meetingId, input.ownerUserId, now);
  if (current.ownerUserId !== input.ownerUserId) {
    throw new RealtimeSessionAccessError("This realtime session belongs to another user.", 403);
  }
  const transcriptSegments = upsertTranscriptSegment(current.transcriptSegments, input.transcriptSegment);
  const next: RealtimeSessionSummary = {
    ...current,
    updatedAt: now,
    provider: input.provider,
    adapter: input.adapter,
    sessionId: input.sessionId ?? current.sessionId,
    lastProviderStatus: input.providerStatus,
    lastDiagnostic: scrubDiagnostic(input.diagnostic) ?? current.lastDiagnostic,
    transcriptCount: transcriptSegments.length,
    transcriptSegments,
    lastTranscriptSegment: input.transcriptSegment ?? current.lastTranscriptSegment,
    statusCounts: incrementStatusCounts(current.statusCounts, input.providerStatus),
  };
  await objectStore.putText(key, `${JSON.stringify(next, null, 2)}\n`);
  return next;
  });
}

export async function recordRealtimeSequenceAnomaly(input: {
  adapter: string;
  meetingId: string;
  ownerUserId: string;
  provider: TranscriptionProvider;
  sequence: number;
  type: "duplicate" | "out_of_order";
}) {
  return withMeetingWriteFence(input.meetingId, async (meetingId) => {
  const key = realtimeSessionKey(meetingId);
  const now = new Date().toISOString();
  const current = (await readRealtimeSession(meetingId)) ?? emptyRealtimeSession(meetingId, input.ownerUserId, now);
  if (current.ownerUserId !== input.ownerUserId) {
    throw new RealtimeSessionAccessError("This realtime session belongs to another user.", 403);
  }
  const next: RealtimeSessionSummary = {
    ...current,
    updatedAt: now,
    provider: input.provider,
    adapter: input.adapter,
    duplicateSequenceCount: current.duplicateSequenceCount + (input.type === "duplicate" ? 1 : 0),
    outOfOrderCount: current.outOfOrderCount + (input.type === "out_of_order" ? 1 : 0),
  };
  await objectStore.putText(key, `${JSON.stringify(next, null, 2)}\n`);
  return next;
  });
}

export async function readUserRealtimeSession(meetingId: string, ownerUserId: string) {
  return withMeetingWriteFence(meetingId, async (canonicalId) => {
  const session = await readRealtimeSession(canonicalId);
  if (!session) return null;
  if (session.ownerUserId !== ownerUserId) {
    throw new RealtimeSessionAccessError("You do not have access to this realtime session.", 403);
  }

  return session;
  });
}

export async function getRealtimeSessionOwner(meetingId: string) {
  return (await readRealtimeSession(meetingId))?.ownerUserId;
}

async function readRealtimeSession(meetingId: string): Promise<RealtimeSessionSummary | null> {
  try {
    return normalizeRealtimeSession(JSON.parse(await objectStore.getText(realtimeSessionKey(meetingId))), meetingId);
  } catch {
    return null;
  }
}

function emptyRealtimeSession(meetingId: string, ownerUserId: string, now: string): RealtimeSessionSummary {
  return {
    meetingId,
    ownerUserId,
    createdAt: now,
    updatedAt: now,
    chunkCount: 0,
    acceptedChunkCount: 0,
    rejectedChunkCount: 0,
    totalBytes: 0,
    totalDurationMs: 0,
    duplicateSequenceCount: 0,
    outOfOrderCount: 0,
    maxAbsByteDrift: 0,
    formatMismatchCount: 0,
    provider: "mock",
    adapter: "unknown",
    transcriptCount: 0,
    transcriptSegments: [],
    statusCounts: {
      accepted: 0,
      draft: 0,
      not_configured: 0,
      pending_protocol: 0,
      provider_error: 0,
      reconnecting: 0,
      completed: 0,
      rejected_format: 0,
    },
  };
}

function normalizeRealtimeSession(input: Partial<RealtimeSessionSummary>, meetingId: string): RealtimeSessionSummary {
  const now = new Date().toISOString();
  const transcriptSegments = normalizeTranscriptSegments(input.transcriptSegments, input.lastTranscriptSegment);
  return {
    meetingId: input.meetingId || meetingId,
    ownerUserId: input.ownerUserId || "",
    createdAt: input.createdAt || input.updatedAt || now,
    updatedAt: input.updatedAt || now,
    chunkCount: Number(input.chunkCount || 0),
    acceptedChunkCount:
      input.acceptedChunkCount === undefined
        ? Math.max(0, Number(input.chunkCount || 0) - Number(input.rejectedChunkCount || 0))
        : Math.max(0, Number(input.acceptedChunkCount || 0)),
    rejectedChunkCount: Number(input.rejectedChunkCount || 0),
    totalBytes: Number(input.totalBytes || 0),
    totalDurationMs: Number(input.totalDurationMs || 0),
    sampleRate: normalizeOptionalNumber(input.sampleRate),
    channels: normalizeOptionalNumber(input.channels),
    lastSequence: normalizeOptionalNumber(input.lastSequence),
    highestSequence: normalizeOptionalNumber(input.highestSequence),
    duplicateSequenceCount: Number(input.duplicateSequenceCount || 0),
    outOfOrderCount: Number(input.outOfOrderCount || 0),
    lastByteDrift: normalizeOptionalSignedNumber(input.lastByteDrift),
    maxAbsByteDrift: Number(input.maxAbsByteDrift || 0),
    formatMismatchCount: Number(input.formatMismatchCount || 0),
    provider: normalizeProvider(input.provider),
    adapter: input.adapter || "unknown",
    sessionId: input.sessionId,
    lastProviderStatus: normalizeStatus(input.lastProviderStatus),
    lastDiagnostic: scrubDiagnostic(input.lastDiagnostic),
    transcriptCount: transcriptSegments.length,
    transcriptSegments,
    lastTranscriptSegment: input.lastTranscriptSegment,
    statusCounts: {
      accepted: Number(input.statusCounts?.accepted || 0),
      draft: Number(input.statusCounts?.draft || 0),
      not_configured: Number(input.statusCounts?.not_configured || 0),
      pending_protocol: Number(input.statusCounts?.pending_protocol || 0),
      provider_error: Number(input.statusCounts?.provider_error || 0),
      reconnecting: Number(input.statusCounts?.reconnecting || 0),
      completed: Number(input.statusCounts?.completed || 0),
      rejected_format: Number(input.statusCounts?.rejected_format || 0),
    },
  };
}

function realtimeSessionKey(meetingId: string) {
  return `${sanitizeSegment(meetingId)}/realtime-session.json`;
}

function sanitizeSegment(value: string) {
  if (!/^[a-zA-Z0-9_-]{1,160}$/.test(value)) {
    throw new RealtimeSessionAccessError("invalid meeting id", 400);
  }
  return value;
}

function normalizeOptionalNumber(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : undefined;
}

function normalizeOptionalSignedNumber(value: unknown) {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function normalizeProvider(value: unknown): TranscriptionProvider {
  return value === "openai" || value === "volcano" || value === "mock" ? value : "mock";
}

function normalizeStatus(value: unknown): RealtimeSessionStatus | undefined {
  return value === "accepted" ||
    value === "draft" ||
    value === "not_configured" ||
    value === "pending_protocol" ||
    value === "provider_error" ||
    value === "reconnecting" ||
    value === "completed" ||
    value === "rejected_format"
    ? value
    : undefined;
}

function incrementStatusCounts(counts: Record<RealtimeSessionStatus, number>, status: RealtimeSessionStatus) {
  return {
    ...counts,
    [status]: Number(counts[status] || 0) + 1,
  };
}

function upsertTranscriptSegment(segments: TranscriptSegment[], segment?: TranscriptSegment) {
  if (!segment || !segment.text.trim()) return segments;
  const next = [...segments];
  const existingIndex = next.findIndex((item) => item.id === segment.id);
  if (existingIndex >= 0) next[existingIndex] = segment;
  else next.push(segment);
  return next.slice(-5000);
}

function normalizeTranscriptSegments(value: unknown, legacyLastSegment?: TranscriptSegment) {
  const source = Array.isArray(value) ? value : legacyLastSegment ? [legacyLastSegment] : [];
  const unique = new Map<string, TranscriptSegment>();
  for (const candidate of source) {
    if (!candidate || typeof candidate !== "object") continue;
    const item = candidate as Partial<TranscriptSegment>;
    if (typeof item.id !== "string" || typeof item.text !== "string" || !item.text.trim()) continue;
    unique.set(item.id, {
      id: item.id,
      speaker: typeof item.speaker === "string" && item.speaker.trim() ? item.speaker : "Speaker 1",
      timestamp: typeof item.timestamp === "string" && item.timestamp.trim() ? item.timestamp : "00:00",
      text: item.text,
    });
  }
  return [...unique.values()].slice(-5000);
}

function scrubDiagnostic(value: unknown) {
  if (typeof value !== "string") return undefined;
  return value
    .replace(/AKL[A-Za-z0-9_-]+/g, "[redacted-access-key]")
    .replace(/sk-[A-Za-z0-9_-]+/g, "[redacted-api-key]")
    .replace(/(X-Api-(?:Key|Access-Key)[:=]\s*)[^\s,;]+/gi, "$1[redacted]")
    .replace(/realtime-smoke-secret-api-key/g, "[redacted-api-key]")
    .slice(0, 500);
}
