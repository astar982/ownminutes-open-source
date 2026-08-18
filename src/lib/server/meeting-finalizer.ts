import { createHash, randomUUID } from "node:crypto";
import { assessMeetingResultQuality, canReuseFormalTranscript } from "@/lib/meeting-result-quality";
import { getOfficialTurboFallbackDecision, isOfficialVolcanoTranscriptionProvider } from "@/lib/asr-cost-policy";
import {
  processMeetingAudio,
  requiresMeetingAudioForProcessing,
  type MeetingProviderRuntime,
  type MeetingProviderStage,
} from "@/lib/meeting-processing";
import {
  calculateMeetingUsage,
  initialMeetingOperationKey,
  reprocessMeetingOperationKey,
  type MeetingProcessingRoute,
} from "@/lib/processing-route";
import { selectReusableRealtimeTranscript } from "@/lib/realtime-transcript-reuse";
import { getVolcanoFileAsrDiagnostic } from "@/lib/volcano-asr";
import {
  AuthError,
  claimMeetingProviderStep,
  completeMeetingProviderStep,
  getMeetingProcessingReservation,
  getProviderRuntimeConfig,
  getUserUsage,
  recordMeetingFinalizeUsage,
  reconcileMeetingProviderStep,
  rejectMeetingProviderStep,
  releaseMeetingProcessingReservation,
  releaseMeetingProviderStep,
  reserveMeetingFinalizationQuota,
  startMeetingProviderStep,
  type SafeUser,
  type UserProcessingMode,
} from "@/lib/server/auth-repository";
import {
  assertMeetingOwner,
  MeetingAccessError,
  prepareMeetingAudioSnapshot,
  readMeetingResult,
  readMeetingResultFreshness,
  saveMeetingResult,
} from "@/lib/server/meeting-audio-store";
import { readMeetingProcessingCheckpoint, saveMeetingProcessingCheckpoint } from "@/lib/server/meeting-processing-checkpoint";
import { readUserRealtimeSession } from "@/lib/server/realtime-session-store";
import {
  completeMeetingFinalization,
  failMeetingFinalization,
  isFinalizationLeaseActive,
  readMeetingFinalizationState,
  startMeetingFinalization,
  type MeetingFinalizationState,
} from "@/lib/server/meeting-finalization-state";
import { classifyFinalizationFailure } from "@/lib/server/finalization-error-policy";
import { canonicalMeetingId, withMeetingWriteFence } from "@/lib/server/meeting-write-lock";
import {
  DEFAULT_MEETING_CONTENT_LOCALE,
  getMeetingContentCopy,
  type MeetingContentLocale,
} from "@/lib/meeting-content-locale";
import { resolveMeetingProcessingMode } from "@/lib/server/meeting-processing-mode";

const activeFinalizations = new Map<string, {
  processingMode: UserProcessingMode;
  promise: Promise<MeetingFinalizationResult>;
}>();
const DEFAULT_LEASE_MS = 15 * 60 * 1000;

export type MeetingFinalizationResult = {
  result: NonNullable<Awaited<ReturnType<typeof readMeetingResult>>>;
  processing: MeetingFinalizationState;
  usage: Awaited<ReturnType<typeof getUserUsage>>;
  idempotent: boolean;
  billing: {
    processingRoute: MeetingProcessingRoute;
    processedMinutes: number;
    officialMinutesCharged: number;
  };
};

export class MeetingFinalizationError extends Error {
  status: number;
  code: string;
  retryable: boolean;
  processing?: MeetingFinalizationState;

  constructor(input: {
    message: string;
    status?: number;
    code?: string;
    retryable?: boolean;
    processing?: MeetingFinalizationState;
  }) {
    super(input.message);
    this.status = input.status ?? 500;
    this.code = input.code ?? "processing_failed";
    this.retryable = input.retryable ?? this.status >= 500;
    this.processing = input.processing;
  }
}

