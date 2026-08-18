import { NextResponse } from "next/server";
import {
  AuthError,
  claimMeetingProviderStep,
  completeMeetingProviderStep,
  getMeetingProcessingReservation,
  getProviderRuntimeConfig,
  getUserById,
  releaseMeetingProcessingReservation,
  releaseMeetingProviderStep,
  reserveMeetingRealtimeQuota,
  startMeetingProviderStep,
} from "@/lib/server/auth-repository";
import { getCurrentUser } from "@/lib/server/current-user";
import {
  classifyRealtimeSequence,
  ensureRealtimeSessionOwnership,
  readUserRealtimeSession,
  recordRealtimeSequenceAnomaly,
  recordRealtimeSessionChunk,
  recordRealtimeSessionEvent,
  RealtimeSessionAccessError,
  withRealtimeSessionLock,
} from "@/lib/server/realtime-session-store";
import { finishVolcanoRealtimeSession } from "@/lib/server/volcano-realtime-asr";
import { getProviderDiagnostic, getRealtimeTranscriptionAdapter, getTranscriptionProvider } from "@/lib/transcription-adapter";
import {
  readRealtimeChunkRequest,
  RealtimeChunkRequestError,
} from "@/lib/server/realtime-chunk-request";
import { initialMeetingOperationKey } from "@/lib/processing-route";
import { MeetingAccessError, meetingAccessErrorBody, meetingAccessErrorHeaders } from "@/lib/server/meeting-errors";
import { withMeetingWriteFence, withUserWriteLock } from "@/lib/server/meeting-write-lock";
import {
  parseRequestedMeetingProcessingMode,
  PROCESSING_MODE_HEADER,
  resolveMeetingProcessingMode,
} from "@/lib/server/meeting-processing-mode";
import type { UserProcessingMode } from "@/lib/processing-route";
import { readMeetingFinalizationState } from "@/lib/server/meeting-finalization-state";
import { authenticatedMutationOriginResponse } from "@/lib/server/sensitive-action-guard";

export const runtime = "nodejs";

