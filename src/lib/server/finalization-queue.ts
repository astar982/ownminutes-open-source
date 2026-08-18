import crypto from "crypto";
import os from "os";
import { finalizeMeetingForUser, MeetingFinalizationError } from "@/lib/server/meeting-finalizer";
import { getAuthRepositoryInfo, getMeetingProcessingReservation, getUserById } from "@/lib/server/auth-repository";
import { getPostgresRuntimePool, type PgPool } from "@/lib/server/postgres-runtime";
import { classifyFinalizationFailure, sanitizeFinalizationMessage } from "@/lib/server/finalization-error-policy";
import { initialMeetingOperationKey, reprocessMeetingOperationKey, type UserProcessingMode } from "@/lib/processing-route";
import {
  failMeetingFinalization,
  queueMeetingFinalization,
  readMeetingFinalizationState,
  refreshMeetingFinalizationLease,
} from "@/lib/server/meeting-finalization-state";
import {
  DEFAULT_MEETING_CONTENT_LOCALE,
  resolveMeetingContentLocale,
  type MeetingContentLocale,
} from "@/lib/meeting-content-locale";
import { readMeetingResultFreshness, runMeetingDeletionCleanupOnce } from "@/lib/server/meeting-audio-store";
import { runAccountDeletionProcessingCleanupOnce } from "@/lib/server/account-deletion-state";
import { runAccountDeletionObjectCleanupOnce } from "@/lib/server/account-deletion-cleanup-worker";
import { MeetingAccessError } from "@/lib/server/meeting-errors";
import { canonicalMeetingId, withMeetingWriteFence } from "@/lib/server/meeting-write-lock";

export type FinalizationQueueMode = "inline" | "postgres-queue";
export type FinalizationJobStatus = "queued" | "processing" | "retry_wait" | "completed" | "failed" | "cancelled";

export type FinalizationJob = {
  id: string;
  meetingId: string;
  ownerUserId: string;
  title: string;
  contentLocale: MeetingContentLocale;
  force: boolean;
  processingOperationKey?: string;
  audioRevision?: string;
  processingMode: UserProcessingMode;
  status: FinalizationJobStatus;
  attempt: number;
  maxAttempts: number;
  availableAt: string;
  lockedAt?: string;
  lockedBy?: string;
  leaseExpiresAt?: string;
  completedAt?: string;
  failedAt?: string;
  error?: {
    code: string;
    message: string;
  };
  createdAt: string;
  updatedAt: string;
};

type JobRow = {
  id: string;
  meeting_id: string;
  owner_user_id: string;
  title: string;
  content_locale?: string | null;
  force_regenerate: boolean;
  processing_operation_key?: string | null;
  audio_revision?: string | null;
  processing_mode?: UserProcessingMode | null;
  status: FinalizationJobStatus;
  attempt: number;
  max_attempts: number;
  available_at: Date | string;
  locked_at?: Date | string | null;
  locked_by?: string | null;
  lease_expires_at?: Date | string | null;
  completed_at?: Date | string | null;
  failed_at?: Date | string | null;
  last_error_code?: string | null;
  last_error_message?: string | null;
  created_at: Date | string;
  updated_at: Date | string;
};

const DEFAULT_JOB_LEASE_MS = 5 * 60 * 1000;
const DEFAULT_POLL_MS = 2_000;
const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_RETRY_BASE_MS = 15_000;

type WorkerRuntime = {
  started: boolean;
  workerId: string;
};

const workerRuntimeKey = Symbol.for("ownminutes.finalization-worker");
const deletionCleanupWorkerRuntimeKey = Symbol.for("ownminutes.meeting-deletion-cleanup-worker");
const globalWorker = globalThis as typeof globalThis & {
  [workerRuntimeKey]?: WorkerRuntime;
  [deletionCleanupWorkerRuntimeKey]?: WorkerRuntime;
};
let deletionCleanupInFlight: Promise<void> | null = null;

export function getFinalizationQueueMode(): FinalizationQueueMode {
  return process.env.OWNMINUTES_FINALIZATION_MODE === "postgres-queue" ? "postgres-queue" : "inline";
}