export async function finalizeMeetingForUser(input: {
  meetingId: string;
  title?: string;
  user: SafeUser;
  force?: boolean;
  contentLocale?: MeetingContentLocale;
  usageOperationKey?: string;
  processingMode?: UserProcessingMode;
  assertProcessingLease?: () => Promise<void>;
}) {
  const meetingId = canonicalMeetingId(input.meetingId);
  const canonicalInput = input.meetingId === meetingId ? input : { ...input, meetingId };
  const key = `${input.user.id}:${meetingId}:${input.usageOperationKey || (input.force ? "force" : "initial")}`;
  const active = activeFinalizations.get(key);
  const requestedProcessingMode = input.processingMode ?? input.user.processingMode;
  if (active) {
    if (active.processingMode !== requestedProcessingMode) {
      throw new MeetingFinalizationError({
        message: "这场会议的处理方式已在开始时固定，不能在重试时更换。",
        status: 409,
        code: "meeting_processing_mode_conflict",
        retryable: false,
      });
    }
    return active.promise;
  }

  const operation = runMeetingFinalization(canonicalInput).finally(() => {
    if (activeFinalizations.get(key)?.promise === operation) activeFinalizations.delete(key);
  });
  activeFinalizations.set(key, { processingMode: requestedProcessingMode, promise: operation });
  return operation;
}

