import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/server/current-user";
import { getMeetingProcessingReservation } from "@/lib/server/auth-repository";
import { assertMeetingOwner, MeetingAccessError, readMeetingResultFreshness, sealMeetingAudio } from "@/lib/server/meeting-audio-store";
import { MeetingFinalizationError, finalizeMeetingForUser } from "@/lib/server/meeting-finalizer";
import { enqueueMeetingFinalizationJob, getFinalizationQueueMode } from "@/lib/server/finalization-queue";
import { readUserMeetingFinalizationState } from "@/lib/server/meeting-finalization-state";
import { meetingAccessErrorBody, meetingAccessErrorHeaders } from "@/lib/server/meeting-errors";
import { getMeetingContentCopy, resolveMeetingContentLocale } from "@/lib/meeting-content-locale";
import { initialMeetingOperationKey, reprocessMeetingOperationKey } from "@/lib/processing-route";
import { authenticatedMutationOriginResponse } from "@/lib/server/sensitive-action-guard";
import {
  parseRequestedMeetingProcessingMode,
  resolveMeetingProcessingMode,
} from "@/lib/server/meeting-processing-mode";
import {
  boundedString,
  BoundedRequestError,
  readBoundedOptionalJson,
  requirePlainRecord,
} from "@/lib/server/bounded-request";

export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ ok: false, error: "请先登录后再查看纪要处理状态。" }, { status: 401 });

  try {
    await assertMeetingOwner(id, user.id);
    const freshness = await readMeetingResultFreshness(id);
    let processing = await readUserMeetingFinalizationState(id, user.id);
    if (getFinalizationQueueMode() === "postgres-queue" && freshness.audio.sealed && freshness.result && !freshness.current) {
      const contentLocale = resolveMeetingContentLocale(request.headers.get("accept-language"));
      const processingMode = await resolveApiMeetingProcessingMode({
      accountMode: user.processingMode,
      meetingId: id,
      requireFrozenRoute: true,
      userId: user.id,
      resultRoute: freshness.result.processingRoute,
      });
      const queued = await enqueueMeetingFinalizationJob({
        meetingId: id,
        ownerUserId: user.id,
        title: freshness.result.title || getMeetingContentCopy(contentLocale).defaultTitle(id),
        contentLocale,
        processingMode,
        processingOperationKey: reprocessMeetingOperationKey(id, freshness.audio.audioRevision),
        audioRevision: freshness.audio.audioRevision,
      });
      processing = queued.processing;
    }
    return NextResponse.json({
      ok: true,
      meetingId: id,
      processing,
      result: freshness.currentResult,
    });
  } catch (error) {
    if (error instanceof MeetingAccessError) {
      return NextResponse.json(structuredMeetingAccessErrorBody(error), {
        status: error.status,
        headers: meetingAccessErrorHeaders(error),
      });
    }
    return NextResponse.json({ ok: false, error: "纪要处理状态读取失败。" }, { status: 500 });
  }
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const originResponse = authenticatedMutationOriginResponse(request);
  if (originResponse) return originResponse;
  const { id } = await context.params;
  const contentLocale = resolveMeetingContentLocale(request.headers.get("accept-language"));

  try {
    const user = await getCurrentUser();
    if (!user) {
      return NextResponse.json({ ok: false, error: "请先登录后再生成纪要。" }, { status: 401 });
    }
    const body = requirePlainRecord(await readBoundedOptionalJson(request, 64 * 1024));
    const title = body.title === undefined
      ? undefined
      : boundedString(body.title, { field: "title", maxLength: 240 });
    const force = body.force === true;
    const requestedProcessingMode = parseRequestedMeetingProcessingMode(body.processingMode);

    // A force request is a user-initiated reprocess operation, not an audio
    // revision. New clients keep this id stable while retrying the same HTTP
    // action. Build 8 and other legacy clients omit it, so the server creates
    // one per request instead of silently reusing the previous result key.
    const operationId = force
      ? resolveReprocessOperationId(body.operationId ?? request.headers.get("idempotency-key"))
      : undefined;
    const forceOperationKey = operationId ? reprocessMeetingOperationKey(id, operationId) : undefined;

    await assertMeetingOwner(id, user.id);
    const expectedLastSequence = body.expectedLastSequence ?? body.lastSequence;
    const expectedTotalBytes = body.totalBytes ?? body.expectedTotalBytes;
    if (expectedLastSequence !== undefined || expectedTotalBytes !== undefined) {
      await sealMeetingAudio({
        meetingId: id,
        ownerUserId: user.id,
        expectedLastSequence: Number(expectedLastSequence),
        totalBytes: Number(expectedTotalBytes),
      });
    }
    const freshness = await readMeetingResultFreshness(id);
    const processingMode = await resolveApiMeetingProcessingMode({
      accountMode: user.processingMode,
      meetingId: id,
      requireFrozenRoute: force,
      requestedMode: requestedProcessingMode,
      resultRoute: freshness.result?.processingRoute,
      userId: user.id,
    });
    if ((!freshness.currentResult || force) && !freshness.audio.sealed) {
      throw new MeetingAccessError("录音尚未完成完整性确认，已保留本地录音，请同步完成后重试。", 409, {
        code: "meeting_audio_not_sealed",
        retryable: true,
      });
    }
    const existingResult = freshness.currentResult;
    if (getFinalizationQueueMode() === "postgres-queue" && (!existingResult || force)) {
      const staleResult = Boolean(freshness.result && !freshness.current);
      const queued = await enqueueMeetingFinalizationJob({
        meetingId: id,
        ownerUserId: user.id,
        title: title?.trim() || freshness.result?.title || getMeetingContentCopy(contentLocale).defaultTitle(id),
        force,
        contentLocale,
        processingMode,
        processingOperationKey: forceOperationKey ?? (staleResult
          ? reprocessMeetingOperationKey(id, freshness.audio.audioRevision)
          : undefined),
        audioRevision: freshness.audio.audioRevision,
      });
      return NextResponse.json(
        {
          ok: true,
          operationId,
          processingMode,
          queued: true,
          processing: queued.processing,
          job: {
            id: queued.job.id,
            status: queued.job.status,
            attempt: queued.job.attempt,
            maxAttempts: queued.job.maxAttempts,
            availableAt: queued.job.availableAt,
          },
        },
        { status: 202 },
      );
    }

    const finalized = await finalizeMeetingForUser({
      meetingId: id,
      title,
      user,
      force,
      contentLocale,
      processingMode,
      usageOperationKey: forceOperationKey,
    });

    return NextResponse.json({
      ok: true,
      operationId,
      processingMode,
      ...finalized,
    });
  } catch (error) {
    if (error instanceof BoundedRequestError) {
      return NextResponse.json(
        { ok: false, code: error.code, error: error.message },
        { status: error.status },
      );
    }
    if (error instanceof MeetingAccessError) {
      return NextResponse.json(structuredMeetingAccessErrorBody(error), {
        status: error.status,
        headers: meetingAccessErrorHeaders(error),
      });
    }

    if (error instanceof MeetingFinalizationError) {
      return NextResponse.json(
        {
          ok: false,
          error: error.message,
          code: error.code,
          retryable: error.retryable,
          processing: error.processing,
        },
        { status: error.status },
      );
    }

    return NextResponse.json(
      {
        ok: false,
        code: "processing_failed",
        error: "正式纪要生成失败，原始音频仍已保留。请稍后重试。",
        retryable: false,
      },
      { status: 500 },
    );
  }
}