export function getFinalizationQueueInfo() {
  const mode = getFinalizationQueueMode();
  const auth = getAuthRepositoryInfo();
  return {
    mode,
    workerEnabled: process.env.OWNMINUTES_FINALIZATION_WORKER === "1",
    deletionCleanupWorkerEnabled: process.env.OWNMINUTES_MEETING_DELETION_CLEANUP_WORKER === "1",
    productionReady: mode === "postgres-queue" && auth.provider === "postgres" && auth.productionReady,
    pollMs: getBoundedNumber("OWNMINUTES_FINALIZATION_POLL_MS", DEFAULT_POLL_MS, 250, 60_000),
    leaseMs: getJobLeaseMs(),
    maxAttempts: getBoundedNumber("OWNMINUTES_FINALIZATION_MAX_ATTEMPTS", DEFAULT_MAX_ATTEMPTS, 1, 20),
  };
}

export async function enqueueMeetingFinalizationJob(input: {
  meetingId: string;
  ownerUserId: string;
  title: string;
  force?: boolean;
  contentLocale?: MeetingContentLocale;
  processingOperationKey?: string;
  audioRevision?: string;
  processingMode?: UserProcessingMode;
}) {
  const meetingId = canonicalMeetingId(input.meetingId);
  return withMeetingWriteFence(meetingId, () => enqueueMeetingFinalizationJobUnsafe({ ...input, meetingId }));
}

async function enqueueMeetingFinalizationJobUnsafe(input: {
  meetingId: string;
  ownerUserId: string;
  title: string;
  force?: boolean;
  contentLocale?: MeetingContentLocale;
  processingOperationKey?: string;
  audioRevision?: string;
  processingMode?: UserProcessingMode;
}) {
  // Direct legacy callers predate the per-meeting field. They remain on the
  // historical official route, while API callers always pass either the
  // explicit Build 11 selection or the account mode captured on first contact.
  let requestedProcessingMode = input.processingMode ?? "official_quota";
  if (!input.force) {
    const initialReservation = await getMeetingProcessingReservation(
      input.ownerUserId,
      initialMeetingOperationKey(input.meetingId),
    );
    if (initialReservation?.processingRoute === "hybrid") {
      throw new MeetingFinalizationError({
        message: "这场旧会议使用了已停用的混合处理方式，为避免误扣费，请导出录音后新建会议。",
        status: 409,
        code: "legacy_meeting_processing_mode_unavailable",
        retryable: false,
      });
    }
    if (initialReservation) {
      if (input.processingMode && input.processingMode !== initialReservation.processingRoute) {
        throw new MeetingFinalizationError({
          message: "这场会议的处理方式已在开始时固定，不能在上传或重试时更换。",
          status: 409,
          code: "meeting_processing_mode_conflict",
          retryable: false,
        });
      }
      requestedProcessingMode = initialReservation.processingRoute;
    }
  }
  assertQueueRuntime();
  const pool = getQueuePool();
  const client = await pool.connect();
  let job: FinalizationJob;

  try {
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock(hashtext($1))", [`ownminutes-finalize:${input.meetingId}`]);
    const existing = await client.query<JobRow>(
      "select * from meeting_finalization_jobs where meeting_id = $1 and status in ('queued','processing','retry_wait') order by created_at desc limit 1",
      [input.meetingId],
    );

    if (existing.rows[0]) {
      if (existing.rows[0].owner_user_id !== input.ownerUserId) throw new Error("Meeting finalization job belongs to another user.");
      const existingJob = existing.rows[0];
      if (existingJob.processing_mode && existingJob.processing_mode !== requestedProcessingMode) {
        throw new MeetingFinalizationError({
          message: "这场会议的处理方式已在排队时固定，不能在重试时更换。",
          status: 409,
          code: "meeting_processing_mode_conflict",
          retryable: false,
        });
      }
      if (
        input.processingOperationKey &&
        existingJob.processing_operation_key &&
        input.processingOperationKey !== existingJob.processing_operation_key
      ) {
        throw new MeetingFinalizationError({
          message: "这场会议正在处理另一次纪要生成请求，请等待完成后再重新生成。",
          status: 409,
          code: "processing_in_progress",
          retryable: true,
        });
      }
      const processingOperationKey =
        input.processingOperationKey ??
        (existingJob.force_regenerate
          ? reprocessMeetingOperationKey(input.meetingId, input.audioRevision || existingJob.id)
          : initialMeetingOperationKey(input.meetingId));
      const hydrated = await client.query<JobRow>(
        `update meeting_finalization_jobs
         set processing_operation_key = coalesce(processing_operation_key, $2),
             audio_revision = coalesce(audio_revision, $3),
             processing_mode = coalesce(processing_mode, $4),
             updated_at = case
               when processing_operation_key is null or (audio_revision is null and $3::text is not null) or processing_mode is null then now()
               else updated_at
             end
         where id = $1
         returning *`,
        [existingJob.id, processingOperationKey, input.audioRevision ?? null, requestedProcessingMode],
      );
      job = mapJob(hydrated.rows[0]);
    } else {
      const now = new Date().toISOString();
      const jobId = createJobId();
      const processingOperationKey =
        input.processingOperationKey ??
        (input.force
          ? reprocessMeetingOperationKey(input.meetingId, input.audioRevision || jobId)
          : initialMeetingOperationKey(input.meetingId));
      const inserted = await client.query<JobRow>(
        "insert into meeting_finalization_jobs (id, meeting_id, owner_user_id, title, content_locale, force_regenerate, processing_operation_key, audio_revision, processing_mode, status, attempt, max_attempts, available_at, created_at, updated_at) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,'queued',0,$10,$11,$11,$11) returning *",
        [
          jobId,
          input.meetingId,
          input.ownerUserId,
          input.title,
          input.contentLocale ?? DEFAULT_MEETING_CONTENT_LOCALE,
          Boolean(input.force),
          processingOperationKey,
          input.audioRevision ?? null,
          requestedProcessingMode,
          getMaxAttempts(),
          now,
        ],
      );
      job = mapJob(inserted.rows[0]);
    }
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }

  const current = await readMeetingFinalizationState(job.meetingId);
  const processing =
    job.status === "processing" &&
    current?.status === "processing" &&
    current.jobId === job.id &&
    current.processingOperationKey === job.processingOperationKey &&
    current.audioRevision === job.audioRevision
      ? current
      : await queueMeetingFinalization({
          meetingId: job.meetingId,
          ownerUserId: job.ownerUserId,
          title: job.title,
          jobId: job.id,
          processingOperationKey: job.processingOperationKey,
          processingMode: job.processingMode,
          audioRevision: job.audioRevision,
          nextAttemptAt: job.availableAt,
        });
  return { job, processing };
}

