import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/server/current-user";
import { MeetingAccessError, saveMeetingAudioChunk } from "@/lib/server/meeting-audio-store";
import { meetingAccessErrorBody, meetingAccessErrorHeaders } from "@/lib/server/meeting-errors";
import { getRealtimeTranscriptionAdapter, getTranscriptionProvider } from "@/lib/transcription-adapter";
import { resolveUploadedAudioDurationMs } from "@/lib/server/uploaded-audio-duration";
import { parseRecordingConsentMetadata } from "@/lib/server/recording-upload-protocol";
import {
  acquireFullRecordingAdmission,
  AudioUploadPolicyError,
  audioUploadPolicyErrorResponse,
  getAudioUploadRequestMaxBytes,
  getAudioUploadPolicy,
  requestClaimsFullRecording,
  shouldAcquireFullRecordingAdmission,
  validateAudioRequestContentLength,
  validateFullRecordingDuration,
  validateUploadedAudio,
} from "@/lib/server/audio-upload-policy";
import { authenticatedMutationOriginResponse } from "@/lib/server/sensitive-action-guard";
import { BoundedRequestError, readBoundedFormData } from "@/lib/server/bounded-request";

export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: "请先登录后再录制会议。" }, { status: 401 });
  }
  const originResponse = authenticatedMutationOriginResponse(request);
  if (originResponse) return originResponse;

  const policy = getAudioUploadPolicy();
  let releaseAdmission: (() => void) | undefined;
  try {
    const claimedFullRecording = requestClaimsFullRecording(request);
    const contentLength = validateAudioRequestContentLength(request, policy);
    if (shouldAcquireFullRecordingAdmission({ claimedFullRecording, contentLength, policy })) {
      releaseAdmission = acquireFullRecordingAdmission(policy);
    }

    const formData = await readBoundedFormData(request, getAudioUploadRequestMaxBytes(policy));
    const chunk = formData.get("chunk");

    if (!(chunk instanceof File)) {
      return NextResponse.json({ ok: false, error: "missing audio chunk" }, { status: 400 });
    }

    const sequence = Number(formData.get("sequence") ?? 0);
    const submittedDurationMs = Number(formData.get("durationMs") ?? 1000);
    const fullRecording = formData.get("fullRecording") === "1";
    const recordedAt = Number(formData.get("recordedAt") ?? Date.now());
    const mimeType = String(formData.get("mimeType") || chunk.type || "audio/webm");
    const recordingConsent = parseRecordingConsentMetadata(request.headers);
    if (fullRecording && !releaseAdmission) {
      releaseAdmission = acquireFullRecordingAdmission(policy);
    }

    if (!Number.isInteger(sequence) || sequence <= 0) {
      return NextResponse.json({ ok: false, error: "invalid sequence" }, { status: 400 });
    }

    validateUploadedAudio({ fullRecording, mimeType, size: chunk.size, policy });
    const buffer = Buffer.from(await chunk.arrayBuffer());
    let durationMs: number;
    try {
      durationMs = await resolveUploadedAudioDurationMs({ buffer, fullRecording, sequence, submittedDurationMs });
      if (fullRecording) validateFullRecordingDuration(durationMs, policy);
    } catch (error) {
      if (error instanceof AudioUploadPolicyError) throw error;
      const message = error instanceof Error ? error.message : "无法校验音频时长，请重试上传。";
      const invalidRequest = message === "invalid durationMs" || message === "full recording must use sequence 1";
      return NextResponse.json({ ok: false, error: message }, { status: invalidRequest ? 400 : 422 });
    }
    let saved;
    try {
      saved = await saveMeetingAudioChunk({
        meetingId: id,
        ownerUserId: user.id,
        sequence,
        buffer,
        mimeType,
        recordedAt,
        durationMs,
        recordingConsent,
      });
    } catch (error) {
      if (error instanceof MeetingAccessError) {
        return NextResponse.json(meetingAccessErrorBody(error), {
          status: error.status,
          headers: meetingAccessErrorHeaders(error),
        });
      }
      throw error;
    }

    const adapter = getRealtimeTranscriptionAdapter();
    const transcription = await adapter.acceptChunk({
      meetingId: id,
      sequence,
      mimeType,
      savedBytes: saved.savedBytes,
      recordedAt,
      durationMs,
    });

    return NextResponse.json({
      ok: true,
      meetingId: id,
      sequence,
      savedBytes: saved.savedBytes,
      totalChunks: saved.totalChunks,
      totalBytes: saved.totalBytes,
      durationMs,
      receivedAt: saved.receivedAt,
      provider: getTranscriptionProvider(),
      adapter: transcription.adapter,
      diagnostic: transcription.diagnostic,
      transcriptSegment: transcription.transcriptSegment,
    });
  } catch (error) {
    if (error instanceof BoundedRequestError) {
      return NextResponse.json(
        { ok: false, code: error.code, error: error.message },
        { status: error.status },
      );
    }
    if (error instanceof AudioUploadPolicyError) {
      const response = audioUploadPolicyErrorResponse(error);
      return NextResponse.json(response.body, { status: response.status, headers: response.headers });
    }
    throw error;
  } finally {
    releaseAdmission?.();
  }
}