type ProviderStepClaim = { claimToken: string; stepId: string };
type RealtimeProviderPlan = {
  claim: Awaited<ReturnType<typeof reserveMeetingRealtimeQuota>>;
  officialProviderStep?: ProviderStepClaim;
  provider: ReturnType<typeof getTranscriptionProvider>;
  providerRuntime: Awaited<ReturnType<typeof getProviderRuntimeConfig>>;
  processingMode: UserProcessingMode;
};

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: "请先登录后再推送实时音频。" }, { status: 401 });
  }
  const originResponse = authenticatedMutationOriginResponse(request);
  if (originResponse) return originResponse;

  let requestedProcessingMode: UserProcessingMode | undefined;
  try {
    requestedProcessingMode = parseRequestedMeetingProcessingMode(request.headers.get(PROCESSING_MODE_HEADER));
  } catch (error) {
    if (error instanceof MeetingAccessError) {
      return NextResponse.json(structuredMeetingAccessErrorBody(error), {
        status: error.status,
        headers: meetingAccessErrorHeaders(error),
      });
    }
    throw error;
  }

  let realtimeChunk;
  try {
    realtimeChunk = await readRealtimeChunkRequest(request);
  } catch (error) {
    if (error instanceof RealtimeChunkRequestError) {
      return NextResponse.json({ ok: false, error: error.message }, { status: error.status });
    }
    throw error;
  }

  const { buffer, channels, durationMs, mimeType, recordedAt, sampleRate, sequence } = realtimeChunk;

  if (!Number.isInteger(sequence) || sequence <= 0) {
    return NextResponse.json({ ok: false, error: "invalid sequence" }, { status: 400 });
  }

  if (!Number.isFinite(durationMs) || durationMs <= 0 || durationMs > 30000) {
    return NextResponse.json({ ok: false, error: "invalid durationMs" }, { status: 400 });
  }

  if (!Number.isFinite(sampleRate) || sampleRate <= 0 || sampleRate > 192000 || !Number.isInteger(channels) || channels <= 0 || channels > 2) {
    return NextResponse.json({ ok: false, error: "invalid pcm format" }, { status: 400 });
  }

  if (buffer.byteLength === 0) {
    return NextResponse.json({ ok: false, error: "empty realtime audio chunk" }, { status: 400 });
  }

  const byteCheck = validateRealtimePcmByteLength({
    byteLength: buffer.byteLength,
    channels,
    durationMs,
    mimeType,
    sampleRate,
  });
  let providerPlan: RealtimeProviderPlan | undefined;
  try {
    const preflight = await withRealtimeMutationFence(user.id, id, async () => {
      const activeUser = await requireActiveRealtimeUser(user.id, "accept realtime audio");
      const provider = getTranscriptionProvider();
      const existingSession = await readUserRealtimeSession(id, user.id);
      const operationKey = initialMeetingOperationKey(id);
      const [frozenReservation, finalizationState] = await Promise.all([
        getMeetingProcessingReservation(user.id, operationKey),
        readMeetingFinalizationState(id),
      ]);
      const processingRoute = resolveMeetingProcessingMode({
        accountMode: activeUser.processingMode,
        frozenRoute:
          frozenReservation?.processingRoute ??
          (finalizationState?.processingOperationKey === operationKey ? finalizationState.processingMode : undefined),
        requestedMode: requestedProcessingMode,
      });
      const sequenceDecision = classifyRealtimeSequence(existingSession?.highestSequence, sequence);

      if (sequenceDecision.status === "duplicate") {
        const realtimeSession = await recordRealtimeSequenceAnomaly({
          adapter: existingSession?.adapter || "realtime-sequence-validator",
          meetingId: id,
          ownerUserId: user.id,
          provider,
          sequence,
          type: "duplicate",
        });
        return { kind: "response" as const, response: NextResponse.json({
          ok: true,
          duplicate: true,
          expectedSequence: sequenceDecision.expectedSequence,
          meetingId: id,
          sequence,
          receivedBytes: buffer.byteLength,
          receivedAt: new Date().toISOString(),
          provider,
          processingMode: processingRoute,
          adapter: realtimeSession.adapter,
          diagnostic: "重复实时分片已幂等忽略，正式录音不受影响。",
          providerStatus: realtimeSession.lastProviderStatus || "accepted",
          realtimeSessionId: realtimeSession.sessionId,
          transcriptSegment: realtimeSession.lastSequence === sequence ? realtimeSession.lastTranscriptSegment : undefined,
          realtimeSession,
          realtime: realtimeResponseMetadata({
            bufferBytes: buffer.byteLength,
            byteDrift: buffer.byteLength - byteCheck.expectedBytes,
            channels,
            formatOk: byteCheck.ok,
            sampleRate,
          }),
        }) };
      }

      if (sequenceDecision.status === "out_of_order") {
        const realtimeSession = await recordRealtimeSequenceAnomaly({
          adapter: "realtime-sequence-validator",
          meetingId: id,
          ownerUserId: user.id,
          provider,
          sequence,
          type: "out_of_order",
        });
        return { kind: "response" as const, response: NextResponse.json(
          {
            ok: false,
            error: `实时分片顺序错误，当前需要第 ${sequenceDecision.expectedSequence} 片。`,
            expectedSequence: sequenceDecision.expectedSequence,
            meetingId: id,
            sequence,
            receivedBytes: buffer.byteLength,
            provider,
            processingMode: processingRoute,
            adapter: "realtime-sequence-validator",
            providerStatus: "out_of_order",
            realtimeSession,
            realtime: realtimeResponseMetadata({
              bufferBytes: buffer.byteLength,
              byteDrift: buffer.byteLength - byteCheck.expectedBytes,
              channels,
              formatOk: byteCheck.ok,
              sampleRate,
            }),
          },
          { status: 409 },
        ) };
      }

      if (!byteCheck.ok) {
        const realtimeSession = await recordRealtimeSessionChunk({
          meetingId: id,
          ownerUserId: user.id,
          sequence,
          receivedBytes: buffer.byteLength,
          durationMs,
          sampleRate,
          channels,
          provider,
          adapter: "realtime-pcm-validator",
          providerStatus: "rejected_format",
          diagnostic: "Realtime PCM byte length did not match declared sample rate, channels, and duration. Chunk was rejected and not stored for finalization.",
          byteDrift: buffer.byteLength - byteCheck.expectedBytes,
          formatOk: false,
        });

        return { kind: "response" as const, response: NextResponse.json(
          {
            ok: false,
            error: "invalid realtime pcm byte length",
            meetingId: id,
            sequence,
            receivedBytes: buffer.byteLength,
            provider,
            adapter: "realtime-pcm-validator",
            providerStatus: "rejected_format",
            realtimeSession,
            realtime: realtimeResponseMetadata({
              bufferBytes: buffer.byteLength,
              byteDrift: buffer.byteLength - byteCheck.expectedBytes,
              channels,
              formatOk: false,
              sampleRate,
            }),
          },
          { status: 422 },
        ) };
      }

      // Persist ownership before any provider-spend transition. This lets
      // meeting/account deletion establish a durable tombstone while the
      // external call is blocked, without leaving a started cost step if the
      // ownership write itself fails.
      await ensureRealtimeSessionOwnership({ meetingId: id, ownerUserId: user.id, provider });

      const configuredProviderRuntime =
        processingRoute !== "official_quota"
          ? await getProviderRuntimeConfig(user.id, "volcano-asr")
          : null;
      if (processingRoute === "byok" && !hasUserAsrRuntime(configuredProviderRuntime)) {
        throw new AuthError(
          "本场选择使用自己的模型，但语音识别配置已失效。官方额度未扣除，本地录音继续保存。",
          409,
          "byok_asr_unavailable",
        );
      }
      const providerRuntime = hasUserAsrRuntime(configuredProviderRuntime) ? configuredProviderRuntime : null;
      const usesOfficialRealtime = provider === "volcano" && processingRoute !== "byok" && !hasUserAsrRuntime(providerRuntime);
      const officialRealtimeReady = getProviderDiagnostic().capabilities?.realtimeReady === true;
      if (usesOfficialRealtime && existingSession?.adapter === "official-quota-exhausted") {
        return { kind: "response" as const, response: await respondWithOfficialQuotaExhausted({
          bufferBytes: buffer.byteLength,
          byteDrift: buffer.byteLength - byteCheck.expectedBytes,
          channels,
          durationMs,
          meetingId: id,
          ownerUserId: user.id,
          provider,
          sampleRate,
          sequence,
        }) };
      }
      let claim: Awaited<ReturnType<typeof reserveMeetingRealtimeQuota>>;
      try {
        claim = await reserveMeetingRealtimeQuota(user.id, {
          durationMs,
          meetingId: id,
          operationKey,
          processingRoute,
          sequence,
        });
      } catch (error) {
        if (error instanceof AuthError && error.status === 402) {
          return { kind: "response" as const, response: await respondWithOfficialQuotaExhausted({
            bufferBytes: buffer.byteLength,
            byteDrift: buffer.byteLength - byteCheck.expectedBytes,
            channels,
            durationMs,
            meetingId: id,
            ownerUserId: user.id,
            provider,
            sampleRate,
            sequence,
          }) };
        }
        throw error;
      }
      if (claim.duplicate) {
        return { kind: "response" as const, response: respondWithProviderSpendFenced({
          bufferBytes: buffer.byteLength,
          byteDrift: buffer.byteLength - byteCheck.expectedBytes,
          channels,
          expectedSequence: claim.expectedSequence,
          meetingId: id,
          outcome: "busy",
          provider,
          sampleRate,
          sequence,
        }) };
      }
      let officialProviderStep: ProviderStepClaim | undefined;
      if (usesOfficialRealtime && officialRealtimeReady) {
        const providerStepClaim = await claimMeetingProviderStep(user.id, {
          reservationId: claim.id,
          stage: { type: "realtime_asr", sequence },
        });
        if (providerStepClaim.outcome !== "claimed" || !providerStepClaim.claimToken) {
          return { kind: "response" as const, response: respondWithProviderSpendFenced({
            bufferBytes: buffer.byteLength,
            byteDrift: buffer.byteLength - byteCheck.expectedBytes,
            channels,
            expectedSequence: claim.expectedSequence,
            meetingId: id,
            outcome: providerStepClaim.outcome,
            provider,
            sampleRate,
            sequence,
          }) };
        }
        officialProviderStep = { claimToken: providerStepClaim.claimToken, stepId: providerStepClaim.step.id };
        try {
          const started = await startMeetingProviderStep(user.id, officialProviderStep);
          if (started.outcome !== "started") {
            return { kind: "response" as const, response: respondWithProviderSpendFenced({
              bufferBytes: buffer.byteLength,
              byteDrift: buffer.byteLength - byteCheck.expectedBytes,
              channels,
              expectedSequence: claim.expectedSequence,
              meetingId: id,
              outcome: started.outcome,
              provider,
              sampleRate,
              sequence,
            }) };
          }
        } catch (error) {
          await releaseMeetingProviderStep(user.id, officialProviderStep).catch(() => undefined);
          throw error;
        }
      }

      return {
        kind: "provider" as const,
        plan: {
          claim,
          officialProviderStep,
          provider,
          providerRuntime,
          processingMode: processingRoute,
        },
      };
    });

    if (preflight.kind === "response") return preflight.response;
    providerPlan = preflight.plan;
    const adapter = getRealtimeTranscriptionAdapter();
    const transcription = await adapter.acceptChunk({
      buffer,
      channels,
      providerRuntime: providerPlan.providerRuntime,
      meetingId: id,
      ownerUserId: user.id,
      sequence,
      mimeType,
      savedBytes: buffer.byteLength,
      recordedAt,
      durationMs,
      sampleRate,
    });

    return await withRealtimeMutationFence(user.id, id, async () => {
      await requireActiveRealtimeUser(user.id, "publish realtime audio");
      const realtimeSession = await recordRealtimeSessionChunk({
        meetingId: id,
        ownerUserId: user.id,
        sequence,
        receivedBytes: buffer.byteLength,
        durationMs,
        sampleRate,
        channels,
        provider: providerPlan!.provider,
        adapter: transcription.adapter,
        sessionId: transcription.sessionId,
        providerStatus: transcription.providerStatus,
        diagnostic: transcription.diagnostic,
        transcriptSegment: transcription.transcriptSegment,
        byteDrift: buffer.byteLength - byteCheck.expectedBytes,
        formatOk: true,
      });
      if (providerPlan!.officialProviderStep) {
        const completed = await completeMeetingProviderStep(user.id, providerPlan!.officialProviderStep);
        if (completed.outcome !== "completed") {
          throw new AuthError("实时识别结果已保存，但 Provider 结算状态需要人工核对。", 409, "provider_step_uncertain");
        }
      }

      return NextResponse.json({
        ok: true,
        duplicate: false,
        expectedSequence: sequence + 1,
        meetingId: id,
        sequence,
        receivedBytes: buffer.byteLength,
        receivedAt: new Date().toISOString(),
        provider: providerPlan!.provider,
        processingMode: providerPlan!.processingMode,
        adapter: transcription.adapter,
        diagnostic: transcription.diagnostic,
        providerStatus: transcription.providerStatus,
        realtimeSessionId: transcription.sessionId,
        transcriptSegment: transcription.transcriptSegment,
        realtimeSession,
        realtime: realtimeResponseMetadata({
          bufferBytes: buffer.byteLength,
          byteDrift: buffer.byteLength - byteCheck.expectedBytes,
          channels,
          formatOk: true,
          sampleRate,
        }),
      });
    });
  } catch (error) {
    if (providerPlan && isDeletionBarrier(error)) {
      await reconcileAbandonedRealtimeProviderStep(user.id, providerPlan).catch((reconciliationError) => {
        console.error("Realtime provider deletion reconciliation needs retry.", {
          errorType: reconciliationError instanceof Error ? reconciliationError.name : "unknown",
        });
      });
    }
    if (error instanceof AuthError) {
      return NextResponse.json(
        {
          ok: false,
          code: error.code || "official_quota_rejected",
          error: error.message,
          retryable: error.status >= 500,
          providerStatus: "provider_error",
          diagnostic: "实时识别已停止调用官方服务；本地完整录音不受影响。",
        },
        { status: error.status },
      );
    }
    if (error instanceof RealtimeSessionAccessError) {
      return NextResponse.json({ ok: false, error: error.message }, { status: error.status });
    }
    if (error instanceof MeetingAccessError) {
      return NextResponse.json(structuredMeetingAccessErrorBody(error), {
        status: error.status,
        headers: meetingAccessErrorHeaders(error),
      });
    }
    throw error;
  }
}

