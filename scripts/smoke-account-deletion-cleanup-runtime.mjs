#!/usr/bin/env node

import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const databaseUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL || "";
if (!databaseUrl) {
  console.error("DATABASE_URL or POSTGRES_URL is required.");
  process.exit(1);
}
Object.assign(process.env, {
  DATABASE_URL: databaseUrl,
  OWNMINUTES_AUTH_REPOSITORY: "postgres",
  OWNMINUTES_MEETING_WRITE_LOCK: "postgres-advisory",
  OWNMINUTES_POSTGRES_IDLE_TIMEOUT_MS: "1000",
});
delete process.env.S3_BUCKET;
delete process.env.R2_BUCKET;
delete process.env.VOLCANO_TOS_BUCKET;

const require = createRequire(import.meta.url);
const { Pool } = require("pg");
const jiti = require("jiti")(join(process.cwd(), "scripts", "account-deletion-cleanup-runtime-loader.cjs"), {
  interopDefault: true,
  alias: { "@": join(process.cwd(), "src") },
});
const {
  assertAccountDeletionStorageIntegrity,
  refreshMeetingStorageIntegrityAudit,
  saveMeetingAudioChunk,
} = jiti("../src/lib/server/meeting-audio-store.ts");
const { getMeetingObjectStore, buildMeetingObjectKey, isMissingMeetingObjectError } = jiti("../src/lib/server/meeting-object-store.ts");
const {
  getAccountDeletionCleanupDiagnostics,
  replayDeadLetteredAccountDeletionCleanup,
  runAccountDeletionObjectCleanupOnce,
} = jiti("../src/lib/server/account-deletion-cleanup-worker.ts");
const { resolveAccountDeletionStatus, scheduleAccountDeletionCleanup } = jiti("../src/lib/server/account-deletion-state.ts");
const {
  meetingCatalogBackfillPrefixRef,
  resolveMeetingCatalogBackfillBlocker,
} = jiti("../src/lib/server/meeting-catalog.ts");
const { isMeetingWriteAllowed, meetingDeletionFenceRef } = jiti("../src/lib/server/meeting-write-lock.ts");
const {
  claimMeetingProviderStep,
  reserveMeetingFinalizationQuota,
  startMeetingProviderStep,
} = jiti("../src/lib/server/auth-repository.ts");

const pool = new Pool({ connectionString: databaseUrl, max: 2 });
const timestamp = Date.now();
const userId = `account-cleanup-user-${timestamp}`;
const meetingId = `account-cleanup-meeting-${timestamp}`;
const otherUserId = `account-cleanup-other-user-${timestamp}`;
const otherMeetingId = `account-cleanup-other-meeting-${timestamp}`;
const ownerlessLegacyPrefix = `account-cleanup-ownerless.${timestamp}`;
const freshWindowOwnerlessLegacyPrefix = `account-cleanup-fresh-window.${timestamp}`;
const email = `account-cleanup-${timestamp}@ownminutes.local`;
const otherEmail = `account-cleanup-other-${timestamp}@ownminutes.local`;
const objectStore = getMeetingObjectStore();
const fenceRef = meetingDeletionFenceRef(meetingId);
const usageEventId = `account-cleanup-usage-${timestamp}`;
let createdAggregateIds = [];
let replayAccountRef = "";
let catalogBackfillFailed = false;
const originalConsoleError = console.error;
console.error = (...args) => {
  if (String(args[0] || "").includes("Meeting catalog backfill failed")) {
    catalogBackfillFailed = true;
  }
  originalConsoleError(...args);
};