export async function cancelMeetingFinalizationJobs(meetingId: string, ownerUserId: string) {
  if (getFinalizationQueueMode() !== "postgres-queue") return { cancelled: 0 };
  assertQueueRuntime();
  const key = canonicalMeetingId(meetingId);
  const result = await getQueuePool().query(
    "update meeting_finalization_jobs set status = 'cancelled', updated_at = now(), locked_at = null, locked_by = null, lease_expires_at = null where meeting_id = $1 and owner_user_id = $2 and status in ('queued','processing','retry_wait')",
    [key, ownerUserId],
  );
  return { cancelled: result.rowCount || 0 };
}

export async function deleteUserFinalizationJobs(ownerUserId: string) {
  if (getFinalizationQueueMode() !== "postgres-queue") return { deleted: 0 };
  assertQueueRuntime();
  const result = await getQueuePool().query("delete from meeting_finalization_jobs where owner_user_id = $1", [ownerUserId]);
  return { deleted: result.rowCount || 0 };
}

export async function runFinalizationWorkerOnce(workerId = createWorkerId()) {
  assertQueueRuntime();
  // Keep backward-compatible opportunistic cleanup only when this process has
  // not been configured with the dedicated deletion loop. Production enables
  // the dedicated loop on both workers, so scheduling here as well would turn
  // two HA consumers into four independent polling paths.
  if (process.env.OWNMINUTES_MEETING_DELETION_CLEANUP_WORKER !== "1") {
    scheduleDeletionCleanup(`${workerId}-deletion`);
  }
  await failExhaustedJobs();
  const job = await claimNextJob(workerId);
  if (!job) return { claimed: false as const };

  let leaseLost = false;
  const heartbeat = setInterval(() => {
    void heartbeatJob(job, workerId).catch((error) => {
      leaseLost = true;
      console.error(`[finalization-worker] heartbeat failed for ${job.id}: ${sanitizeMessage(error instanceof Error ? error.message : String(error))}`);
    });
  }, Math.max(5_000, Math.floor(getJobLeaseMs() / 3)));
  heartbeat.unref?.();

  try {
    await applyProductionLikeWorkerFault(job);
    const user = await getUserById(job.ownerUserId);
    if (!user) throw new MeetingFinalizationError({ message: "账号不存在或已删除。", status: 404, code: "worker_user_not_found", retryable: false });
    const processingOperationKey =
      job.processingOperationKey ||
      (job.force ? reprocessMeetingOperationKey(job.meetingId, job.id) : initialMeetingOperationKey(job.meetingId));
    if (job.audioRevision) {
      const freshness = await readMeetingResultFreshness(job.meetingId);
      if (freshness.audio.audioRevision !== job.audioRevision) {
        throw new MeetingFinalizationError({
          message: "录音内容已在任务排队后变化，旧任务已停止；请从会议详情重新发起处理。",
          status: 409,
          code: "audio_revision_changed",
          retryable: false,
        });
      }
    }
    const finalized = await finalizeMeetingForUser({
      meetingId: job.meetingId,
      title: job.title,
      user,
      force: job.force,
      contentLocale: job.contentLocale,
      usageOperationKey: processingOperationKey,
      processingMode: job.processingMode,
      assertProcessingLease: async () => {
        if (leaseLost || !(await hasActiveJobLease(job.id, workerId))) {
          throw new MeetingFinalizationError({
            message: "处理任务租约已失效，已在调用付费服务前停止；本地音频仍安全保留。",
            status: 409,
            code: "worker_lease_lost_before_provider",
            retryable: true,
          });
        }
      },
    });
    await completeJob(job.id, workerId);
    return { claimed: true as const, job, result: finalized.result, processing: finalized.processing };
  } catch (error) {
    const normalized = normalizeWorkerError(error);
    if (normalized.code === "meeting_deleted") {
      const cancelledJob = await cancelJob(job.id, workerId, normalized);
      return {
        claimed: true as const,
        job: cancelledJob ?? { ...job, status: "cancelled" as const },
        retryScheduled: false as const,
      };
    }
    const shouldRetry = normalized.retryable && job.attempt < job.maxAttempts;
    if (shouldRetry) {
      const availableAt = new Date(Date.now() + getRetryDelayMs(job.attempt)).toISOString();
      const retryJob = await retryJobLater(job.id, workerId, normalized, availableAt);
      if (!retryJob) return { claimed: true as const, job: { ...job, status: "cancelled" as const }, retryScheduled: false as const };
      const processing = await queueMeetingFinalization({
        meetingId: job.meetingId,
        ownerUserId: job.ownerUserId,
        title: job.title,
        jobId: job.id,
        processingOperationKey: job.processingOperationKey,
        processingMode: job.processingMode,
        audioRevision: job.audioRevision,
        nextAttemptAt: availableAt,
      });
      return { claimed: true as const, job: retryJob, processing, retryScheduled: true as const };
    }

    const failedJob = await failJob(job.id, workerId, normalized);
    if (!failedJob) return { claimed: true as const, job: { ...job, status: "cancelled" as const }, retryScheduled: false as const };
    const current = await readMeetingFinalizationState(job.meetingId);
    if (current && current.ownerUserId === job.ownerUserId && current.status !== "failed") {
      await failMeetingFinalization({ state: current, code: normalized.code, message: normalized.message, retryable: false });
    }
    return { claimed: true as const, job: failedJob, retryScheduled: false as const };
  } finally {
    clearInterval(heartbeat);
  }
}