async function runMeetingFinalization(input: {
  meetingId: string;
  title?: string;
  user: SafeUser;
  force?: boolean;
  contentLocale?: MeetingContentLocale;
  usageOperationKey?: string;
  processingMode?: UserProcessingMode;
  assertProcessingLease?: () => Promise<void>;
}): Promise<MeetingFinalizationResult> {
  // Keep only the state transition and idempotency decision under the meeting
  // fence. Provider requests and audio preparation happen after this short
  // preflight, so DELETE never waits for an external ASR/summary timeout.
  const preflight = await withMeetingWriteFence(input.meetingId, async () => {
    await assertMeetingOwner(input.meetingId, input.user.id);
    const [freshness, existingState] = await Promise.all([
      readMeetingResultFreshness(input.meetingId),
      readMeetingFinalizationState(input.meetingId),
    ]);
    const { audio, result: existingResult } = freshness;
    const contentLocale = input.contentLocale ?? DEFAULT_MEETING_CONTENT_LOCALE;
    const title = input.title?.trim() || existingResult?.title || getMeetingContentCopy(contentLocale).defaultTitle(input.meetingId);
    const existingResultMatchesCurrentAudio = freshness.current;
    const staleExistingResult = Boolean(existingResult && !existingResultMatchesCurrentAudio);

    if (existingResult && !input.force && existingResultMatchesCurrentAudio) {
      const route = existingResult.processingRoute ?? "official_quota";
      const calculated = calculateMeetingUsage({ durationMs: audio.durationMs, route });
      const billing = {
        processingRoute: route,
        processedMinutes: existingResult.processedMinutes ?? calculated.processedMinutes,
        officialMinutesCharged: existingResult.officialMinutesCharged ?? calculated.officialMinutesCharged,
      };
      const resultOperationKey = existingResult.processingOperationKey || initialMeetingOperationKey(input.meetingId);
      const resultIsReprocess = resultOperationKey.startsWith(`meeting:${input.meetingId}:reprocess:`);
      const usage = await recordMeetingFinalizeUsage(input.user.id, {
        meetingId: input.meetingId,
        durationMs: audio.durationMs,
        route,
        resultGeneratedAt: existingResult.generatedAt,
        isReprocess: resultIsReprocess,
        nonBillable: existingResult.provider === "mock",
        reservationOperationKey: resultOperationKey,
      });
      const processing = await completeExistingResult({
        audioRevision: audio.audioRevision,
        existingState,
        meetingId: input.meetingId,
        ownerUserId: input.user.id,
        result: existingResult,
        processingOperationKey: resultOperationKey,
        title,
      });
      return { complete: true as const, value: { result: existingResult, processing, usage, billing, idempotent: true } };
    }

    if (!audio.sealed) {
      throw new MeetingFinalizationError({
        message: "录音尚未完成完整性确认，已保留本地录音，请同步完成后重试。",
        status: 409,
        code: "meeting_audio_not_sealed",
        retryable: true,
        processing: existingState ?? undefined,
      });
    }

    if (isFinalizationLeaseActive(existingState)) {
      throw new MeetingFinalizationError({
        message: "这场会议正在生成正式纪要，请稍后查看会议历史；若处理进程中断，可在租约过期后重试。",
        status: 409,
        code: "processing_in_progress",
        retryable: true,
        processing: existingState ?? undefined,
      });
    }

    const retryingChangedAudio = existingState?.error?.code === "audio_revision_changed";
    const revisionReprocess = staleExistingResult || retryingChangedAudio;
    const operationKey =
      input.usageOperationKey ||
      (revisionReprocess
        ? reprocessMeetingOperationKey(input.meetingId, audio.audioRevision)
        : input.force
          ? reprocessMeetingOperationKey(input.meetingId, `legacy-${randomUUID()}`)
          : initialMeetingOperationKey(input.meetingId));
    const isReprocess = input.force === true || revisionReprocess;
    const existingReservation = await getMeetingProcessingReservation(input.user.id, operationKey);
    const route = resolveMeetingProcessingMode({
      accountMode: input.user.processingMode,
      frozenRoute:
        existingReservation?.processingRoute ??
        (existingState?.processingOperationKey === operationKey ? existingState.processingMode : undefined),
      requestedMode: input.processingMode,
    });
    const runtime = route === "official_quota"
      ? undefined
      : normalizeUserProviderRuntime(await buildUserProviderRuntime(input.user.id));
    if (route === "byok" && (!hasUserAsrRuntime(runtime) || !hasUserSummaryRuntime(runtime))) {
      throw new MeetingFinalizationError({
        message: "本场选择使用自己的模型，但语音识别或纪要总结配置已失效。官方额度未扣除，请修复配置后重试。",
        status: 409,
        code: "byok_configuration_incomplete",
        retryable: false,
      });
    }

    if (existingResultMatchesCurrentAudio && existingResult?.processingOperationKey === operationKey) {
      const reservation = await reserveFinalizationQuotaOrThrow({
        durationMs: audio.durationMs,
        meetingId: input.meetingId,
        operationKey,
        processingRoute: route,
        userId: input.user.id,
      });
      const usage = await recordMeetingFinalizeUsage(input.user.id, {
        meetingId: input.meetingId,
        durationMs: audio.durationMs,
        route,
        resultGeneratedAt: existingResult.generatedAt,
        isReprocess,
        nonBillable: existingResult.provider === "mock",
        reservationId: reservation.id,
        reservationOperationKey: operationKey,
      });
      const calculatedUsage = calculateMeetingUsage({ durationMs: audio.durationMs, route });
      const processing = await completeExistingResult({
        audioRevision: audio.audioRevision,
        existingState,
        meetingId: input.meetingId,
        ownerUserId: input.user.id,
        result: existingResult,
        processingOperationKey: operationKey,
        processingMode: route,
        title,
      });
      return {
        complete: true as const,
        value: {
          result: existingResult,
          processing,
          usage,
          billing: {
            processingRoute: route,
            processedMinutes: calculatedUsage.processedMinutes,
            officialMinutesCharged: reservation.officialMinutesReserved,
          },
          idempotent: true,
        },
      };
    }

    let processing: MeetingFinalizationState;
    try {
      processing = await startMeetingFinalization({
        audioRevision: audio.audioRevision,
        meetingId: input.meetingId,
        ownerUserId: input.user.id,
        processingOperationKey: operationKey,
        processingMode: route,
        title,
        leaseMs: getFinalizationLeaseMs(),
      });
    } catch (error) {
      throw normalizeFinalizationError(error);
    }
    return {
      complete: false as const,
      audio,
      contentLocale,
      existingResult,
      existingResultMatchesCurrentAudio,
      isReprocess,
      operationKey,
      processing,
      route,
      runtime,
      title,
    };
  });

  if (preflight.complete) return preflight.value;
  const {
    audio,
    contentLocale,
    existingResult,
    existingResultMatchesCurrentAudio,
    isReprocess,
    operationKey,
    processing,
    route,
    runtime,
    title,
  } = preflight;

  const audioSnapshot = await prepareMeetingAudioSnapshot(input.meetingId).catch((error) =>
    failStartedFinalization(processing, error),
  );
  let durableCheckpoint = await readMeetingProcessingCheckpoint({
    audioSha256: audioSnapshot.audioSha256,
    meetingId: input.meetingId,
    operationKey,
    ownerUserId: input.user.id,
  }).catch((error) => failStartedFinalization(processing, error, audioSnapshot.cleanup));
  const authoritativeDurationMs = audioSnapshot.durationMs;
  const existingTranscriptMatchesAudio = Boolean(existingResult && existingResultMatchesCurrentAudio) &&
    (existingResult?.audioSha256 ? existingResult.audioSha256 === audioSnapshot.audioSha256 : true);
  const existingFormalTranscript = input.force && existingResult && existingTranscriptMatchesAudio && canReuseFormalTranscript(existingResult)
    ? {
        adapter: existingResult.adapter,
        diagnostic: "Reused the existing formal transcript for summary-only reprocessing and skipped duplicate file ASR.",
        noSpeech: false,
        transcript: existingResult.transcript,
      }
    : undefined;
  let realtimeSession: Awaited<ReturnType<typeof readUserRealtimeSession>> = null;
  try {
    realtimeSession = durableCheckpoint || existingFormalTranscript ? null : await readUserRealtimeSession(input.meetingId, input.user.id);
  } catch (error) {
    await failStartedFinalization(processing, error, audioSnapshot.cleanup);
  }
  const realtimeReuse = selectReusableRealtimeTranscript({ audioDurationMs: authoritativeDurationMs, session: realtimeSession });
  const preferredTranscript = durableCheckpoint
    ? {
        adapter: durableCheckpoint.adapter,
        diagnostic: "Reused the durable ASR checkpoint and skipped a duplicate provider transcription call.",
        noSpeech: durableCheckpoint.noSpeech,
        transcript: durableCheckpoint.transcript,
      }
    : existingFormalTranscript
      ? existingFormalTranscript
      : realtimeReuse.reusable
      ? {
          adapter: "volcano-realtime-reuse",
          diagnostic: `Reused the complete realtime transcript and skipped duplicate file ASR (coverage ${(realtimeReuse.coverageRatio * 100).toFixed(1)}%).`,
          noSpeech: false,
          transcript: realtimeReuse.transcript,
        }
      : undefined;
  const preferredSummary = durableCheckpoint?.summary
    ? {
        diagnostic: "Reused the durable summary checkpoint and skipped a duplicate provider summary call.",
        summary: durableCheckpoint.summary,
      }
    : undefined;
  if (!preferredTranscript && isOfficialVolcanoTranscriptionProvider()) {
    const fileAsr = getVolcanoFileAsrDiagnostic(runtime?.volcanoAsr);
    if (!fileAsr.ready) {
      await failStartedFinalization(
        processing,
        new MeetingFinalizationError({
          message: "会后识别服务尚未配置完成，未扣除官方额度；本地完整录音仍已保留。",
          status: 503,
          code: "file_asr_not_configured",
          retryable: true,
        }),
        audioSnapshot.cleanup,
      );
    }
    if (!hasUserAsrRuntime(runtime)) {
      const turboFallback = getOfficialTurboFallbackDecision(authoritativeDurationMs);
      if (!turboFallback.allowed) {
        await failStartedFinalization(
          processing,
          new MeetingFinalizationError({
            message:
              turboFallback.reason === "disabled"
                ? "为避免产生不可控的高价识别费用，本场会议没有自动使用 Turbo；本地完整录音仍已保留，可配置 BYOK 或等待低价识别恢复后重试。"
                : turboFallback.reason === "invalid_duration"
                  ? "当前无法确认录音时长，为避免产生不可控的高价识别费用，没有自动使用 Turbo；本地完整录音仍已保留。"
                : `本场会议超过 ${turboFallback.maxAudioMinutes} 分钟的 Turbo 成本上限，没有自动调用高价识别；本地完整录音仍已保留，可配置 BYOK 或等待低价识别恢复后重试。`,
            status: 409,
            code: "turbo_fallback_cost_cap",
            retryable: false,
          }),
          audioSnapshot.cleanup,
        );
      }
    }
  }

  let preparedAudio: Awaited<ReturnType<typeof audioSnapshot.prepareForAsr>> | undefined;
  let reservation: Awaited<ReturnType<typeof reserveMeetingFinalizationQuota>> | undefined;
  let providerFence: ReturnType<typeof createProviderStepFence> | undefined;
  try {
    preparedAudio = requiresMeetingAudioForProcessing() && !preferredTranscript
      ? await audioSnapshot.prepareForAsr()
      : undefined;
    reservation = await reserveFinalizationQuotaOrThrow({
      durationMs: authoritativeDurationMs,
      meetingId: input.meetingId,
      operationKey,
      processingRoute: route,
      userId: input.user.id,
    });
    const calculatedUsage = calculateMeetingUsage({ durationMs: authoritativeDurationMs, route });
    const billing = {
      processingRoute: route,
      processedMinutes: calculatedUsage.processedMinutes,
      officialMinutesCharged: reservation.officialMinutesSettled,
    };
    providerFence = createProviderStepFence({
      assertProcessingLease: input.assertProcessingLease,
      meetingId: input.meetingId,
      reservationId: reservation.id,
      userId: input.user.id,
    });
    if (durableCheckpoint) {
      for (const stage of durableCheckpoint.providerStages) await providerFence.reconcile(stage);
    }
    let cleanupFailed = false;
    let processedResult: Awaited<ReturnType<typeof processMeetingAudio>>;
    try {
      processedResult = await processMeetingAudio({
        meetingId: input.meetingId,
        title,
        audio: {
          audioUrl: preparedAudio?.audioUrl,
          buffer: preparedAudio?.buffer,
          delivery: preparedAudio?.delivery,
          mimeType: preparedAudio?.mimeType ?? audio.mimeType,
          fileName: preparedAudio?.fileName ?? audio.fileName,
          durationMs: authoritativeDurationMs,
          transcoded: preparedAudio?.transcoded,
        },
        runtime,
        providerPolicy: {
          asrMaxAttempts: hasUserAsrRuntime(runtime) ? undefined : 1,
          summaryMaxAttempts: hasUserSummaryRuntime(runtime) ? undefined : 1,
        },
        contentLocale,
        preferredTranscript,
        preferredSummary,
        onProviderStageStart: providerFence.start,
        onProviderStageComplete: providerFence.complete,
        onProviderStageRejected: providerFence.reject,
        onTranscriptReady: async (transcriptCheckpoint) => {
          const nextCheckpoint = {
            ...transcriptCheckpoint,
            audioSha256: audioSnapshot.audioSha256,
            createdAt: new Date().toISOString(),
            meetingId: input.meetingId,
            operationKey,
            ownerUserId: input.user.id,
            providerStages: ["asr" as const],
            summary: undefined,
          };
          await saveMeetingProcessingCheckpoint(nextCheckpoint);
          durableCheckpoint = nextCheckpoint;
        },
        onSummaryReady: async ({ summary }) => {
          const transcriptCheckpoint = durableCheckpoint ?? (preferredTranscript
              ? {
                adapter: preferredTranscript.adapter,
                audioSha256: audioSnapshot.audioSha256,
                createdAt: new Date().toISOString(),
                meetingId: input.meetingId,
                noSpeech: preferredTranscript.noSpeech === true,
                operationKey,
                ownerUserId: input.user.id,
                providerStages: [],
                transcript: preferredTranscript.transcript,
              }
            : null);
          if (!transcriptCheckpoint) {
            throw new Error("Summary checkpoint cannot be written before a durable transcript exists.");
          }
          const nextCheckpoint = {
            ...transcriptCheckpoint,
            audioSha256: audioSnapshot.audioSha256,
            providerStages: [...new Set([...transcriptCheckpoint.providerStages, "summary" as const])],
            summary,
          };
          await saveMeetingProcessingCheckpoint(nextCheckpoint);
          durableCheckpoint = nextCheckpoint;
        },
      });
    } finally {
      cleanupFailed = await audioSnapshot.cleanup().then(() => false, () => true);
      preparedAudio = undefined;
    }
    if (cleanupFailed) {
      cleanupFailed = await audioSnapshot.cleanup().then(() => false, () => true);
    }
    if (cleanupFailed) {
      processedResult.diagnostics.push("Temporary private ASR input cleanup did not complete; storage lifecycle cleanup is required.");
    }
    return await withMeetingWriteFence(input.meetingId, async () => {
      // Publish is one short, deletion-linearized critical section. If DELETE
      // won while the provider was running, no result, usage, or finalization
      // state can be recreated after the tombstone.
      await input.assertProcessingLease?.();
      await assertMeetingOwner(input.meetingId, input.user.id);
      const settledReservation = await reserveFinalizationQuotaOrThrow({
        durationMs: authoritativeDurationMs,
        meetingId: input.meetingId,
        operationKey,
        processingRoute: route,
        userId: input.user.id,
      });
      billing.officialMinutesCharged = settledReservation.officialMinutesSettled;
      const result = {
        ...processedResult,
        audioRevision: audioSnapshot.audioRevision,
        audioSha256: audioSnapshot.audioSha256,
        processingRoute: billing.processingRoute,
        processedMinutes: billing.processedMinutes,
        officialMinutesCharged: billing.officialMinutesCharged,
        processingOperationKey: operationKey,
      };
      await saveMeetingResult(input.meetingId, result, { expectedAudioRevision: audioSnapshot.audioRevision });
      const usage = await recordMeetingFinalizeUsage(input.user.id, {
        meetingId: input.meetingId,
        durationMs: authoritativeDurationMs,
        route: billing.processingRoute,
        resultGeneratedAt: result.generatedAt,
        isReprocess,
        nonBillable: processedResult.provider === "mock",
        reservationId: settledReservation.id,
        reservationOperationKey: operationKey,
      });
      const quality = assessMeetingResultQuality(result);
      const completed = await completeMeetingFinalization({
        state: processing,
        resultGeneratedAt: result.generatedAt,
        qualityStatus: quality.status,
      });
      return { result, processing: completed, usage, billing, idempotent: false };
    });
  } catch (error) {
    await audioSnapshot.cleanup().catch(() => undefined);
    if (error instanceof MeetingAccessError && error.code === "meeting_deleted") {
      // The provider may have returned after DELETE won the meeting fence. Its
      // output must not be written, but the already-settled provider cost must
      // also not remain `started` forever. Complete only claims created by this
      // in-flight call; no missing step is created and no provider is retried.
      await providerFence?.completeDiscardedAfterMeetingDeletion().catch((reconciliationError: unknown) => {
        console.error("Provider cost reconciliation after meeting deletion failed.", {
          errorType: reconciliationError instanceof Error ? reconciliationError.name : typeof reconciliationError,
          meetingIdHash: createHash("sha256").update(input.meetingId).digest("hex").slice(0, 12),
        });
      });
    }
    if (reservation) {
      await releaseMeetingProcessingReservation(input.user.id, { reservationId: reservation.id }).catch(() => undefined);
    }
    const normalized = normalizeFinalizationError(error);
    if (error instanceof MeetingAccessError && error.code !== "audio_revision_changed") throw normalized;
    const failed = await failMeetingFinalization({
      state: processing,
      code: normalized.code,
      message: normalized.message,
      retryable: normalized.retryable,
    });
    normalized.processing = failed;
    throw normalized;
  }
}

