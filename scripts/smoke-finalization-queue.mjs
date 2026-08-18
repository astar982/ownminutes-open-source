#!/usr/bin/env node

import fs from "node:fs";

const migration = read("db/migrations/0008_meeting_finalization_jobs.sql");
const processingIdentityMigration = read("db/migrations/0017_finalization_job_processing_identity.sql");
const processingModeMigration = read("db/migrations/0019_processing_mode.sql");
const queue = read("src/lib/server/finalization-queue.ts");
const state = read("src/lib/server/meeting-finalization-state.ts");
const route = read("src/app/api/meetings/[id]/finalize/route.ts");
const instrumentation = read("src/instrumentation.ts");
const webApi = read("src/lib/audio-pipeline.ts");
const mobileApi = read("apps/mobile/src/api.ts");
const mobileTypes = read("apps/mobile/src/types.ts");
const authRepository = read("src/lib/server/auth-repository.ts");
const envExample = read(".env.example");
const runbook = read("docs/finalization-queue-runbook.md");
const productionCompose = read("deploy/compose.production.yml");
const productionLikeCompose = read("deploy/compose.production-like.yml");
const productionLikeStack = read("scripts/production-like-stack.mjs");
const queueRecoverySmoke = read("scripts/smoke-production-like-queue-recovery.mjs");
const ciWorkflow = read(".github/workflows/ci.yml");
const serialized = [migration, processingIdentityMigration, queue, state, route, instrumentation, webApi, mobileApi, mobileTypes, authRepository, envExample, runbook].join("\n");

