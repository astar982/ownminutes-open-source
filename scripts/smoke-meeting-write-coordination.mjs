#!/usr/bin/env node

import fs from "node:fs";

const lock = read("src/lib/server/meeting-write-lock.ts");
const errors = read("src/lib/server/meeting-errors.ts");
const store = read("src/lib/server/meeting-audio-store.ts");
const chunksRoute = read("src/app/api/meetings/[id]/chunks/route.ts");
const meetingRoute = read("src/app/api/meetings/[id]/route.ts");
const shareRoute = read("src/app/api/meetings/[id]/share/route.ts");
const finalizeRoute = read("src/app/api/meetings/[id]/finalize/route.ts");
const accountDeleteRoute = read("src/app/api/auth/delete/route.ts");
const finalizer = read("src/lib/server/meeting-finalizer.ts");
const postgres = read("src/lib/server/postgres-runtime.ts");
const migration = read("db/migrations/0009_meeting_deletion_tombstones.sql");
const cleanupMigration = read("db/migrations/0019_processing_mode.sql");
const recordingUploadStore = read("src/lib/server/recording-upload-store.ts");
const realtimeSessionStore = read("src/lib/server/realtime-session-store.ts");
const realtimeRoute = read("src/app/api/meetings/[id]/realtime-chunks/route.ts");
const volcanoRealtime = read("src/lib/server/volcano-realtime-asr.ts");
const finalizationState = read("src/lib/server/meeting-finalization-state.ts");
const processingCheckpoint = read("src/lib/server/meeting-processing-checkpoint.ts");
const finalizationQueue = read("src/lib/server/finalization-queue.ts");
const diagnostics = read("src/lib/storage-diagnostics.ts");
const preflight = read("scripts/check-object-storage-production-env.mjs");
const env = read(".env.example");
const runtimeSmoke = read("scripts/smoke-meeting-write-coordination-runtime.mjs");
const publicSharePage = read("src/app/share/[id]/page.tsx");
const publicShareMarkdown = read("src/app/api/share/[id]/markdown/route.ts");
const privateExportRoute = read("src/app/api/meetings/[id]/export/route.ts");
const obsidianExportRoute = read("src/app/api/meetings/[id]/obsidian/route.ts");
const backupBarrierSmoke = read("scripts/smoke-backup-consistency-barrier.mjs");
const transferIntent = read("src/lib/server/meeting-transfer-intent.ts");
const transferMigration = read("db/migrations/0032_meeting_transfer_intents.sql");
const accountDeletionState = read("src/lib/server/account-deletion-state.ts");
const processingLedger = read("src/lib/server/account-deletion-processing-ledger.ts");