async function reserveFinalizationQuotaOrThrow(input: {
  durationMs: number;
  meetingId: string;
  operationKey: string;
  processingRoute: MeetingProcessingRoute;
  userId: string;
}) {
  try {
    return await reserveMeetingFinalizationQuota(input.userId, {
      durationMs: input.durationMs,
      meetingId: input.meetingId,
      operationKey: input.operationKey,
      processingRoute: input.processingRoute,
    });
  } catch (error) {
    throw normalizeFinalizationError(error);
  }
}

async function completeExistingResult(input: {
  audioRevision: string;
  existingState: MeetingFinalizationState | null;
  meetingId: string;
  ownerUserId: string;
  result: NonNullable<Awaited<ReturnType<typeof readMeetingResult>>>;
  processingOperationKey: string;
  processingMode?: UserProcessingMode;
  title: string;
}) {
  const state =
    input.existingState?.ownerUserId === input.ownerUserId
      ? input.existingState
      : await startMeetingFinalization({
          audioRevision: input.audioRevision,
          meetingId: input.meetingId,
          ownerUserId: input.ownerUserId,
          processingOperationKey: input.processingOperationKey,
          processingMode: input.processingMode,
          title: input.title,
          leaseMs: getFinalizationLeaseMs(),
        });
  return completeMeetingFinalization({
    state,
    resultGeneratedAt: input.result.generatedAt,
    qualityStatus: assessMeetingResultQuality(input.result).status,
  });
}