function respondWithProviderSpendFenced(input: {
  bufferBytes: number;
  byteDrift: number;
  channels: number;
  expectedSequence: number;
  meetingId: string;
  outcome: string;
  provider: "mock" | "openai" | "volcano";
  sampleRate: number;
  sequence: number;
}) {
  const diagnostic = input.outcome === "completed"
    ? "该实时分片已经完成识别，已阻止重复调用付费服务。"
    : "该实时分片的付费调用正在处理或结果待核对，已阻止自动重试；本地完整录音不受影响。";
  return NextResponse.json({
    ok: true,
    duplicate: true,
    expectedSequence: input.expectedSequence,
    meetingId: input.meetingId,
    sequence: input.sequence,
    receivedBytes: input.bufferBytes,
    receivedAt: new Date().toISOString(),
    provider: input.provider,
    adapter: "official-cost-fence",
    providerStatus: input.outcome === "completed" ? "accepted" : "reconnecting",
    diagnostic,
    realtime: {
      byteDrift: input.byteDrift,
      channels: input.channels,
      expectedBytes: input.bufferBytes - input.byteDrift,
      formatOk: true,
      sampleRate: input.sampleRate,
      storedForFinalization: false,
    },
  });
}

async function withRealtimeMutationFence<T>(
  userId: string,
  meetingId: string,
  operation: () => Promise<T>,
) {
  // Every phase takes locks in exactly one order. The provider network call is
  // intentionally outside this helper.
  return withUserWriteLock(userId, () =>
    withRealtimeSessionLock(meetingId, () =>
      withMeetingWriteFence(meetingId, operation),
    ),
  );
}