try {
  await pool.query(
    `insert into users (
       id, email, name, role, plan, official_minutes_total, official_minutes_used,
       password_salt, password_hash, created_at, email_verified_at
     ) values ($1,$2,'Account Cleanup Smoke','user','free',60,0,'salt','hash',now(),now())`,
    [userId, email],
  );
  await pool.query(
    `insert into users (
       id, email, name, role, plan, official_minutes_total, official_minutes_used,
       password_salt, password_hash, created_at, email_verified_at
     ) values ($1,$2,'Other Account Cleanup Smoke','user','free',60,0,'salt','hash',now(),now())`,
    [otherUserId, otherEmail],
  );
  await saveMeetingAudioChunk({
    meetingId,
    ownerUserId: userId,
    sequence: 1,
    buffer: Buffer.from("ACCOUNT_DELETION_ASYNC_OBJECT"),
    mimeType: "audio/webm",
    recordedAt: Date.now(),
    durationMs: 1_000,
  });
  await saveMeetingAudioChunk({
    meetingId: otherMeetingId,
    ownerUserId: otherUserId,
    sequence: 1,
    buffer: Buffer.from("OTHER_ACCOUNT_OBJECT_MUST_REMAIN"),
    mimeType: "audio/webm",
    recordedAt: Date.now(),
    durationMs: 1_000,
  });
  await objectStore.putText(buildMeetingObjectKey(otherMeetingId, "manifest"), "not-json");
  await objectStore.putText(`${ownerlessLegacyPrefix}/manifest.json`, "not-json");
  await pool.query("delete from meeting_storage_integrity_state");
  const blockedIntegrity = await refreshMeetingStorageIntegrityAudit();
  const ownerlessGateBlocksBeforeSoftDelete = await assertAccountDeletionStorageIntegrity().then(
    () => false,
    (error) => error?.code === "account_storage_integrity_blocked",
  );
  await objectStore.deletePrefix(ownerlessLegacyPrefix);
  await resolveMeetingCatalogBackfillBlocker(ownerlessLegacyPrefix);
  await pool.query("delete from meeting_storage_integrity_state");
  const repairedIntegrity = await refreshMeetingStorageIntegrityAudit();
  // Create an ownerless legacy prefix only after the zero-blocker audit is
  // fresh. The Worker must persist a blocker during account discovery instead
  // of trusting the cached audit and reporting this account as fully deleted.
  await objectStore.putText(`${freshWindowOwnerlessLegacyPrefix}/manifest.json`, "not-json");
  const aggregateIdsBefore = new Set(
    (await pool.query("select id from account_deletion_provider_cost_aggregates")).rows.map((row) => row.id),
  );
  const reservation = await reserveMeetingFinalizationQuota(userId, {
    durationMs: 60_000,
    meetingId,
    operationKey: `meeting:${meetingId}:initial`,
    processingRoute: "official_quota",
  });
  const claim = await claimMeetingProviderStep(userId, {
    reservationId: reservation.id,
    stage: { type: "finalization_asr" },
  });
  await startMeetingProviderStep(userId, {
    claimToken: claim.claimToken,
    stepId: claim.step.id,
  });
  await pool.query(
    `insert into usage_events (
       id, user_id, type, minutes, created_at, note, processing_reservation_id
     ) values ($1, $2, 'meeting_finalize', 1, now(), $3, $4)`,
    [
      usageEventId,
      userId,
      `Finalized meeting:${meetingId} result:2026-07-31T00:00:00.000Z route:official_quota processed:1 charged:1`,
      reservation.id,
    ],
  );
  await pool.query(
    `insert into meeting_share_analytics (
       meeting_id, view_count, first_viewed_at, last_viewed_at, updated_at
     ) values ($1, 2, now(), now(), now())
     on conflict (meeting_id) do update
       set view_count = excluded.view_count,
           first_viewed_at = excluded.first_viewed_at,
           last_viewed_at = excluded.last_viewed_at,
           updated_at = excluded.updated_at`,
    [meetingId],
  );
  await scheduleAccountDeletionCleanup(userId);
  await pool.query(
    "update users set deleted_at = now(), email = $2, name = 'Deleted user', password_salt = '', password_hash = '' where id = $1",
    [userId, `deleted+${userId}@invalid.local`],
  );

  await pool.query("update account_deletion_cleanup_jobs set attempt = 11 where user_id = $1", [userId]);
  const originalDeletePrefix = objectStore.deletePrefix.bind(objectStore);
  let deadLetterWorker;
  try {
    objectStore.deletePrefix = async (prefix, options) => {
      if (prefix === buildMeetingObjectKey(meetingId, "prefix")) {
        throw new Error("runtime smoke object cleanup failure");
      }
      return originalDeletePrefix(prefix, options);
    };
    deadLetterWorker = await runAccountDeletionObjectCleanupOnce(`account-cleanup-dead-letter-${timestamp}`);
  } finally {
    objectStore.deletePrefix = originalDeletePrefix;
  }
  const deadLetterStatus = await resolveAccountDeletionStatus(userId);
  const freshWindowBlocker = await pool.query(
    `select owner_user_id, reason
     from meeting_catalog_backfill_blockers
     where prefix_ref = $1 and resolved_at is null`,
    [meetingCatalogBackfillPrefixRef(freshWindowOwnerlessLegacyPrefix)],
  );
  const deadLetterDiagnostics = await getAccountDeletionCleanupDiagnostics(10);
  const deadLetterDiagnosticsText = JSON.stringify(deadLetterDiagnostics);
  const deadLetterNotReclaimed = await runAccountDeletionObjectCleanupOnce(`account-cleanup-no-reclaim-${timestamp}`);
  await objectStore.deletePrefix(freshWindowOwnerlessLegacyPrefix);
  await resolveMeetingCatalogBackfillBlocker(freshWindowOwnerlessLegacyPrefix);
  await pool.query("delete from meeting_storage_integrity_state");
  const freshWindowRepairIntegrity = await refreshMeetingStorageIntegrityAudit();
  const blockedReleaseGate = runCleanupGate();
  const replay = await replayDeadLetteredAccountDeletionCleanup({
    approvedBy: "account-cleanup-runtime-smoke",
    userId,
  });
  replayAccountRef = replay.accountRef;
  const replayedJob = await pool.query(
    `select attempt, dead_lettered_at, manual_replay_count, last_replayed_at, last_replayed_by_ref
     from account_deletion_cleanup_jobs where user_id = $1`,
    [userId],
  );

  const pendingBeforeWorker = await resolveAccountDeletionStatus(userId);
  const worker = await runAccountDeletionObjectCleanupOnce(`account-cleanup-worker-${timestamp}`);
  const statusAfterWorker = await resolveAccountDeletionStatus(userId);
  const [
    job,
    rawTombstone,
    fingerprintFence,
    remainingProcessing,
    aggregates,
    catalog,
    analytics,
    usage,
    resolvedOwnerRows,
    replayAudit,
  ] = await Promise.all([
    pool.query("select user_id from account_deletion_cleanup_jobs where user_id = $1", [userId]),
    pool.query("select meeting_id from meeting_deletion_tombstones where meeting_id = $1", [meetingId]),
    pool.query("select meeting_ref from meeting_deletion_fences where meeting_ref = $1", [fenceRef]),
    pool.query("select id from meeting_processing_reservations where user_id = $1", [userId]),
    pool.query("select id, provider_steps, official_minutes_settled from account_deletion_provider_cost_aggregates"),
    pool.query("select * from meetings where id = $1", [meetingId]),
    pool.query("select * from meeting_share_analytics where meeting_id = $1", [meetingId]),
    pool.query("select note, processing_reservation_id from usage_events where id = $1", [usageEventId]),
    pool.query(
      `select owner_user_id from meeting_catalog_backfill_blockers
       where owner_user_id = $1 and resolved_at is not null
       union all
       select owner_user_id from meeting_catalog_coverage_fences
       where owner_user_id = $1 and resolved_at is not null`,
      [userId],
    ),
    pool.query(
      `select user_id, event_type, target_type, metadata
       from audit_events
       where event_type = 'account_deletion_cleanup_replayed' and target_id = $1`,
      [replay.accountRef],
    ),
  ]);
  createdAggregateIds = aggregates.rows
    .filter((row) => !aggregateIdsBefore.has(row.id))
    .map((row) => row.id);
  const archivedCost = aggregates.rows.find((row) => createdAggregateIds.includes(row.id));
  const objectsRemoved = await objectStore.getText(buildMeetingObjectKey(meetingId, "manifest")).then(
    () => false,
    (error) => isMissingMeetingObjectError(error),
  );
  const cleanReleaseGate = runCleanupGate();
  const summary = {
    catalogBackfillRemainsAvailableForSoftDeletedOwners: !catalogBackfillFailed,
    accountImmediatelyPending: pendingBeforeWorker === "pending_cleanup",
    ownerlessIntegrityGateBlocksBeforeSoftDelete:
      blockedIntegrity.ready === false && ownerlessGateBlocksBeforeSoftDelete,
    ownerLinkedOtherPrefixDoesNotBlockIntegrity:
      repairedIntegrity.ready === true,
    freshAuditLateLegacyPrefixPersistsBlocker:
      freshWindowBlocker.rowCount === 1 &&
      freshWindowBlocker.rows[0]?.owner_user_id === null &&
      freshWindowBlocker.rows[0]?.reason === "legacy_noncanonical_unattributed" &&
      freshWindowRepairIntegrity.ready === true,
    deadLetterKeepsReceiptPending: deadLetterStatus === "pending_cleanup",
    strictReleaseGateTracksDeadLetterAndRecovery:
      blockedReleaseGate.status === 1 &&
      blockedReleaseGate.payload?.releaseBlocked === true &&
      Number(blockedReleaseGate.payload?.deadLetteredCount) >= 1 &&
      !blockedReleaseGate.output.includes(userId) &&
      cleanReleaseGate.status === 0 &&
      cleanReleaseGate.payload?.ok === true &&
      cleanReleaseGate.payload?.releaseBlocked === false,
    twelfthFailureDeadLettersAndStopsClaiming:
      deadLetterWorker.claimed === true &&
      deadLetterWorker.cleaned === false &&
      deadLetterWorker.deadLettered === true &&
      deadLetterNotReclaimed.claimed === false,
    deadLetterDiagnosticsArePseudonymous:
      deadLetterDiagnostics.releaseBlocked === true &&
      deadLetterDiagnostics.deadLetteredCount >= 1 &&
      deadLetterDiagnostics.inventory.some((item) => item.accountRef === replay.accountRef) &&
      !deadLetterDiagnosticsText.includes(userId),
    explicitReplayAuditedAndRequeues:
      replay.replayed === true &&
      /^account_[a-f0-9]{20}$/.test(replay.accountRef) &&
      Number(replayedJob.rows[0]?.attempt) === 0 &&
      replayedJob.rows[0]?.dead_lettered_at === null &&
      Number(replayedJob.rows[0]?.manual_replay_count) === 1 &&
      Boolean(replayedJob.rows[0]?.last_replayed_at) &&
      /^operator_[a-f0-9]{20}$/.test(String(replayedJob.rows[0]?.last_replayed_by_ref || "")),
    replayAuditSurvivesJobDeletionWithoutRawIdentity:
      replayAudit.rowCount === 1 &&
      replayAudit.rows[0]?.user_id === null &&
      replayAudit.rows[0]?.target_type === "account_deletion_cleanup_job" &&
      replayAudit.rows[0]?.metadata?.reasonCode === "manual_dead_letter_replay" &&
      !JSON.stringify(replayAudit.rows[0]).includes(userId),
    catalogAndAnalyticsPurged: catalog.rowCount === 0 && analytics.rowCount === 0,
    cleanupJobRemoved: job.rowCount === 0,
    fingerprintFenceRetained: fingerprintFence.rowCount === 1,
    lateWritesRemainRejected: (await isMeetingWriteAllowed(meetingId)) === false,
    objectsRemoved,
    rawIdentifiersMinimized: rawTombstone.rowCount === 0,
    resolvedCatalogRowsRetainNoOwner:
      resolvedOwnerRows.rowCount === 0,
    statusAfterWorker: statusAfterWorker === "deleted",
    unrelatedOwnerLinkedPrefixDoesNotBlockAccount:
      (await objectStore.listTopLevelPrefixes()).includes(otherMeetingId),
    startedProviderLedgerArchived:
      remainingProcessing.rowCount === 0 &&
      Number(archivedCost?.provider_steps) === 1 &&
      Number(archivedCost?.official_minutes_settled) === 1,
    usageIdentityMinimized:
      usage.rows[0]?.processing_reservation_id === null &&
      !String(usage.rows[0]?.note || "").includes(meetingId),
    workerClaimed: worker.claimed === true && worker.cleaned === true,
  };
  console.log(JSON.stringify(summary, null, 2));
  if (Object.values(summary).some((value) => value !== true)) process.exitCode = 1;
} finally {
  console.error = originalConsoleError;
  await objectStore.deletePrefix(buildMeetingObjectKey(meetingId, "prefix")).catch(() => undefined);
  await objectStore.deletePrefix(buildMeetingObjectKey(otherMeetingId, "prefix")).catch(() => undefined);
  await objectStore.deletePrefix(ownerlessLegacyPrefix).catch(() => undefined);
  await objectStore.deletePrefix(freshWindowOwnerlessLegacyPrefix).catch(() => undefined);
  await resolveMeetingCatalogBackfillBlocker(otherMeetingId).catch(() => undefined);
  await resolveMeetingCatalogBackfillBlocker(ownerlessLegacyPrefix).catch(() => undefined);
  await resolveMeetingCatalogBackfillBlocker(freshWindowOwnerlessLegacyPrefix).catch(() => undefined);
  await pool.query("delete from account_deletion_cleanup_jobs where user_id = $1", [userId]).catch(() => undefined);
  await pool.query("delete from meeting_deletion_tombstones where meeting_id = $1", [meetingId]).catch(() => undefined);
  await pool.query("delete from meeting_deletion_fences where meeting_ref = $1", [fenceRef]).catch(() => undefined);
  await pool.query("delete from usage_events where id = $1", [usageEventId]).catch(() => undefined);
  if (createdAggregateIds.length > 0) {
    await pool.query("delete from account_deletion_provider_cost_aggregates where id = any($1::text[])", [createdAggregateIds]).catch(() => undefined);
  }
  if (replayAccountRef) {
    await pool.query(
      "delete from audit_events where event_type = 'account_deletion_cleanup_replayed' and target_id = $1",
      [replayAccountRef],
    ).catch(() => undefined);
  }
  await pool.query("delete from users where id = $1", [userId]).catch(() => undefined);
  await pool.query("delete from users where id = $1", [otherUserId]).catch(() => undefined);
  await pool.end();
}

function runCleanupGate() {
  const result = spawnSync(
    process.execPath,
    ["scripts/check-account-deletion-cleanup-gate.mjs", "--strict"],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      env: process.env,
      timeout: 15_000,
    },
  );
  let payload = null;
  try {
    payload = JSON.parse(result.stdout || "");
  } catch {
    // The summary assertion below fails closed without exposing raw output.
  }
  return {
    output: `${result.stdout || ""}${result.stderr || ""}`,
    payload,
    status: result.status,
  };
}