function normalizeFinalizationError(error: unknown) {
  if (error instanceof MeetingFinalizationError) return error;
  if (error instanceof AuthError) {
    return new MeetingFinalizationError({
      message: error.message,
      status: error.status,
      code: error.code || "processing_entitlement_required",
      retryable: error.status >= 500,
    });
  }
  if (error instanceof MeetingAccessError) {
    return new MeetingFinalizationError({
      message: error.message,
      status: error.status,
      code: error.code || "meeting_deleted_or_inaccessible",
      retryable: error.retryable,
    });
  }
  const failure = classifyFinalizationFailure(error);
  return new MeetingFinalizationError({
    message: failure.message,
    status: failure.status,
    code: failure.code,
    retryable: failure.retryable,
  });
}

async function failStartedFinalization(
  state: MeetingFinalizationState,
  error: unknown,
  cleanup?: () => Promise<void>,
): Promise<never> {
  await cleanup?.().catch(() => undefined);
  const normalized = normalizeFinalizationError(error);
  if (error instanceof MeetingAccessError && error.code !== "audio_revision_changed") {
    throw normalized;
  }
  const failed = await failMeetingFinalization({
    state,
    code: normalized.code,
    message: normalized.message,
    retryable: normalized.retryable,
  });
  normalized.processing = failed;
  throw normalized;
}