function scheduleDeletionCleanup(workerId: string) {
  if (deletionCleanupInFlight) return;
  deletionCleanupInFlight = Promise.all([
    runMeetingDeletionCleanupOnce(workerId),
    runAccountDeletionProcessingCleanupOnce(),
    runAccountDeletionObjectCleanupOnce(workerId),
  ])
    .then(() => undefined)
    .catch((error) => {
      console.error(`[deletion-cleanup] isolated worker error: ${sanitizeMessage(error instanceof Error ? error.message : String(error))}`);
    })
    .finally(() => {
      deletionCleanupInFlight = null;
    });
}

export function startFinalizationWorker() {
  if (globalWorker[workerRuntimeKey]?.started) return globalWorker[workerRuntimeKey];
  const workerId = createWorkerId();
  const runtime = { started: true, workerId };
  globalWorker[workerRuntimeKey] = runtime;

  void (async () => {
    while (globalWorker[workerRuntimeKey]?.started) {
      try {
        const result = await runFinalizationWorkerOnce(workerId);
        if (!result.claimed) await delay(getPollMs());
      } catch (error) {
        console.error(`[finalization-worker] loop error: ${sanitizeMessage(error instanceof Error ? error.message : String(error))}`);
        await delay(getPollMs());
      }
    }
  })();

  return runtime;
}

