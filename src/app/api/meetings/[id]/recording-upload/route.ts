import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/server/current-user";
import {
  commitMeetingRecordingUpload,
  MeetingAccessError,
  readMeetingRecordingUploadStatus,
  saveMeetingRecordingUploadPart,
} from "@/lib/server/meeting-audio-store";
import { meetingAccessErrorBody, meetingAccessErrorHeaders } from "@/lib/server/meeting-errors";
import { parseRecordingPartUpload, validateRecordingUploadId, type RecordingUploadMetadata } from "@/lib/server/recording-upload-protocol";
import { acquireFullRecordingAdmission, AudioUploadPolicyError, audioUploadPolicyErrorResponse } from "@/lib/server/audio-upload-policy";
import { RecordingUploadConflictError } from "@/lib/server/recording-upload-store";
import { getTranscriptionProvider } from "@/lib/transcription-adapter";
import { authenticatedMutationOriginResponse } from "@/lib/server/sensitive-action-guard";

export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  return handle(request, context, async ({ id, uploadId, userId }) => {
    const state = await readMeetingRecordingUploadStatus({ meetingId: id, ownerUserId: userId, uploadId });
    return NextResponse.json({
      ok: true,
      committed: state.committed,
      exists: state.exists,
      receivedParts: state.receivedParts,
      totalBytes: state.manifest?.totalBytes ?? state.receipt?.totalBytes ?? 0,
      totalParts: state.manifest?.totalParts ?? state.receipt?.uploadMetadata?.totalParts ?? (state.receipt ? 1 : 0),
      metadata: publicUploadMetadata(state.manifest ?? state.receipt?.uploadMetadata),
      ack: state.receipt ? recordingAck(state.receipt) : undefined,
    });
  });
}

export async function PUT(request: Request, context: { params: Promise<{ id: string }> }) {
  return handle(request, context, async ({ id, uploadId, userId }) => {
    const partIndex = Number(new URL(request.url).searchParams.get("part"));
    const parsed = await parseRecordingPartUpload(request, { partIndex, uploadId });
    const result = await saveMeetingRecordingUploadPart({
      buffer: parsed.buffer,
      meetingId: id,
      metadata: parsed.metadata,
      ownerUserId: userId,
      partIndex,
      sha256: parsed.sha256,
    });
    return NextResponse.json({
      ok: true,
      committed: result.committed,
      duplicate: result.duplicate,
      partIndex,
      receivedParts: result.receivedParts,
      sha256: parsed.sha256,
      ack: result.receipt ? recordingAck(result.receipt) : undefined,
    });
  });
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return handle(request, context, async ({ id, uploadId, userId }) => {
    const releaseAdmission = acquireFullRecordingAdmission();
    try {
      const receipt = await commitMeetingRecordingUpload({ meetingId: id, ownerUserId: userId, uploadId });
      return NextResponse.json(recordingAck(receipt));
    } finally {
      releaseAdmission();
    }
  });
}

async function handle(
  request: Request,
  context: { params: Promise<{ id: string }> },
  operation: (input: { id: string; uploadId: string; userId: string }) => Promise<NextResponse>,
) {
  const { id } = await context.params;
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ ok: false, error: "请先登录后再同步录音。" }, { status: 401 });
  if (request.method !== "GET") {
    const originResponse = authenticatedMutationOriginResponse(request);
    if (originResponse) return originResponse;
  }
  const uploadId = String(new URL(request.url).searchParams.get("uploadId") || "");
  try {
    validateRecordingUploadId(uploadId);
    return await operation({ id, uploadId, userId: user.id });
  } catch (error) {
    if (error instanceof MeetingAccessError) {
      return NextResponse.json(meetingAccessErrorBody(error), { status: error.status, headers: meetingAccessErrorHeaders(error) });
    }
    if (error instanceof AudioUploadPolicyError) {
      const response = audioUploadPolicyErrorResponse(error);
      return NextResponse.json(response.body, { status: response.status, headers: response.headers });
    }
    if (error instanceof RecordingUploadConflictError) {
      const headers = error.retryAfterSeconds ? { "Retry-After": String(error.retryAfterSeconds) } : undefined;
      return NextResponse.json({ ok: false, code: error.code, error: error.message }, { status: error.status, headers });
    }
    throw error;
  }
}

function publicUploadMetadata(metadata: RecordingUploadMetadata | undefined) {
  if (!metadata) return undefined;
  return {
    consentConfirmedAt: metadata.consentConfirmedAt,
    consentMethod: metadata.consentMethod,
    consentPolicyVersion: metadata.consentPolicyVersion,
    durationMs: metadata.durationMs,
    mimeType: metadata.mimeType,
    recordedAt: metadata.recordedAt,
    totalBytes: metadata.totalBytes,
    totalParts: metadata.totalParts,
    uploadId: metadata.uploadId,
  } satisfies RecordingUploadMetadata;
}

function recordingAck(receipt: {
  assemblyMaxBufferedBytes?: number;
  assemblyMethod?: "bounded-temp-file";
  durationMs: number;
  meetingId: string;
  receivedAt: string;
  savedBytes: number;
  totalBytes: number;
  totalChunks: number;
}) {
  return {
    ok: true,
    meetingId: receipt.meetingId,
    sequence: 1,
    savedBytes: receipt.savedBytes,
    totalChunks: receipt.totalChunks,
    totalBytes: receipt.totalBytes,
    durationMs: receipt.durationMs,
    receivedAt: receipt.receivedAt,
    provider: getTranscriptionProvider(),
    adapter: "resumable-recording-upload",
    assembly: receipt.assemblyMethod ?? "legacy-buffer",
    assemblyMaxBufferedBytes: receipt.assemblyMaxBufferedBytes,
    diagnostic: "完整录音已逐片校验、按有界内存组装并安全保存，等待会后正式处理。",
  };
}