function getFinalizationLeaseMs() {
  const configured =
    process.env.OWNMINUTES_FINALIZATION_MODE === "postgres-queue"
      ? process.env.OWNMINUTES_FINALIZATION_JOB_LEASE_MS
      : process.env.OWNMINUTES_FINALIZATION_LEASE_MS;
  const parsed = Number(configured || DEFAULT_LEASE_MS);
  return Number.isFinite(parsed) ? Math.min(60 * 60 * 1000, Math.max(60_000, Math.round(parsed))) : DEFAULT_LEASE_MS;
}

function createProviderStepFence(input: {
  assertProcessingLease?: () => Promise<void>;
  meetingId: string;
  reservationId: string;
  userId: string;
}) {
  const claims = new Map<MeetingProviderStage, { claimToken: string; stepId: string }>();

  return {
    start: async (stage: MeetingProviderStage) => {
      await withMeetingWriteFence(input.meetingId, async () => {
        await input.assertProcessingLease?.();
        const claimed = await claimMeetingProviderStep(input.userId, {
          reservationId: input.reservationId,
          stage: stage === "asr" ? { type: "finalization_asr" } : { type: "finalization_summary" },
        });
        if (claimed.outcome !== "claimed" || !claimed.claimToken) {
          throw providerStepFenceError(stage, claimed.outcome);
        }
        const activeClaim = { claimToken: claimed.claimToken, stepId: claimed.step.id };
        try {
          const started = await startMeetingProviderStep(input.userId, activeClaim);
          if (started.outcome !== "started") throw providerStepFenceError(stage, started.outcome);
          claims.set(stage, activeClaim);
        } catch (error) {
          await releaseMeetingProviderStep(input.userId, activeClaim).catch(() => undefined);
          throw error;
        }
      });
    },
    complete: async (stage: MeetingProviderStage) => {
      const activeClaim = claims.get(stage);
      if (!activeClaim) {
        throw new MeetingFinalizationError({
          code: "provider_step_claim_missing",
          message: `The ${stage} provider step has no active cost-fence claim.`,
          retryable: false,
          status: 409,
        });
      }
      const completed = await completeMeetingProviderStep(input.userId, activeClaim);
      if (completed.outcome !== "completed") {
        throw new MeetingFinalizationError({
          code: "provider_step_checkpoint_pending",
          message: `The ${stage} result is durable, but its provider step needs reconciliation before publishing.`,
          retryable: true,
          status: 503,
        });
      }
      claims.delete(stage);
    },
    completeDiscardedAfterMeetingDeletion: async () => {
      for (const [stage, activeClaim] of [...claims.entries()]) {
        const completed = await completeMeetingProviderStep(input.userId, activeClaim);
        if (completed.outcome !== "completed") {
          throw providerStepFenceError(stage, completed.outcome);
        }
        claims.delete(stage);
      }
    },
    reconcile: async (stage: MeetingProviderStage) => {
      const reconciled = await withMeetingWriteFence(input.meetingId, async () => {
        await input.assertProcessingLease?.();
        return reconcileMeetingProviderStep(input.userId, {
          reservationId: input.reservationId,
          stage: stage === "asr" ? { type: "finalization_asr" } : { type: "finalization_summary" },
        });
      });
      if (reconciled.outcome !== "completed") {
        throw new MeetingFinalizationError({
          code: "provider_step_checkpoint_mismatch",
          message: `The durable ${stage} checkpoint could not reconcile its provider step.`,
          retryable: false,
          status: 409,
        });
      }
    },
    reject: async (stage: MeetingProviderStage) => {
      const activeClaim = claims.get(stage);
      if (!activeClaim) {
        throw new MeetingFinalizationError({
          code: "provider_step_claim_missing",
          message: `The ${stage} provider step has no active cost-fence claim to reject.`,
          retryable: false,
          status: 409,
        });
      }
      const rejected = await rejectMeetingProviderStep(input.userId, activeClaim);
      if (rejected.outcome !== "released") {
        throw new MeetingFinalizationError({
          code: "provider_step_rejection_pending",
          message: `The ${stage} provider explicitly rejected the request, but its quota settlement still needs reconciliation.`,
          retryable: false,
          status: 409,
        });
      }
      claims.delete(stage);
    },
  };
}

