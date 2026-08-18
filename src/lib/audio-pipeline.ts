import type { ActionItem, Decision, TranscriptSegment } from "@/lib/meeting";

export type RecordedAudioChunk = {
  blob: Blob;
  sequence: number;
  mimeType: string;
  recordedAt: number;
  durationMs: number;
};

export type AudioChunkAck = {
  assembly?: "bounded-temp-file" | "legacy-buffer";
  assemblyMaxBufferedBytes?: number;
  ok: boolean;
  meetingId: string;
  sequence: number;
  savedBytes: number;
  totalChunks: number;
  totalBytes: number;
  receivedAt: string;
  provider: "mock" | "openai" | "volcano";
  adapter: string;
  diagnostic?: string;
  transcriptSegment?: TranscriptSegment;
};

export type UploadState = {
  uploaded: number;
  pending: number;
  failed: number;
  savedBytes: number;
  lastAckAt: string | null;
  lastError: string | null;
  adapter: string;
  provider: string;
  diagnostic: string | null;
};

export type FinalMeetingSummary = {
  summary: string;
  topics: string[];
  speakerViews: Array<{
    speaker: string;
    view: string;
  }>;
  decisions: Decision[];
  actionItems: ActionItem[];
  risks: string[];
  openQuestions: string[];
  knowledgePoints: string[];
};

export type FinalizedMeeting = {
  meetingId: string;
  audioRevision?: string;
  title: string;
  generatedAt: string;
  adapter: string;
  provider: "mock" | "openai" | "volcano";
  transcript: TranscriptSegment[];
  summary: FinalMeetingSummary;
  obsidianMarkdown: string;
  diagnostics: string[];
};

export type FinalizeMeetingResponse = {
  ok: boolean;
  result?: FinalizedMeeting;
  processing?: MeetingFinalizationState;
  queued?: boolean;
  job?: {
    id: string;
    status: string;
    attempt: number;
    maxAttempts: number;
    availableAt: string;
  };
  idempotent?: boolean;
  retryable?: boolean;
  code?: string;
  error?: string;
};

export type MeetingFinalizationState = {
  meetingId: string;
  ownerUserId: string;
  title: string;
  status: "queued" | "processing" | "completed" | "failed";
  attempt: number;
  jobId?: string;
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

export type PublishMeetingShareResponse = {
  ok: boolean;
  shareUrl?: string;
  error?: string;
};

export const initialUploadState: UploadState = {
  uploaded: 0,
  pending: 0,
  failed: 0,
  savedBytes: 0,
  lastAckAt: null,
  lastError: null,
  adapter: "未连接",
  provider: "mock",
  diagnostic: null,
};

export async function uploadAudioChunk(meetingId: string, chunk: RecordedAudioChunk) {
  const formData = new FormData();
  formData.append("sequence", String(chunk.sequence));
  formData.append("mimeType", chunk.mimeType);
  formData.append("recordedAt", String(chunk.recordedAt));
  formData.append("durationMs", String(chunk.durationMs));
  formData.append("chunk", chunk.blob, `chunk-${String(chunk.sequence).padStart(6, "0")}.webm`);

  const response = await fetch(`/api/meetings/${meetingId}/chunks`, {
    method: "POST",
    body: formData,
  });

  if (!response.ok) {
    throw new Error(`音频分片上传失败：${response.status}`);
  }

  return (await response.json()) as AudioChunkAck;
}

export async function finalizeMeeting(
  meetingId: string,
  title: string,
  force = false,
  audioSeal?: { expectedLastSequence: number; totalBytes: number },
) {
  const operationId = force ? createBrowserReprocessOperationId() : undefined;
  const response = await fetch(`/api/meetings/${meetingId}/finalize`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(operationId ? { "Idempotency-Key": operationId } : {}),
    },
    body: JSON.stringify({ title, force, operationId, ...audioSeal }),
  });

  const payload = (await response.json()) as FinalizeMeetingResponse;

  if (!response.ok || !payload.ok) {
    throw new Error(payload.error || `会议正式处理失败：${response.status}`);
  }

  if (!payload.result && (payload.queued || payload.processing?.status === "queued" || payload.processing?.status === "processing")) {
    return pollMeetingFinalization(meetingId);
  }

  return payload;
}

function createBrowserReprocessOperationId() {
  const suffix =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `reprocess-${suffix}`;
}

async function pollMeetingFinalization(meetingId: string) {
  const deadline = Date.now() + 15 * 60 * 1000;
  while (Date.now() < deadline) {
    await delay(2_000);
    const response = await fetch(`/api/meetings/${meetingId}/finalize`, { cache: "no-store" });
    const payload = (await response.json()) as FinalizeMeetingResponse;
    if (!response.ok || !payload.ok) throw new Error(payload.error || `会议处理状态读取失败：${response.status}`);
    if (payload.result && payload.processing?.status === "completed") return payload;
    if (payload.processing?.status === "failed") {
      throw new Error(payload.processing.error?.message || "会议纪要生成失败，音频已保留，可稍后重试。");
    }
  }
  throw new Error("会议处理仍在后台进行。音频已经保存，可稍后在会议历史中查看结果。");
}

function delay(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

export async function publishMeetingShare(meetingId: string, includeTranscript: boolean, confirmUnverified = false) {
  const response = await fetch(`/api/meetings/${meetingId}/share`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      visibility: "public",
      includeTranscript,
      confirmUnverified,
    }),
  });

  const payload = (await response.json()) as PublishMeetingShareResponse;

  if (!response.ok || !payload.ok) {
    throw new Error(payload.error || `分享发布失败：${response.status}`);
  }

  return payload;
}

export async function confirmMeetingHumanReview(meetingId: string, confirmed: boolean) {
  const response = await fetch(`/api/meetings/${meetingId}/review`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ confirmed }),
  });
  const payload = (await response.json()) as { ok?: boolean; error?: string; humanReview?: { status: "pending" | "confirmed" } };
  if (!response.ok || !payload.ok || !payload.humanReview) {
    throw new Error(payload.error || `人工复核状态保存失败：${response.status}`);
  }
  return payload.humanReview;
}