const summary = {
  sharedPostgresPool:
    postgres.includes('Symbol.for("ownminutes.postgres-runtime-pool")') &&
    postgres.includes("OWNMINUTES_POSTGRES_POOL_MAX") &&
    postgres.includes("OWNMINUTES_POSTGRES_CONNECT_TIMEOUT_MS"),
  advisoryLock:
    lock.includes("pg_advisory_lock") &&
    lock.includes("pg_advisory_unlock") &&
    lock.includes("OWNMINUTES_MEETING_WRITE_LOCK_TIMEOUT_MS"),
  backupCrossStoreWriteBarrier:
    lock.includes("MEETING_BACKUP_BARRIER_LOCK_KEY") &&
    lock.includes("pg_advisory_lock_shared") &&
    lock.includes("pg_advisory_unlock_shared") &&
    backupBarrierSmoke.includes("meetingMutationHoldsSharedBackupBarrier") &&
    backupBarrierSmoke.includes("backupExclusiveBarrierBlocksNewMutation"),
  structuredLockTimeout:
    lock.includes('candidate.code === "55P03"') &&
    lock.includes('code: "meeting_write_lock_timeout"') &&
    lock.includes("retryAfterSeconds") &&
    errors.includes("export class MeetingAccessError") &&
    errors.includes('"Retry-After"'),
  retryableApiResponse:
    chunksRoute.includes("meetingAccessErrorBody") &&
    chunksRoute.includes("meetingAccessErrorHeaders") &&
    meetingRoute.includes("meetingErrorResponse") &&
    shareRoute.includes("meetingAccessErrorHeaders") &&
    finalizeRoute.includes("meetingAccessErrorHeaders") &&
    accountDeleteRoute.includes("meetingAccessErrorHeaders") &&
    finalizer.includes('code: error.code || "meeting_deleted_or_inaccessible"') &&
    finalizer.includes("retryable: error.retryable"),
  durableDeletionFence:
    migration.includes("create table if not exists meeting_deletion_tombstones") &&
    migration.includes("on delete cascade") &&
    lock.includes("markMeetingDeleted") &&
    lock.includes("isMeetingWriteAllowed") &&
    lock.includes("getMeetingDeletionOwner"),
  canonicalMeetingIdsCannotCollide:
    store.includes('/^[a-zA-Z0-9_-]{1,160}$/') &&
    realtimeSessionStore.includes('/^[a-zA-Z0-9_-]{1,160}$/') &&
    recordingUploadStore.includes('/^[a-zA-Z0-9_-]{1,160}$/') &&
    lock.includes("where meeting_deletion_tombstones.owner_user_id = excluded.owner_user_id"),
  durableDeferredObjectCleanup:
    cleanupMigration.includes("cleanup_pending boolean not null default true") &&
    cleanupMigration.includes("meeting_deletion_tombstones_cleanup_idx") &&
    lock.includes("for update skip locked") &&
    lock.includes("canonicalMeetingDeletionCleanupSqlPredicate") &&
    lock.includes("quarantineNonCanonicalMeetingDeletionTombstones") &&
    lock.includes("legacy_noncanonical_manual_cleanup_required") &&
    lock.includes("cleanup_disposition = 'pending_manual_cleanup'") &&
    !lock.includes("markLegacyMeetingDeletedForCleanup") &&
    !lock.includes("safeMeetingDeletionCleanupId") &&
    lock.includes("claimMeetingDeletionCleanup") &&
    lock.includes("cleanup_claim_token") &&
    lock.includes("claimToken ?? null") &&
    store.includes("runMeetingDeletionCleanupOnce") &&
    store.includes("completeMeetingDeletionCleanup") &&
    store.includes("retryMeetingDeletionCleanup"),
  logicallyDeletedMeetingsStayInaccessible:
    store.includes("if (!(await isMeetingWriteAllowed(meetingKey)))") &&
    store.includes("if (!(await isMeetingWriteAllowed(meetingId))) return null") &&
    store.includes("const analytics = await enqueueMeetingAccess(meetingId"),
  idempotentDeleteReportsCleanupState:
    store.includes("const deletionOwner = await getMeetingDeletionOwner(meetingKey)") &&
    store.includes("deleteMeetingObjectPrefixWithRetries") &&
    store.includes("attempt <= 3") &&
    store.includes("cleanupPending: false") &&
    store.includes("cleanupPending: true") &&
    store.includes("Meeting object cleanup is pending after logical deletion"),
  allMeetingMutationsCoordinated:
    store.includes("withMeetingWriteLock") &&
    store.includes("return withMeetingWriteFence(key, () => operation())") &&
    store.includes("return withMeetingWriteLock(key, operation)") &&
    store.includes("withUserWriteLock(input.ownerUserId") &&
    store.includes("saveMeetingAudioChunkUnsafe") &&
    store.includes("saveMeetingResultUnsafe") &&
    store.includes("return enqueueMeetingWrite(meetingId") &&
    store.includes("return enqueueMeetingWrite(input.meetingId, async () =>") &&
    store.includes("expectedAudioRevision?: string") &&
    store.includes('code: "audio_revision_changed"') &&
    store.includes("await markMeetingDeleted(meetingKey, userId)"),
  lateProcessingWritesCannotResurrectDeletedMeeting:
    lock.includes("localMeetingWriteQueues") &&
    lock.includes("heldMeetingWriteLocks") &&
    lock.includes("withMeetingWriteFence") &&
    lock.includes('code: "meeting_deleted"') &&
    realtimeSessionStore.includes("withMeetingWriteFence") &&
    finalizationState.includes("withMeetingWriteFence") &&
    processingCheckpoint.includes("withMeetingWriteFence") &&
    finalizer.includes("const preflight = await withMeetingWriteFence(input.meetingId") &&
    finalizer.includes("return await withMeetingWriteFence(input.meetingId") &&
    finalizer.includes("await withMeetingWriteFence(input.meetingId") &&
    finalizationQueue.includes("withMeetingWriteFence(meetingId") &&
    finalizationQueue.includes("meeting_deletion_tombstones tombstone") &&
    runtimeSmoke.includes("deleteDoesNotWaitForExternalProvider") &&
    runtimeSmoke.includes("lateProviderResultCannotResurrectDeletedMeeting") &&
    runtimeSmoke.includes("providerCostFenceReconciledAfterDelete"),
  readsAreLinearizedWithDeletion:
    store.includes("readMeetingAccessUnsafe") &&
    store.includes("readUserMeetingDetailUnsafe") &&
    store.includes("assertMeetingOwnerUnsafe") &&
    store.includes("return enqueueMeetingAccess(meetingKey, () => readMeetingAccessUnsafe") &&
    store.includes("return enqueueMeetingAccess(meetingKey, () => readUserMeetingDetailUnsafe") &&
    store.includes("mapWithConcurrency(") &&
    store.includes("(meetingId) => enqueueMeetingAccess(meetingId") &&
    store.includes("readMeetingShareSnapshotUnsafe") &&
    store.includes("await assertMeetingOwnerUnsafe(meetingKey, meetingId, userId)") &&
    runtimeSmoke.includes("deleteStayedQueuedBehindRead") &&
    runtimeSmoke.includes("meetingReadIsLinearizedWithDelete"),
  shareAndExportReadsUseSingleDeletionSnapshot:
    store.includes("readMeetingShareSnapshotUnsafe") &&
    publicSharePage.includes("readMeetingShareSnapshot(id)") &&
    !publicSharePage.includes("readMeetingResult(id)") &&
    publicShareMarkdown.includes("readMeetingShareSnapshot(id)") &&
    !publicShareMarkdown.includes("readMeetingResult(id)") &&
    privateExportRoute.includes("detail.obsidianMarkdown || detail.result?.obsidianMarkdown") &&
    !privateExportRoute.includes("readMeetingMarkdown") &&
    obsidianExportRoute.includes("detail.obsidianMarkdown || detail.result?.obsidianMarkdown") &&
    !obsidianExportRoute.includes("readMeetingMarkdown"),
  accountDeletionFenced:
    lock.includes("withUserWriteLock") &&
    lock.includes("listMeetingDeletionIdsForOwner") &&
    read("src/app/api/auth/delete/route.ts").includes("withUserWriteLock(user.id") &&
    store.includes("listMeetingDeletionIdsForOwner(ownerUserId)") &&
    store.includes("classifyCanonicalMeetingPrefixOwnership") &&
    store.includes("ownership.status === \"quarantined\"") &&
    store.includes("cleanupPending = true") &&
    store.includes("This account was deleted and cannot accept more audio.") &&
    accountDeleteRoute.indexOf("assertAccountDeletionStorageIntegrity()") < accountDeleteRoute.indexOf("scheduleAccountDeletionCleanup(user.id)") &&
    accountDeleteRoute.indexOf("scheduleAccountDeletionCleanup(user.id)") < accountDeleteRoute.indexOf("deleteAccount(user.id)") &&
    accountDeleteRoute.includes("if (!cleanup.scheduled)") &&
    accountDeleteRoute.includes("deleteAllUserMeetings(user.id)") &&
    accountDeleteRoute.includes("cancelAccountDeletionCleanupForActiveUser(user.id)") &&
    runtimeSmoke.includes("accountDeleteAcceptedAfterInFlightUpload") &&
    runtimeSmoke.includes("accountDeleteCompletesAsynchronously") &&
    runtimeSmoke.includes("waitForAccountDeletionStatus"),
  deletedUploadsRejected:
    store.includes("This meeting was deleted and cannot accept more audio.") &&
    store.includes("This meeting was deleted and cannot accept a result."),
  recordingUploadStatusUsesWriterFence:
    store.includes("readMeetingRecordingUploadStatus(input") &&
    store.includes("enqueueMeetingWrite(input.meetingId, () => readMeetingRecordingUploadStatusUnsafe(input))") &&
    runtimeSmoke.includes("recordingUploadStatusRejectedWith410"),
  realtimeProviderCallsUseShortAdvisoryLocks:
    realtimeRoute.includes("withRealtimeMutationFence(user.id, id") &&
    realtimeRoute.includes("withUserWriteLock(userId") &&
    realtimeRoute.includes("withRealtimeSessionLock(meetingId") &&
    realtimeRoute.includes("withMeetingWriteFence(meetingId, operation)") &&
    realtimeRoute.indexOf("const transcription = await adapter.acceptChunk") >
      realtimeRoute.indexOf('if (preflight.kind === "response")') &&
    realtimeRoute.indexOf("await finishVolcanoRealtimeSession") >
      realtimeRoute.indexOf("const preflight = await withRealtimeMutationFence", realtimeRoute.indexOf("export async function DELETE")) &&
    realtimeSessionStore.includes("ensureRealtimeSessionOwnership") &&
    volcanoRealtime.includes("OWNMINUTES_RUNTIME_SMOKE_REALTIME_PROVIDER_URL"),
  blockedRealtimeDeletionRuntimeGates:
    runtimeSmoke.includes("blockedRealtimeProvidersRemainLockFree") &&
    runtimeSmoke.includes("meetingDeleteCompletesDuringBlockedRealtimeProvider") &&
    runtimeSmoke.includes("accountDeleteCompletesDuringBlockedRealtimeProvider") &&
    runtimeSmoke.includes("blockedRealtimeLateResultsRejected") &&
    runtimeSmoke.includes("blockedRealtimeCannotResurrectObjects") &&
    runtimeSmoke.includes("blockedRealtimeProviderLedgerReconciled") &&
    runtimeSmoke.includes("await delay(20_000)"),
  blockedStorageIoRuntimeGates:
    runtimeSmoke.includes("blockedStorageIoDoesNotHoldDeleteLocks") &&
    runtimeSmoke.includes("snapshotTransientPutLosesToDelete") &&
    runtimeSmoke.includes("snapshotChunkGetLosesToDelete") &&
    runtimeSmoke.includes("recordingPartStagingPutLosesToDelete") &&
    runtimeSmoke.includes("recordingCommitCanonicalPutLosesToDelete") &&
    runtimeSmoke.includes("blockedStorageLateWritesLeaveNoObjects") &&
    runtimeSmoke.includes("scheduleGateRelease(snapshotPutGate, 20_000)") &&
    runtimeSmoke.includes("scheduleGateRelease(snapshotGetGate, 20_000)") &&
    runtimeSmoke.includes("scheduleGateRelease(recordingPartGate, 20_000)") &&
    runtimeSmoke.includes("scheduleGateRelease(recordingCommitGate, 20_000)"),
  durableLockFreeTransferIntents:
    transferMigration.includes("create table if not exists meeting_object_transfer_intents") &&
    transferMigration.includes("account_deletion_provider_cost_source_ref_idx") &&
    transferIntent.includes("beginMeetingObjectTransferIntent") &&
    transferIntent.includes("resolveExpiredMeetingObjectTransfersForDeletion") &&
    store.includes('transferKind: "recording_staging"') &&
    store.includes('transferKind: "recording_commit"') &&
    store.includes('transferKind: "asr_transient"') &&
    store.includes("listMeetingObjectTransferOwnersForMeeting") &&
    lock.includes("Meeting object transfer must settle") &&
    accountDeletionState.includes("hasPendingMeetingObjectTransfersForOwner"),
  deletionCostArchiveIdempotent:
    processingLedger.includes("select id from users where id = $1 for update") &&
    processingLedger.includes("on conflict (source_ref) where source_ref is not null do nothing") &&
    processingLedger.includes("archiveAndDeletePostgresMeetingProcessingLedger") &&
    store.indexOf("purgeMeetingProcessingLedger(userId, meetingKey)") <
      store.indexOf("deleteMeetingObjectPrefixWithRetries(meetingKey, signal)"),
  productionGate:
    diagnostics.includes("supportsCrossInstanceWrites") &&
    diagnostics.includes("preventsDeletedMeetingRecreation") &&
    preflight.includes('"cross-instance-write-lock"') &&
    preflight.includes('"durable-deletion-fence"'),
  envDocumented:
    env.includes("OWNMINUTES_MEETING_WRITE_LOCK=auto") &&
    env.includes("OWNMINUTES_POSTGRES_POOL_MAX=10"),
  noSecretsLeaked: ![lock, errors, store, chunksRoute, meetingRoute, shareRoute, finalizeRoute, accountDeleteRoute, finalizer, finalizationState, processingCheckpoint, finalizationQueue, postgres, migration, cleanupMigration, transferMigration, transferIntent, processingLedger, accountDeletionState, recordingUploadStore, realtimeSessionStore, realtimeRoute, volcanoRealtime, diagnostics, env, runtimeSmoke]
    .join("\n")
    .match(/AKL[A-Za-z0-9_-]{12,}|sk-proj-[A-Za-z0-9_-]{12,}|WVRCaE[A-Za-z0-9_-]{8,}|-----BEGIN PRIVATE KEY-----/),
};

console.log(JSON.stringify(summary, null, 2));

if (Object.values(summary).some((value) => value !== true)) process.exitCode = 1;

function read(path) {
  return fs.existsSync(path) ? fs.readFileSync(path, "utf8") : "";
}