async function requireActiveRealtimeUser(userId: string, action: string) {
  const activeUser = await getUserById(userId);
  if (activeUser) return activeUser;
  throw new MeetingAccessError(`This account was deleted and cannot ${action}.`, 410, {
    code: "account_deleted",
    retryable: false,
  });
}

function isDeletionBarrier(error: unknown) {
  return error instanceof MeetingAccessError &&
    (error.code === "meeting_deleted" || error.code === "account_deleted");
}

async function reconcileAbandonedRealtimeProviderStep(userId: string, plan: RealtimeProviderPlan) {
  const providerStep = plan.officialProviderStep;
  if (providerStep) {
    // The provider already returned before the deletion barrier won. Preserve
    // the real incurred cost instead of refunding it; only publication is
    // discarded. Account deletion will archive the completed aggregate.
    const completed = await completeMeetingProviderStep(userId, providerStep);
    if (completed.outcome !== "completed") {
      throw new AuthError(
        "Realtime provider spend could not be reconciled after deletion.",
        409,
        "provider_step_completion_pending",
      );
    }
  }
  // Meeting deletion keeps the account active, so release the now-unused
  // reservation immediately. Account deletion owns ledger archival and may
  // remove this reservation before this best-effort call reaches it.
  await releaseMeetingProcessingReservation(userId, { reservationId: plan.claim.id }).catch(() => undefined);
}