function structuredMeetingAccessErrorBody(error: MeetingAccessError) {
  return { ...meetingAccessErrorBody(error), retryable: error.retryable };
}

async function resolveApiMeetingProcessingMode(input: {
  accountMode: "official_quota" | "byok";
  meetingId: string;
  requireFrozenRoute?: boolean;
  requestedMode?: "official_quota" | "byok";
  resultRoute?: "official_quota" | "byok" | "hybrid";
  userId: string;
}) {
  // A force-regenerate action gets a fresh operation key for idempotency and
  // provider-step accounting, but it is still the same meeting. Its processing
  // mode must therefore inherit the meeting's initial binding.
  const reservation = await getMeetingProcessingReservation(
    input.userId,
    initialMeetingOperationKey(input.meetingId),
  );
  return resolveMeetingProcessingMode({
    accountMode: input.accountMode,
    frozenRoute: reservation?.processingRoute ?? input.resultRoute,
    requireFrozenRoute: input.requireFrozenRoute,
    requestedMode: input.requestedMode,
  });
}

function resolveReprocessOperationId(value: unknown) {
  if (value === undefined || value === null || value === "") return `legacy-${randomUUID()}`;
  if (typeof value !== "string") {
    throw invalidReprocessOperationId();
  }
  const operationId = value.trim();
  if (operationId.length < 8 || operationId.length > 96 || !/^[A-Za-z0-9._:-]+$/.test(operationId)) {
    throw invalidReprocessOperationId();
  }
  return operationId;
}

function invalidReprocessOperationId() {
  return new MeetingAccessError("重新生成请求标识无效，请重新发起操作。", 400, {
    code: "invalid_reprocess_operation_id",
    retryable: false,
  });
}