const checks = {
  hasDurableJobTable:
    migration.includes("create table if not exists meeting_finalization_jobs") &&
    migration.includes("owner_user_id text not null references users(id) on delete cascade") &&
    migration.includes("max_attempts integer not null default 5") &&
    migration.includes("lease_expires_at timestamptz"),
  hasQueueStateMachine:
    ["queued", "processing", "retry_wait", "completed", "failed", "cancelled"].every((status) => migration.includes(`'${status}'`)) &&
    migration.includes("meeting_finalization_jobs_claim_idx") &&
    migration.includes("meeting_finalization_jobs_lease_idx"),
  hasAtomicClaim:
    queue.includes("pg_advisory_xact_lock(hashtext($1))") &&
    queue.toLowerCase().includes("for update skip locked") &&
    queue.includes("attempt < max_attempts"),
  hasLeaseHeartbeat:
    queue.includes("heartbeatJob") &&
    queue.includes("refreshMeetingFinalizationLease") &&
    queue.includes("OWNMINUTES_FINALIZATION_JOB_LEASE_MS"),
  leaseLossFencesProviderStart:
    queue.includes("leaseLost = true") &&
    queue.includes("hasActiveJobLease(job.id, workerId)") &&
    queue.includes("worker_lease_lost_before_provider") &&
    queue.includes("worker_lease_lost_before_publish") &&
    queue.includes("lease_expires_at > now()") &&
    queue.includes("result.rowCount !== 1"),
  hasBoundedRetry:
    queue.includes("retry_wait") &&
    queue.includes("getRetryDelayMs") &&
    queue.includes("OWNMINUTES_FINALIZATION_MAX_ATTEMPTS") &&
    queue.includes("worker_attempts_exhausted"),
  deletionCancelsActiveJobs:
    queue.includes("cancelMeetingFinalizationJobs") &&
    queue.includes("deleteUserFinalizationJobs") &&
    /(?:await|void) cancelMeetingFinalizationJobs\(id, user\.id\)/.test(read("src/app/api/meetings/[id]/route.ts")) &&
    authRepository.includes("delete from meeting_finalization_jobs where owner_user_id = $1") &&
    !read("src/app/api/auth/delete/route.ts").includes("await deleteUserFinalizationJobs(user.id)") &&
    read("src/lib/server/meeting-finalizer.ts").includes("await assertMeetingOwner(input.meetingId, input.user.id)"),
  hasWorkerBootstrap:
    (instrumentation.includes('process.env.NEXT_RUNTIME === "nodejs"') ||
      instrumentation.includes('process.env.NEXT_RUNTIME !== "nodejs"')) &&
    instrumentation.includes('process.env.OWNMINUTES_FINALIZATION_MODE === "postgres-queue"') &&
    instrumentation.includes('process.env.OWNMINUTES_FINALIZATION_WORKER === "1"') &&
    instrumentation.includes("startFinalizationWorker"),
  productionWorkersRunDeletionCleanup:
    [productionCompose, productionLikeCompose].every(
      (source) => (source.match(/OWNMINUTES_MEETING_DELETION_CLEANUP_WORKER: "1"/g) || []).length >= 2,
    ) && queue.includes("runAccountDeletionProcessingCleanupOnce"),
  dedicatedDeletionWorkersDoNotDuplicateOpportunisticLoops:
    queue.includes('if (process.env.OWNMINUTES_MEETING_DELETION_CLEANUP_WORKER !== "1")') &&
    queue.includes('scheduleDeletionCleanup(`${workerId}-deletion`)') &&
    queue.includes("startMeetingDeletionCleanupWorker"),
  apiQueuesWith202:
    route.includes('getFinalizationQueueMode() === "postgres-queue"') &&
    route.includes("enqueueMeetingFinalizationJob") &&
    route.includes("{ status: 202 }") &&
    route.includes("queued: true"),
  apiNeverReturnsStaleFormalResult:
    route.includes("readMeetingResultFreshness") &&
    route.includes("result: freshness.currentResult") &&
    route.includes("freshness.result && !freshness.current"),
  staleQueueUsesAudioRevisionOperation:
    route.includes("reprocessMeetingOperationKey(id, freshness.audio.audioRevision)") &&
    route.includes("audioRevision: freshness.audio.audioRevision") &&
    route.includes("const staleResult = Boolean(freshness.result && !freshness.current)") &&
    route.includes("processingOperationKey: forceOperationKey ?? (staleResult"),
  clientsPollQueuedJobs:
    webApi.includes("pollMeetingFinalization") &&
    mobileApi.includes("pollMeetingFinalization") &&
    webApi.includes('payload.processing?.status === "queued"') &&
    mobileApi.includes('payload.processing?.status === "queued"') &&
    mobileTypes.includes('status: "queued" | "processing" | "completed" | "failed"'),
  statePersistsQueueMetadata:
    state.includes('status: "queued"') &&
    state.includes("jobId") &&
    state.includes("nextAttemptAt") &&
    state.includes("queueMeetingFinalization") &&
    state.includes("processingOperationKey?: string") &&
    state.includes("audioRevision?: string") &&
    state.includes("input.processingOperationKey ?? previous?.processingOperationKey") &&
    state.includes("input.audioRevision ?? previous?.audioRevision"),
  postgresJobOwnsProcessingIdentity:
    processingIdentityMigration.includes("processing_operation_key text") &&
    processingIdentityMigration.includes("audio_revision text") &&
    processingIdentityMigration.includes("meeting_finalization_jobs_audio_revision_valid") &&
    processingIdentityMigration.includes("0017_finalization_job_processing_identity") &&
    queue.includes("processingOperationKey?: string") &&
    queue.includes("audioRevision?: string") &&
    queue.includes("processing_operation_key, audio_revision") &&
    queue.includes("processingOperationKey: row.processing_operation_key") &&
    queue.includes("audioRevision: row.audio_revision"),
  postgresJobFreezesProcessingMode:
    processingModeMigration.includes("meeting_finalization_jobs") &&
    processingModeMigration.includes("processing_mode text") &&
    processingModeMigration.includes("'official_quota', 'byok'") &&
    route.includes("requestedMode: requestedProcessingMode") &&
    route.includes("processingMode,") &&
    queue.includes("processing_mode = coalesce(processing_mode, $4)") &&
    queue.includes("meeting_processing_mode_conflict") &&
    queue.includes("processingMode: job.processingMode") &&
    queue.includes('processingMode: row.processing_mode || "official_quota"'),
  workerUsesPostgresIdentityWhenObjectProjectionIsMissing:
    queue.includes("job.processingOperationKey ||") &&
    queue.includes("usageOperationKey: processingOperationKey") &&
    queue.includes("if (job.audioRevision)") &&
    queue.includes("freshness.audio.audioRevision !== job.audioRevision") &&
    queue.includes("processingOperationKey: job.processingOperationKey") &&
    queue.includes("audioRevision: job.audioRevision") &&
    !queue.includes("processingContext.processingOperationKey"),
  workerLoadsOwnerSafely:
    queue.includes("getUserById(job.ownerUserId)") &&
    authRepository.includes("export function getUserById(userId: string)"),
  envIsOptIn:
    envExample.includes("OWNMINUTES_FINALIZATION_MODE=inline") &&
    envExample.includes("OWNMINUTES_FINALIZATION_WORKER=0") &&
    envExample.includes("OWNMINUTES_FINALIZATION_MAX_ATTEMPTS=5"),
  runbookDocumentsBoundary:
    runbook.includes("PostgreSQL durable queue") &&
    runbook.includes("FOR UPDATE SKIP LOCKED") &&
    runbook.includes("OWNMINUTES_FINALIZATION_MODE=postgres-queue") &&
    runbook.includes("does not clear the PostgreSQL release blocker"),
  productionLikeFaultHarnessIsIsolated:
    queue.includes('process.env.OWNMINUTES_RUNTIME_PROFILE !== "production-like"') &&
    queue.includes('process.env.OWNMINUTES_FINALIZATION_TEST_HOOKS !== "1"') &&
    productionLikeCompose.includes('OWNMINUTES_RUNTIME_PROFILE: production-like') &&
    productionLikeCompose.includes('OWNMINUTES_FINALIZATION_TEST_HOOKS: "1"') &&
    !productionCompose.includes("OWNMINUTES_FINALIZATION_TEST_") &&
    !productionCompose.includes("OWNMINUTES_RUNTIME_PROFILE: production-like"),
  productionLikeExercisesActualRecovery:
    productionLikeStack.includes("runQueueRecoverySmoke") &&
    productionLikeStack.includes("smoke-production-like-queue-recovery.mjs") &&
    queueRecoverySmoke.includes('compose(["stop", "worker-2"])') &&
    queueRecoverySmoke.includes('compose(["kill", "worker-1"])') &&
    queueRecoverySmoke.includes('compose(["stop", "worker-1"])') &&
    queueRecoverySmoke.includes("onlySecondWorkerRunsDuringReclaim") &&
    queueRecoverySmoke.includes("secondWorkerReclaimedExpiredLease") &&
    queueRecoverySmoke.includes("temporaryFailureEnteredRetryWait") &&
    queueRecoverySmoke.includes("deleteProcessingProjection(retryMeetingId)") &&
    queueRecoverySmoke.includes("processing_operation_key, audio_revision") &&
    queueRecoverySmoke.includes("persistentFailureStoppedAtBound") &&
    queueRecoverySmoke.includes("accountAndJobsDeleted") &&
    ciWorkflow.includes("Run production-like queue recovery") &&
    ciWorkflow.includes("npm run stack:test") &&
    ciWorkflow.includes("Stop production-like stack"),
  noSecretsLeaked:
    !/postgres(?:ql)?:\/\/[^\s\]]+|AKL[A-Za-z0-9_-]+|sk-[A-Za-z0-9_-]+|Secret Access Key/i.test(serialized),
};

console.log(JSON.stringify(checks, null, 2));
if (Object.values(checks).some((value) => !value)) process.exitCode = 1;

function read(filePath) {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
}