function realtimeResponseMetadata(input: {
  bufferBytes: number;
  byteDrift: number;
  channels: number;
  formatOk: boolean;
  sampleRate: number;
}) {
  return {
    byteDrift: input.byteDrift,
    channels: input.channels,
    expectedBytes: input.bufferBytes - input.byteDrift,
    formatOk: input.formatOk,
    sampleRate: input.sampleRate,
    storedForFinalization: false,
  };
}

function hasUserAsrRuntime(runtime: Awaited<ReturnType<typeof getProviderRuntimeConfig>>) {
  if (!runtime) return false;
  return Boolean(runtime.secrets.VOLCANO_ASR_API_KEY || (runtime.fields.VOLCANO_ASR_APP_ID && runtime.secrets.VOLCANO_ASR_TOKEN));
}

async function respondWithOfficialQuotaExhausted(input: {
  bufferBytes: number;
  byteDrift: number;
  channels: number;
  durationMs: number;
  meetingId: string;
  ownerUserId: string;
  provider: ReturnType<typeof getTranscriptionProvider>;
  sampleRate: number;
  sequence: number;
}) {
  const diagnostic = "官方额度已用完，已停止实时识别计费；本地完整录音继续保存。";
  const realtimeSession = await recordRealtimeSessionChunk({
    meetingId: input.meetingId,
    ownerUserId: input.ownerUserId,
    sequence: input.sequence,
    receivedBytes: input.bufferBytes,
    durationMs: input.durationMs,
    sampleRate: input.sampleRate,
    channels: input.channels,
    provider: input.provider,
    adapter: "official-quota-exhausted",
    providerStatus: "provider_error",
    diagnostic,
    byteDrift: input.byteDrift,
    formatOk: true,
  });
  return NextResponse.json({
    ok: true,
    code: "official_quota_insufficient",
    duplicate: false,
    expectedSequence: input.sequence + 1,
    meetingId: input.meetingId,
    sequence: input.sequence,
    receivedBytes: input.bufferBytes,
    provider: input.provider,
    adapter: realtimeSession.adapter,
    providerStatus: "provider_error",
    diagnostic,
    realtimeSession,
    realtime: {
      byteDrift: input.byteDrift,
      channels: input.channels,
      expectedBytes: input.bufferBytes - input.byteDrift,
      formatOk: true,
      sampleRate: input.sampleRate,
      storedForFinalization: false,
    },
  });
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: "请先登录后再结束实时识别。" }, { status: 401 });
  }
  const originResponse = authenticatedMutationOriginResponse(request);
  if (originResponse) return originResponse;

  try {
    const preflight = await withRealtimeMutationFence(user.id, id, async () => {
      const activeUser = await requireActiveRealtimeUser(user.id, "finish realtime audio");
      const provider = getTranscriptionProvider();
      await readUserRealtimeSession(id, user.id);
      const reservation = await getMeetingProcessingReservation(user.id, initialMeetingOperationKey(id));
      const processingRoute = reservation?.processingRoute ?? activeUser.processingMode;
      const providerRuntime =
        provider === "volcano" && processingRoute !== "official_quota"
          ? await getProviderRuntimeConfig(user.id, "volcano-asr")
          : null;
      return { provider, providerRuntime };
    });

    // Finishing a provider stream can block on the network. Keep every user
    // and meeting advisory lock out of this section so deletion remains fast.
    const result =
      preflight.provider === "volcano"
        ? await finishVolcanoRealtimeSession({ meetingId: id, ownerUserId: user.id, providerRuntime: preflight.providerRuntime })
        : {
            diagnostic: "No external realtime provider session needed to be closed.",
            providerStatus: "completed" as const,
            sessionId: `rt-${id}`,
            transcriptSegment: undefined,
          };

    return await withRealtimeMutationFence(user.id, id, async () => {
      await requireActiveRealtimeUser(user.id, "publish realtime completion");
      const realtimeSession = await recordRealtimeSessionEvent({
        meetingId: id,
        ownerUserId: user.id,
        provider: preflight.provider,
        adapter: preflight.provider === "volcano" ? "volcano-realtime-adapter" : `${preflight.provider}-realtime-adapter`,
        sessionId: result.sessionId,
        providerStatus: result.providerStatus,
        diagnostic: result.diagnostic,
        transcriptSegment: result.transcriptSegment,
      });

      return NextResponse.json({
        ok: result.providerStatus !== "provider_error",
        meetingId: id,
        provider: preflight.provider,
        providerStatus: result.providerStatus,
        realtimeSessionId: result.sessionId,
        transcriptSegment: result.transcriptSegment,
        diagnostic: result.diagnostic,
        realtimeSession,
        realtime: { storedForFinalization: false },
      });
    });
  } catch (error) {
    if (error instanceof RealtimeSessionAccessError) {
      return NextResponse.json({ ok: false, error: error.message }, { status: error.status });
    }
    if (error instanceof MeetingAccessError) {
      return NextResponse.json(structuredMeetingAccessErrorBody(error), {
        status: error.status,
        headers: meetingAccessErrorHeaders(error),
      });
    }
    throw error;
  }
}

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  const user = await getCurrentUser();
  if (!user) {
    return NextResponse.json({ ok: false, error: "请先登录后再查看实时识别状态。" }, { status: 401 });
  }

  try {
    const realtimeSession = await readUserRealtimeSession(id, user.id);
    if (!realtimeSession) {
      return NextResponse.json({ ok: false, error: "realtime_session_not_found" }, { status: 404 });
    }

    return NextResponse.json({
      ok: true,
      meetingId: id,
      realtimeSession,
    });
  } catch (error) {
    if (error instanceof RealtimeSessionAccessError) {
      return NextResponse.json({ ok: false, error: error.message }, { status: error.status });
    }
    if (error instanceof MeetingAccessError) {
      return NextResponse.json(structuredMeetingAccessErrorBody(error), {
        status: error.status,
        headers: meetingAccessErrorHeaders(error),
      });
    }

    return NextResponse.json({ ok: false, error: error instanceof Error ? error.message : "failed to read realtime session" }, { status: 500 });
  }
}

function structuredMeetingAccessErrorBody(error: MeetingAccessError) {
  return { ...meetingAccessErrorBody(error), retryable: error.retryable };
}

function validateRealtimePcmByteLength(input: {
  byteLength: number;
  channels: number;
  durationMs: number;
  mimeType: string;
  sampleRate: number;
}) {
  if (!input.mimeType.toLowerCase().includes("pcm")) {
    return {
      expectedBytes: input.byteLength,
      ok: true,
    };
  }

  const bytesPerSample = 2;
  const expectedBytes = Math.round((input.sampleRate * input.channels * bytesPerSample * input.durationMs) / 1000);
  const drift = Math.abs(input.byteLength - expectedBytes);
  const tolerance = Math.max(4096, Math.round(expectedBytes * 0.2));

  return {
    expectedBytes,
    ok: drift <= tolerance,
  };
}