function providerStepFenceError(stage: MeetingProviderStage, outcome: string) {
  const busy = outcome === "busy";
  return new MeetingFinalizationError({
    code: busy ? "provider_step_busy" : "provider_step_outcome_uncertain",
    message: busy
      ? `The ${stage} provider step is already being processed by another worker.`
      : `The ${stage} provider step may already have reached the paid provider, so automatic retry was blocked.`,
    retryable: busy,
    status: 409,
  });
}

function hasUserAsrRuntime(runtime?: MeetingProviderRuntime) {
  return runtime?.source === "user" && Boolean(runtime.volcanoAsr?.apiKey || (runtime.volcanoAsr?.appId && runtime.volcanoAsr?.token));
}

function hasUserSummaryRuntime(runtime?: MeetingProviderRuntime) {
  return runtime?.source === "user" && Boolean(runtime.ark?.apiKey && runtime.ark?.model);
}

function normalizeUserProviderRuntime(runtime?: MeetingProviderRuntime): MeetingProviderRuntime | undefined {
  if (!runtime) return undefined;
  const volcanoAsr = hasUserAsrRuntime(runtime) ? runtime.volcanoAsr : undefined;
  const ark = hasUserSummaryRuntime(runtime) ? runtime.ark : undefined;
  return volcanoAsr || ark ? { source: "user", volcanoAsr, ark } : undefined;
}