export function startMeetingDeletionCleanupWorker() {
  if (globalWorker[deletionCleanupWorkerRuntimeKey]?.started) {
    return globalWorker[deletionCleanupWorkerRuntimeKey];
  }
  const workerId = `${createWorkerId()}:deletion`;
  const runtime = { started: true, workerId };
  globalWorker[deletionCleanupWorkerRuntimeKey] = runtime;

  void (async () => {
    while (globalWorker[deletionCleanupWorkerRuntimeKey]?.started) {
      try {
        const [meetingResult, accountResult, accountObjectResult] = await Promise.all([
          runMeetingDeletionCleanupOnce(workerId),
          runAccountDeletionProcessingCleanupOnce(),
          runAccountDeletionObjectCleanupOnce(workerId),
        ]);
        if (!meetingResult.claimed && !accountResult.claimed && !accountObjectResult.claimed) {
          await delay(getDeletionCleanupPollMs());
        }
      } catch (error) {
        console.error(`[deletion-cleanup] worker loop error: ${sanitizeMessage(error instanceof Error ? error.message : String(error))}`);
        await delay(getDeletionCleanupPollMs());
      }
    }
  })();

  return runtime;
}

async function claimNextJob(workerId: string) {
  const client = await getQueuePool().connect();
  try {
    await client.query("begin");
    const claimed = await client.query<JobRow>(
      `with candidate as (
       select id from meeting_finalization_jobs
         where attempt < max_attempts
           and not exists (
             select 1 from meeting_deletion_tombstones tombstone where tombstone.meeting_id = meeting_finalization_jobs.meeting_id
           )
           and ((status in ('queued','retry_wait') and available_at <= now()) or (status = 'processing' and lease_expires_at < now()))
         order by available_at asc, created_at asc
         for update skip locked
         limit 1
       )
       update meeting_finalization_jobs job
       set status = 'processing', attempt = job.attempt + 1, locked_at = now(), locked_by = $1,
           lease_expires_at = now() + ($2::bigint * interval '1 millisecond'), updated_at = now(),
           last_error_code = null, last_error_message = null
       from candidate where job.id = candidate.id returning job.*`,
      [workerId, getJobLeaseMs()],
    );
    await client.query("commit");
    return claimed.rows[0] ? mapJob(claimed.rows[0]) : null;
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

async function failExhaustedJobs() {
  const exhausted = await getQueuePool().query<JobRow>(
    "update meeting_finalization_jobs job set status = 'failed', failed_at = now(), updated_at = now(), locked_at = null, locked_by = null, lease_expires_at = null, last_error_code = 'worker_attempts_exhausted', last_error_message = 'Maximum worker attempts exhausted.' where status in ('queued','retry_wait','processing') and attempt >= max_attempts and (status <> 'processing' or lease_expires_at < now()) and not exists (select 1 from meeting_deletion_tombstones tombstone where tombstone.meeting_id = job.meeting_id) returning job.*",
  );
  for (const row of exhausted.rows) {
    const job = mapJob(row);
    const current = await readMeetingFinalizationState(job.meetingId);
    if (current && current.ownerUserId === job.ownerUserId && current.status !== "completed" && current.status !== "failed") {
      await failMeetingFinalization({
        state: current,
        code: "worker_attempts_exhausted",
        message: "Maximum worker attempts exhausted.",
        retryable: false,
      });
    }
  }
}

async function heartbeatJob(job: FinalizationJob, workerId: string) {
  const leaseMs = getJobLeaseMs();
  const result = await getQueuePool().query(
    "update meeting_finalization_jobs set lease_expires_at = now() + ($3::bigint * interval '1 millisecond'), updated_at = now() where id = $1 and locked_by = $2 and status = 'processing'",
    [job.id, workerId, leaseMs],
  );
  if (result.rowCount !== 1) throw new Error("Finalization job lease is no longer owned by this worker.");
  try {
    const refreshed = await refreshMeetingFinalizationLease({
      audioRevision: job.audioRevision,
      jobId: job.id,
      meetingId: job.meetingId,
      ownerUserId: job.ownerUserId,
      processingOperationKey: job.processingOperationKey,
      leaseMs,
    });
    if (
      !refreshed ||
      refreshed.status !== "processing" ||
      refreshed.jobId !== job.id ||
      refreshed.processingOperationKey !== job.processingOperationKey ||
      refreshed.audioRevision !== job.audioRevision
    ) {
      await cancelJob(job.id, workerId, {
        code: "worker_projection_lease_lost",
        message: "The durable processing projection belongs to a different finalization run.",
        retryable: false,
      });
      throw new Error("Finalization projection lease is no longer owned by this job.");
    }
  } catch (error) {
    if (error instanceof MeetingAccessError && error.code === "meeting_deleted") {
      await cancelJob(job.id, workerId, { code: error.code, message: error.message, retryable: false });
    }
    throw error;
  }
}

async function hasActiveJobLease(jobId: string, workerId: string) {
  const result = await getQueuePool().query<{ active: boolean }>(
    `select exists(
       select 1 from meeting_finalization_jobs
       where id = $1 and locked_by = $2 and status = 'processing' and lease_expires_at > now()
     ) as active`,
    [jobId, workerId],
  );
  return result.rows[0]?.active === true;
}

async function completeJob(jobId: string, workerId: string) {
  const result = await getQueuePool().query(
    "update meeting_finalization_jobs set status = 'completed', completed_at = now(), updated_at = now(), locked_at = null, locked_by = null, lease_expires_at = null where id = $1 and locked_by = $2 and status = 'processing' and lease_expires_at > now()",
    [jobId, workerId],
  );
  if (result.rowCount !== 1) {
    throw new MeetingFinalizationError({
      message: "处理任务租约已失效，旧 Worker 不能发布完成状态。",
      status: 503,
      code: "worker_lease_lost_before_publish",
      retryable: true,
    });
  }
}

async function retryJobLater(jobId: string, workerId: string, error: WorkerError, availableAt: string) {
  const result = await getQueuePool().query<JobRow>(
    "update meeting_finalization_jobs set status = 'retry_wait', available_at = $3, updated_at = now(), locked_at = null, locked_by = null, lease_expires_at = null, last_error_code = $4, last_error_message = $5 where id = $1 and locked_by = $2 returning *",
    [jobId, workerId, availableAt, error.code, sanitizeMessage(error.message)],
  );
  return result.rows[0] ? mapJob(result.rows[0]) : null;
}

async function failJob(jobId: string, workerId: string, error: WorkerError) {
  const result = await getQueuePool().query<JobRow>(
    "update meeting_finalization_jobs set status = 'failed', failed_at = now(), updated_at = now(), locked_at = null, locked_by = null, lease_expires_at = null, last_error_code = $3, last_error_message = $4 where id = $1 and locked_by = $2 returning *",
    [jobId, workerId, error.code, sanitizeMessage(error.message)],
  );
  return result.rows[0] ? mapJob(result.rows[0]) : null;
}

async function cancelJob(jobId: string, workerId: string, error: WorkerError) {
  const result = await getQueuePool().query<JobRow>(
    "update meeting_finalization_jobs set status = 'cancelled', updated_at = now(), locked_at = null, locked_by = null, lease_expires_at = null, last_error_code = $3, last_error_message = $4 where id = $1 and locked_by = $2 returning *",
    [jobId, workerId, error.code, sanitizeMessage(error.message)],
  );
  return result.rows[0] ? mapJob(result.rows[0]) : null;
}

type WorkerError = { code: string; message: string; retryable: boolean };

function normalizeWorkerError(error: unknown): WorkerError {
  if (error instanceof MeetingAccessError) {
    return {
      code: sanitizeCode(error.code || "meeting_deleted"),
      message: sanitizeMessage(error.message),
      retryable: false,
    };
  }
  if (error instanceof MeetingFinalizationError) {
    return {
      code: sanitizeCode(error.code),
      message: sanitizeMessage(error.message),
      retryable:
        error.retryable &&
        (error.status >= 500 ||
          error.code === "processing_in_progress" ||
          error.code === "provider_step_busy" ||
          error.code.startsWith("worker_lease_lost")),
    };
  }
  const failure = classifyFinalizationFailure(error);
  return {
    code: failure.code,
    message: failure.message,
    retryable: failure.retryable,
  };
}

function assertQueueRuntime() {
  const info = getFinalizationQueueInfo();
  if (info.mode !== "postgres-queue") throw new Error("Finalization queue is not enabled.");
  if (getAuthRepositoryInfo().provider !== "postgres") {
    throw new Error("postgres-queue requires OWNMINUTES_AUTH_REPOSITORY=postgres.");
  }
}

function getQueuePool(): PgPool {
  return getPostgresRuntimePool("postgres-queue");
}

function mapJob(row: JobRow): FinalizationJob {
  return {
    id: row.id,
    meetingId: row.meeting_id,
    ownerUserId: row.owner_user_id,
    title: row.title,
    contentLocale: resolveMeetingContentLocale(row.content_locale),
    force: Boolean(row.force_regenerate),
    processingOperationKey: row.processing_operation_key || undefined,
    audioRevision: row.audio_revision || undefined,
    processingMode: row.processing_mode || "official_quota",
    status: row.status,
    attempt: Number(row.attempt),
    maxAttempts: Number(row.max_attempts),
    availableAt: toIso(row.available_at),
    lockedAt: optionalIso(row.locked_at),
    lockedBy: row.locked_by || undefined,
    leaseExpiresAt: optionalIso(row.lease_expires_at),
    completedAt: optionalIso(row.completed_at),
    failedAt: optionalIso(row.failed_at),
    error: row.last_error_code
      ? { code: sanitizeCode(row.last_error_code), message: sanitizeMessage(row.last_error_message || "Finalization job failed.") }
      : undefined,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function getRetryDelayMs(attempt: number) {
  const base = getBoundedNumber("OWNMINUTES_FINALIZATION_RETRY_BASE_MS", DEFAULT_RETRY_BASE_MS, 1_000, 5 * 60 * 1000);
  return Math.min(15 * 60 * 1000, base * 2 ** Math.max(0, attempt - 1));
}

function getJobLeaseMs() {
  return getBoundedNumber("OWNMINUTES_FINALIZATION_JOB_LEASE_MS", DEFAULT_JOB_LEASE_MS, 30_000, 60 * 60 * 1000);
}

function getPollMs() {
  return getBoundedNumber("OWNMINUTES_FINALIZATION_POLL_MS", DEFAULT_POLL_MS, 250, 60_000);
}

function getDeletionCleanupPollMs() {
  return getBoundedNumber("OWNMINUTES_MEETING_DELETION_CLEANUP_POLL_MS", 2_000, 250, 60_000);
}

function getMaxAttempts() {
  return getBoundedNumber("OWNMINUTES_FINALIZATION_MAX_ATTEMPTS", DEFAULT_MAX_ATTEMPTS, 1, 20);
}

async function applyProductionLikeWorkerFault(job: FinalizationJob) {
  if (
    process.env.OWNMINUTES_RUNTIME_PROFILE !== "production-like" ||
    process.env.OWNMINUTES_FINALIZATION_TEST_HOOKS !== "1"
  ) {
    return;
  }

  const holdPrefix = process.env.OWNMINUTES_FINALIZATION_TEST_HOLD_PREFIX || "";
  if (holdPrefix && job.meetingId.startsWith(holdPrefix)) {
    const holdMs = getBoundedNumber("OWNMINUTES_FINALIZATION_TEST_HOLD_MS", 8_000, 1_000, 30_000);
    await delay(holdMs);
  }

  const retryOncePrefix = process.env.OWNMINUTES_FINALIZATION_TEST_RETRY_ONCE_PREFIX || "";
  if (retryOncePrefix && job.meetingId.startsWith(retryOncePrefix) && job.attempt === 1) {
    throw new Error("Production-like queue verifier injected a temporary network timeout.");
  }

  const exhaustPrefix = process.env.OWNMINUTES_FINALIZATION_TEST_EXHAUST_PREFIX || "";
  if (exhaustPrefix && job.meetingId.startsWith(exhaustPrefix)) {
    throw new Error("Production-like queue verifier injected a temporary network timeout.");
  }
}

function getBoundedNumber(name: string, fallback: number, minimum: number, maximum: number) {
  const parsed = Number(process.env[name] || fallback);
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, Math.round(parsed))) : fallback;
}

function createJobId() {
  return `finalize_${crypto.randomBytes(12).toString("hex")}`;
}

function createWorkerId() {
  return `${os.hostname()}:${process.pid}:${crypto.randomBytes(4).toString("hex")}`;
}

function sanitizeCode(value: string) {
  return value.replace(/[^a-z0-9_-]/gi, "_").slice(0, 80) || "worker_processing_failed";
}

function sanitizeMessage(value: string) {
  return sanitizeFinalizationMessage(value);
}

function toIso(value: Date | string) {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function optionalIso(value?: Date | string | null) {
  return value ? toIso(value) : undefined;
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