async function buildUserProviderRuntime(userId: string): Promise<MeetingProviderRuntime | undefined> {
  const [volcanoAsr, volcanoArk] = await Promise.all([
    getProviderRuntimeConfig(userId, "volcano-asr"),
    getProviderRuntimeConfig(userId, "volcano-ark"),
  ]);
  if (!volcanoAsr && !volcanoArk) return undefined;

  return {
    source: "user",
    volcanoAsr: volcanoAsr
      ? {
          apiKey: volcanoAsr.secrets.VOLCANO_ASR_API_KEY,
          appId: volcanoAsr.fields.VOLCANO_ASR_APP_ID,
          token: volcanoAsr.secrets.VOLCANO_ASR_TOKEN,
          mode: volcanoAsr.fields.VOLCANO_ASR_MODE === "standard" ? "standard" : "flash",
          recognizeUrl: volcanoAsr.fields.VOLCANO_ASR_RECOGNIZE_URL,
          submitUrl: volcanoAsr.fields.VOLCANO_ASR_SUBMIT_URL,
          queryUrl: volcanoAsr.fields.VOLCANO_ASR_QUERY_URL,
          resourceId: volcanoAsr.fields.VOLCANO_ASR_RESOURCE_ID,
          model: volcanoAsr.fields.VOLCANO_ASR_MODEL,
          vadSegmentDuration: volcanoAsr.fields.VOLCANO_ASR_VAD_SEGMENT_DURATION,
          strategy: "single",
          turboFallbackEnabled: false,
        }
      : undefined,
    ark: volcanoArk
      ? {
          apiKey: volcanoArk.secrets.ARK_API_KEY,
          model: volcanoArk.fields.ARK_CHAT_MODEL,
          baseUrl: volcanoArk.fields.ARK_BASE_URL,
        }
      : undefined,
  };
}
