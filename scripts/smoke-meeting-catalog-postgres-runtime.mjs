#!/usr/bin/env node

import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";

const require = createRequire(import.meta.url);
const { Pool } = require("pg");
const databaseUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL || "";
const childMode = process.argv[2] === "--delete-child";

if (!databaseUrl) throw new Error("DATABASE_URL or POSTGRES_URL is required.");
if (process.env.OWNMINUTES_CATALOG_RUNTIME_SMOKE !== "1") {
  throw new Error("Set OWNMINUTES_CATALOG_RUNTIME_SMOKE=1 and use a disposable PostgreSQL database.");
}

if (childMode) {
  await runDeletionChild(process.argv[3] || "", process.argv[4] || "");
} else {
  await runMain();
  // jiti-loaded application modules own a separate global pg pool. Exit after
  // deterministic cleanup so the disposable runtime smoke stays bounded.
  process.exit(0);
}

async function runDeletionChild(meetingId, userId) {
  if (!meetingId || !userId) throw new Error("Deletion child requires meeting and user ids.");
  const jiti = require("jiti")(path.join(process.cwd(), "scripts", "meeting-catalog-runtime-loader.cjs"), {
    interopDefault: true,
    alias: { "@": path.join(process.cwd(), "src") },
  });
  const meetingStore = jiti("../src/lib/server/meeting-audio-store.ts");
  const result = await meetingStore.deleteUserMeeting(meetingId, userId);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exit(0);
}

async function runMain() {
  const suffix = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  const userId = `catalog-race-user-${suffix}`;
  const conflictUserId = `catalog-conflict-user-${suffix}`;
  const meetingId = `catalog-race-${suffix}`;
  const retryMeetingId = `catalog-retry-${suffix}`;
  const catalogOnlyMeetingId = `catalog-only-${suffix}`;
  const staleFenceMeetingId = `catalog-stale-fence-${suffix}`;
  const unresolvedFenceMeetingId = `catalog-unresolved-fence-${suffix}`;
  const ownerConflictMeetingId = `catalog-owner-conflict-${suffix}`;
  const costRaceMeetingId = `catalog-cost-race-${suffix}`;
  const processingReservationId = `catalog-reservation-${suffix}`;
  const usageEventId = `catalog-usage-${suffix}`;
  const finalizationJobId = `catalog-finalization-${suffix}`;
  const retryReservationId = `catalog-retry-reservation-${suffix}`;
  const retryProviderStepId = `catalog-retry-provider-${suffix}`;
  const retryUsageEventId = `catalog-retry-usage-${suffix}`;
  const retryFinalizationJobId = `catalog-retry-finalization-${suffix}`;
  const costRaceReservationId = `catalog-cost-race-reservation-${suffix}`;
  const costRaceProviderStepId = `catalog-cost-race-provider-${suffix}`;
  const legacyMeetingId = `legacy.catalog-${suffix}`;
  const unattributedMeetingId = `catalog-unattributed-${suffix}`;
  const bucket = "meeting-catalog-runtime-smoke";
  const objects = new Map();
  const manifestRead = deferred();
  const releaseManifestRead = deferred();
  let blockFirstCatalogManifestRead = true;
  let blockedDeleteMeetingId = "";

  objects.set(`${meetingId}/manifest.json`, Buffer.from(JSON.stringify(makeManifest(meetingId, userId))));
  objects.set(`${meetingId}/chunks/part-1.m4a`, Buffer.from("catalog-race-audio"));

  const objectServer = http.createServer(async (request, response) => {
    const url = new URL(request.url || "/", "http://127.0.0.1");
    const segments = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    const requestBucket = segments.shift();
    const key = segments.join("/");
    if (requestBucket !== bucket) return sendXml(response, 404, "<Error><Code>NoSuchBucket</Code></Error>");
    if (request.method === "GET" && url.searchParams.get("list-type") === "2") {
      return sendXml(response, 200, listObjectsXml(objects, url.searchParams));
    }
    if (request.method === "GET" && url.searchParams.has("versions")) {
      return sendXml(response, 200, "<ListVersionsResult><IsTruncated>false</IsTruncated></ListVersionsResult>");
    }
    if (request.method === "GET") {
      if (key === `${meetingId}/manifest.json` && blockFirstCatalogManifestRead) {
        blockFirstCatalogManifestRead = false;
        manifestRead.resolve();
        await releaseManifestRead.promise;
      }
      const value = objects.get(key);
      if (!value) return sendXml(response, 404, "<Error><Code>NoSuchKey</Code></Error>");
      response.writeHead(200, { "content-type": key.endsWith(".json") ? "application/json" : "application/octet-stream" });
      return response.end(value);
    }
    if (request.method === "DELETE") {
      if (blockedDeleteMeetingId && key.startsWith(`${blockedDeleteMeetingId}/`)) {
        return sendXml(response, 503, "<Error><Code>SlowDown</Code></Error>");
      }
      objects.delete(key);
      response.writeHead(204);
      return response.end();
    }
    return sendXml(response, 405, "<Error><Code>MethodNotAllowed</Code></Error>");
  });

  await listen(objectServer);
  const objectPort = objectServer.address().port;
  Object.assign(process.env, {
    OWNMINUTES_AUTH_REPOSITORY: "postgres",
    OWNMINUTES_MEETING_WRITE_LOCK: "postgres-advisory",
    OWNMINUTES_STORAGE_PREFIX: "",
    S3_ACCESS_KEY_ID: "catalog-runtime-access",
    S3_BUCKET: bucket,
    S3_ENDPOINT: `http://127.0.0.1:${objectPort}`,
    S3_REGION: "us-east-1",
    S3_SECRET_ACCESS_KEY: "catalog-runtime-secret",
  });

  const jiti = require("jiti")(path.join(process.cwd(), "scripts", "meeting-catalog-runtime-loader.cjs"), {
    interopDefault: true,
    alias: { "@": path.join(process.cwd(), "src") },
  });
  const meetingStore = jiti("../src/lib/server/meeting-audio-store.ts");
  const meetingCatalog = jiti("../src/lib/server/meeting-catalog.ts");
  const meetingLock = jiti("../src/lib/server/meeting-write-lock.ts");
  const meetingTransfer = jiti("../src/lib/server/meeting-transfer-intent.ts");
  const authRepository = jiti("../src/lib/server/auth-repository.ts");
  const processingLedger = jiti("../src/lib/server/account-deletion-processing-ledger.ts");
  const legacyCleanup = jiti("../src/lib/server/legacy-deletion-cleanup.ts");
  const pool = new Pool({ connectionString: databaseUrl, max: 4 });

  try {
    const schema = await pool.query(
      `select to_regclass('public.meeting_catalog_backfill_blockers') is not null as ready,
              to_regclass('public.meeting_catalog_coverage_fences') is not null as coverage_fences,
              to_regclass('public.meeting_object_transfer_intents') is not null as transfer_intents,
              exists(
                select 1 from ownminutes_schema_migrations
                where version = '0032_meeting_transfer_intents'
              ) as transfer_migration`,
    );
    assert.equal(schema.rows[0]?.ready, true, "apply migrations 0027 and 0030 before this runtime smoke");
    assert.equal(schema.rows[0]?.coverage_fences, true, "apply migration 0030 before this runtime smoke");
    assert.equal(schema.rows[0]?.transfer_intents, true, "apply migration 0032 before this runtime smoke");
    assert.equal(schema.rows[0]?.transfer_migration, true, "apply migration 0032 before this runtime smoke");
    await cleanupRows(pool, {
      legacyMeetingId,
      meetingId,
      retryMeetingId,
      catalogOnlyMeetingId,
      staleFenceMeetingId,
      unresolvedFenceMeetingId,
      ownerConflictMeetingId,
      costRaceMeetingId,
      unattributedMeetingId,
      userId,
      conflictUserId,
      meetingCatalog,
      meetingLock,
    });
    await pool.query(
      `insert into users (
         id, email, name, role, plan, official_minutes_total,
         official_minutes_used, password_salt, password_hash, created_at
       ) values ($1, $2, 'Catalog Runtime Smoke', 'user', 'free', 0, 0, 'salt', 'hash', now())`,
      [userId, `catalog-runtime-${suffix}@ownminutes.local`],
    );
    await pool.query(
      `insert into meeting_processing_reservations (
         id, user_id, meeting_id, operation_key, processing_route, status,
         processed_minutes, official_minutes_reserved, official_minutes_settled
       ) values ($1, $2, $3, $4, 'official_quota', 'finalized', 1, 0, 0)`,
      [processingReservationId, userId, meetingId, `meeting:${meetingId}:initial`],
    );
    await pool.query(
      `insert into usage_events (
         id, user_id, type, minutes, created_at, note, processing_reservation_id
       ) values ($1, $2, 'meeting_finalize', 0, now(), $3, $4)`,
      [
        usageEventId,
        userId,
        `Finalized meeting:${meetingId} result:2026-07-31T00:00:00.000Z route:official_quota processed:1 charged:0`,
        processingReservationId,
      ],
    );
    await pool.query(
      `insert into meeting_finalization_jobs (
         id, meeting_id, owner_user_id, title, status
       ) values ($1, $2, $3, 'Catalog processing title', 'queued')`,
      [finalizationJobId, meetingId, userId],
    );
    await pool.query("delete from meeting_catalog_state where catalog_key in ('meeting-catalog-v4', 'meeting-catalog-v5')");

    const historyPromise = meetingStore.listUserMeetings(userId);
    await withTimeout(manifestRead.promise, 5_000, "catalog backfill did not reach the blocked manifest read");
    const waitingBefore = await advisoryWaiterCount(pool);
    const deletionChild = startDeletionChild(meetingId, userId);
    await waitForAdvisoryWaiter(pool, waitingBefore, 5_000);
    assert.equal(deletionChild.exited(), false, "cross-process deletion bypassed the catalog meeting lock");

    releaseManifestRead.resolve();
    const [history, deletion] = await Promise.all([
      historyPromise,
      deletionChild.result(),
    ]);
    assert.deepEqual(history, []);
    assert.equal(deletion.cleanupPending, false);
    const [
      deletedCatalog,
      deletedAnalytics,
      deletedProcessing,
      deletedFinalization,
      minimizedUsage,
    ] = await Promise.all([
      pool.query("select * from meetings where id = $1", [meetingId]),
      pool.query("select * from meeting_share_analytics where meeting_id = $1", [meetingId]),
      pool.query("select * from meeting_processing_reservations where id = $1", [processingReservationId]),
      pool.query("select * from meeting_finalization_jobs where id = $1", [finalizationJobId]),
      pool.query(
        "select note, processing_reservation_id from usage_events where id = $1",
        [usageEventId],
      ),
    ]);
    assert.equal(deletedCatalog.rowCount, 0);
    assert.equal(deletedAnalytics.rowCount, 0);
    assert.equal(deletedProcessing.rowCount, 0);
    assert.equal(deletedFinalization.rowCount, 0);
    assert.equal(minimizedUsage.rows[0]?.processing_reservation_id, null);
    assert.equal(minimizedUsage.rows[0]?.note.includes(meetingId), false);
    assert.equal([...objects.keys()].some((key) => key.startsWith(`${meetingId}/`)), false);

    await pool.query(
      `insert into meeting_processing_reservations (
         id, user_id, meeting_id, operation_key, processing_route, status,
         processed_minutes, official_minutes_reserved, official_minutes_settled
       ) values ($1, $2, $3, $4, 'official_quota', 'finalized', 4, 3, 3)`,
      [costRaceReservationId, userId, costRaceMeetingId, `meeting:${costRaceMeetingId}:initial`],
    );
    await pool.query(
      `insert into meeting_processing_provider_steps (
         id, reservation_id, user_id, stage_key, stage_type, status,
         claim_token_hash, lease_expires_at, official_minutes_settled,
         free_trial_minutes_settled, completed_at
       ) values ($1, $2, $3, 'finalization:summary', 'finalization_summary', 'completed',
                 repeat('b', 64), now() + interval '5 minutes', 3, 1, now())`,
      [costRaceProviderStepId, costRaceReservationId, userId],
    );
    const aggregateBeforeConcurrentPurge = await readProviderCostTotals(pool);
    await Promise.all([
      withTransaction(pool, (client) =>
        processingLedger.archiveAndDeletePostgresMeetingProcessingLedger(
          client,
          userId,
          costRaceMeetingId,
        ),
      ),
      withTransaction(pool, (client) =>
        processingLedger.archiveAndDeletePostgresProcessingLedger(client, userId),
      ),
    ]);
    const aggregateAfterConcurrentPurge = await readProviderCostTotals(pool);
    assert.equal(aggregateAfterConcurrentPurge.providerSteps - aggregateBeforeConcurrentPurge.providerSteps, 1);
    assert.equal(aggregateAfterConcurrentPurge.officialMinutesSettled - aggregateBeforeConcurrentPurge.officialMinutesSettled, 3);
    assert.equal(aggregateAfterConcurrentPurge.freeTrialMinutesSettled - aggregateBeforeConcurrentPurge.freeTrialMinutesSettled, 1);
    assert.equal(
      (await pool.query("select 1 from meeting_processing_reservations where id = $1", [costRaceReservationId])).rowCount,
      0,
    );

    const expiredCatalogIntentId = await meetingTransfer.beginMeetingObjectTransferIntent({
      meetingId: staleFenceMeetingId,
      ownerUserId: userId,
      transferKind: "catalog_manifest",
    });
    objects.set(
      `${staleFenceMeetingId}/manifest.json`,
      Buffer.from(JSON.stringify(makeManifest(staleFenceMeetingId, userId))),
    );
    objects.set(`${staleFenceMeetingId}/chunks/part-1.m4a`, Buffer.from("expired-intent-audio"));
    await pool.query(
      `update meeting_object_transfer_intents
       set created_at = now() - interval '20 minutes',
           expires_at = now() - interval '10 minutes'
       where intent_id = $1`,
      [expiredCatalogIntentId],
    );
    assert.equal(await meetingCatalog.isMeetingCatalogReady(), false);
    const recoveredHistory = await meetingStore.listUserMeetings(userId);
    assert.equal(recoveredHistory.some((meeting) => meeting.meetingId === staleFenceMeetingId), true);
    assert.equal(
      (
        await pool.query(
          "select 1 from meeting_object_transfer_intents where intent_id = $1",
          [expiredCatalogIntentId],
        )
      ).rowCount,
      0,
    );
    assert.equal((await meetingStore.deleteUserMeeting(staleFenceMeetingId, userId)).cleanupPending, false);

    await meetingCatalog.upsertMeetingCatalog(makeProjection(catalogOnlyMeetingId, userId));
    await meetingCatalog.seedMeetingShareAnalytics({
      meetingId: catalogOnlyMeetingId,
      viewCount: 7,
      firstViewedAt: new Date(Date.now() - 2_000).toISOString(),
      lastViewedAt: new Date(Date.now() - 1_000).toISOString(),
    });
    const activeCatalogIntentId = await meetingTransfer.beginMeetingObjectTransferIntent({
      meetingId: unresolvedFenceMeetingId,
      ownerUserId: userId,
      transferKind: "catalog_manifest",
    });
    const catalogOnlyCleanup = await meetingStore.deleteAllUserMeetings(userId);
    assert.equal(catalogOnlyCleanup.cleanupPending, true);
    const [catalogOnlyRow, catalogOnlyAnalytics, unresolvedOwnerIntent] = await Promise.all([
      pool.query("select * from meetings where id = $1", [catalogOnlyMeetingId]),
      pool.query("select * from meeting_share_analytics where meeting_id = $1", [catalogOnlyMeetingId]),
      pool.query(
        `select owner_user_id, expires_at
         from meeting_object_transfer_intents
         where intent_id = $1`,
        [activeCatalogIntentId],
      ),
    ]);
    assert.equal(catalogOnlyRow.rowCount, 0);
    assert.equal(catalogOnlyAnalytics.rowCount, 0);
    assert.equal(unresolvedOwnerIntent.rows[0]?.owner_user_id, userId);
    await pool.query(
      `update meeting_object_transfer_intents
       set created_at = now() - interval '70 minutes',
           expires_at = now() - interval '5 minutes'
       where intent_id = $1`,
      [activeCatalogIntentId],
    );
    await pool.query(
      "update meeting_deletion_tombstones set cleanup_next_attempt_at = now() where meeting_id = $1",
      [unresolvedFenceMeetingId],
    );
    const expiredIntentCleanup = await meetingStore.runMeetingDeletionCleanupOnce(
      `catalog-intent-worker-${suffix}`,
      userId,
    );
    assert.equal(expiredIntentCleanup.claimed, true);
    assert.equal(expiredIntentCleanup.cleaned, true);
    assert.equal((await meetingStore.deleteAllUserMeetings(userId)).cleanupPending, false);

    objects.set(
      `${retryMeetingId}/manifest.json`,
      Buffer.from(JSON.stringify(makeManifest(retryMeetingId, userId))),
    );
    objects.set(`${retryMeetingId}/chunks/part-1.m4a`, Buffer.from("retry-owner-audio"));
    await meetingCatalog.upsertMeetingCatalog(makeProjection(retryMeetingId, userId));
    await meetingCatalog.seedMeetingShareAnalytics({
      meetingId: retryMeetingId,
      viewCount: 3,
      firstViewedAt: new Date(Date.now() - 2_000).toISOString(),
      lastViewedAt: new Date(Date.now() - 1_000).toISOString(),
    });
    await pool.query(
      `insert into meeting_processing_reservations (
         id, user_id, meeting_id, operation_key, processing_route, status,
         processed_minutes, official_minutes_reserved, official_minutes_settled
       ) values ($1, $2, $3, $4, 'official_quota', 'finalized', 3, 2, 2)`,
      [retryReservationId, userId, retryMeetingId, `meeting:${retryMeetingId}:initial`],
    );
    await pool.query(
      `insert into meeting_processing_provider_steps (
         id, reservation_id, user_id, stage_key, stage_type, status,
         claim_token_hash, lease_expires_at, official_minutes_settled,
         free_trial_minutes_settled, completed_at
       ) values ($1, $2, $3, 'finalization:asr', 'finalization_asr', 'completed',
                 repeat('a', 64), now() + interval '5 minutes', 2, 1, now())`,
      [retryProviderStepId, retryReservationId, userId],
    );
    await pool.query(
      `insert into usage_events (
         id, user_id, type, minutes, created_at, note, processing_reservation_id
       ) values ($1, $2, 'meeting_finalize', 3, now(), $3, $4)`,
      [
        retryUsageEventId,
        userId,
        `Finalized meeting:${retryMeetingId} result:2026-08-01T00:00:00.000Z route:official_quota processed:3 charged:2`,
        retryReservationId,
      ],
    );
    await pool.query(
      `insert into meeting_finalization_jobs (
         id, meeting_id, owner_user_id, title, status
       ) values ($1, $2, $3, 'Retry deletion private title', 'queued')`,
      [retryFinalizationJobId, retryMeetingId, userId],
    );
    const aggregateBeforeFailedDelete = await readProviderCostTotals(pool);
    blockedDeleteMeetingId = retryMeetingId;
    const pendingRetryDeletion = await meetingStore.deleteUserMeeting(retryMeetingId, userId);
    assert.equal(pendingRetryDeletion.cleanupPending, true);
    await authRepository.purgeMeetingProcessingLedger(userId, retryMeetingId);
    const [
      pendingCatalog,
      pendingTombstone,
      prematureFence,
      pendingAnalytics,
      pendingProcessing,
      pendingProviderStep,
      pendingFinalization,
      pendingUsage,
    ] = await Promise.all([
      pool.query(
        `select title, object_prefix, project, tags, total_bytes, total_chunks,
                duration_ms, transcript_count, has_result, generated_at,
                metadata_search_text, result_search_text, deleted_at
         from meetings
         where id = $1 and owner_user_id = $2`,
        [retryMeetingId, userId],
      ),
      pool.query(
        `select owner_user_id, cleanup_pending, cleanup_last_error
         from meeting_deletion_tombstones
         where meeting_id = $1`,
        [retryMeetingId],
      ),
      pool.query(
        "select 1 from meeting_deletion_fences where meeting_ref = $1",
        [meetingLock.meetingDeletionFenceRef(retryMeetingId)],
      ),
      pool.query("select 1 from meeting_share_analytics where meeting_id = $1", [retryMeetingId]),
      pool.query("select 1 from meeting_processing_reservations where id = $1", [retryReservationId]),
      pool.query("select 1 from meeting_processing_provider_steps where id = $1", [retryProviderStepId]),
      pool.query("select 1 from meeting_finalization_jobs where id = $1", [retryFinalizationJobId]),
      pool.query(
        "select note, processing_reservation_id from usage_events where id = $1",
        [retryUsageEventId],
      ),
    ]);
    const aggregateAfterFailedDelete = await readProviderCostTotals(pool);
    assert.equal(pendingCatalog.rows[0]?.title, "");
    assert.equal(pendingCatalog.rows[0]?.object_prefix.includes(retryMeetingId), false);
    assert.equal(pendingCatalog.rows[0]?.project, null);
    assert.deepEqual(pendingCatalog.rows[0]?.tags, []);
    assert.equal(Number(pendingCatalog.rows[0]?.total_bytes), 0);
    assert.equal(Number(pendingCatalog.rows[0]?.total_chunks), 0);
    assert.equal(Number(pendingCatalog.rows[0]?.duration_ms), 0);
    assert.equal(Number(pendingCatalog.rows[0]?.transcript_count), 0);
    assert.equal(pendingCatalog.rows[0]?.has_result, false);
    assert.equal(pendingCatalog.rows[0]?.generated_at, null);
    assert.equal(pendingCatalog.rows[0]?.metadata_search_text, "");
    assert.equal(pendingCatalog.rows[0]?.result_search_text, "");
    assert.ok(pendingCatalog.rows[0]?.deleted_at);
    assert.equal(pendingTombstone.rows[0]?.owner_user_id, userId);
    assert.equal(pendingTombstone.rows[0]?.cleanup_pending, true);
    assert.equal(prematureFence.rowCount, 0);
    assert.equal(pendingAnalytics.rowCount, 0);
    assert.equal(pendingProcessing.rowCount, 0);
    assert.equal(pendingProviderStep.rowCount, 0);
    assert.equal(pendingFinalization.rowCount, 0);
    assert.equal(pendingUsage.rows[0]?.processing_reservation_id, null);
    assert.equal(String(pendingUsage.rows[0]?.note || "").includes(retryMeetingId), false);
    assert.equal(aggregateAfterFailedDelete.providerSteps - aggregateBeforeFailedDelete.providerSteps, 1);
    assert.equal(aggregateAfterFailedDelete.officialMinutesSettled - aggregateBeforeFailedDelete.officialMinutesSettled, 2);
    assert.equal(aggregateAfterFailedDelete.freeTrialMinutesSettled - aggregateBeforeFailedDelete.freeTrialMinutesSettled, 1);
    assert.equal([...objects.keys()].some((key) => key.startsWith(`${retryMeetingId}/`)), true);

    blockedDeleteMeetingId = "";
    await pool.query(
      "update meeting_deletion_tombstones set cleanup_next_attempt_at = now() where meeting_id = $1",
      [retryMeetingId],
    );
    const retryCleanup = await meetingStore.runMeetingDeletionCleanupOnce(
      `catalog-retry-worker-${suffix}`,
      userId,
    );
    assert.equal(retryCleanup.claimed, true);
    assert.equal(retryCleanup.cleaned, true);
    const [retriedCatalog, retriedAnalytics, retriedTombstone, retriedFence] = await Promise.all([
      pool.query("select * from meetings where id = $1", [retryMeetingId]),
      pool.query("select * from meeting_share_analytics where meeting_id = $1", [retryMeetingId]),
      pool.query("select * from meeting_deletion_tombstones where meeting_id = $1", [retryMeetingId]),
      pool.query(
        "select meeting_ref from meeting_deletion_fences where meeting_ref = $1",
        [meetingLock.meetingDeletionFenceRef(retryMeetingId)],
      ),
    ]);
    assert.equal(retriedCatalog.rowCount, 0);
    assert.equal(retriedAnalytics.rowCount, 0);
    assert.equal(retriedTombstone.rowCount, 0);
    assert.equal(retriedFence.rowCount, 1);
    assert.equal([...objects.keys()].some((key) => key.startsWith(`${retryMeetingId}/`)), false);

    objects.set(`${legacyMeetingId}/manifest.json`, Buffer.from(JSON.stringify(makeManifest(legacyMeetingId, userId))));
    objects.set(`${legacyMeetingId}/chunks/part-1.m4a`, Buffer.from("legacy-owner-proven-audio"));
    await pool.query("delete from meeting_catalog_state where catalog_key in ('meeting-catalog-v4', 'meeting-catalog-v5')");
    const accountCleanup = await meetingStore.deleteAllUserMeetings(userId);
    assert.equal(accountCleanup.cleanupPending, true);
    const [legacyTombstone, blocker] = await Promise.all([
      pool.query(
        `select cleanup_pending, cleanup_disposition, cleanup_last_error
         from meeting_deletion_tombstones
         where meeting_id = $1 and owner_user_id = $2`,
        [legacyMeetingId, userId],
      ),
      pool.query(
        `select reason, resolved_at
         from meeting_catalog_backfill_blockers
         where prefix_ref = $1`,
        [meetingCatalog.meetingCatalogBackfillPrefixRef(legacyMeetingId)],
      ),
    ]);
    assert.equal(legacyTombstone.rows[0]?.cleanup_pending, true);
    assert.equal(legacyTombstone.rows[0]?.cleanup_disposition, "pending_manual_cleanup");
    assert.equal(legacyTombstone.rows[0]?.cleanup_last_error, "legacy_noncanonical_manual_cleanup_required");
    assert.equal(blocker.rows[0]?.reason, "legacy_noncanonical_owner_verified");
    assert.equal(blocker.rows[0]?.resolved_at, null);
    assert.equal(await meetingCatalog.isMeetingCatalogReady(), false);

    const resolution = await legacyCleanup.resolveLegacyMeetingDeletionCleanup({
      approvedBy: "catalog-runtime-smoke",
      meetingId: legacyMeetingId,
      ownerUserId: userId,
    });
    assert.equal(resolution.cleaned, true);
    assert.equal([...objects.keys()].some((key) => key.startsWith(`${legacyMeetingId}/`)), false);
    const resolvedBlocker = await pool.query(
      "select resolved_at from meeting_catalog_backfill_blockers where prefix_ref = $1",
      [meetingCatalog.meetingCatalogBackfillPrefixRef(legacyMeetingId)],
    );
    assert.equal(resolvedBlocker.rowCount, 0);

    await pool.query("delete from meeting_catalog_state where catalog_key in ('meeting-catalog-v4', 'meeting-catalog-v5')");
    assert.deepEqual(await meetingStore.listUserMeetings(userId), []);
    assert.equal(await meetingCatalog.isMeetingCatalogReady(), true);

    await pool.query(
      `insert into users (
         id, email, name, role, plan, official_minutes_total,
         official_minutes_used, password_salt, password_hash, created_at
       ) values ($1, $2, 'Conflicting Catalog Owner', 'user', 'free', 0, 0, 'salt', 'hash', now())`,
      [conflictUserId, `catalog-conflict-${suffix}@ownminutes.local`],
    );
    await meetingCatalog.upsertMeetingCatalog(makeProjection(ownerConflictMeetingId, conflictUserId));
    await pool.query(
      `insert into meeting_deletion_tombstones (
         meeting_id, owner_user_id, deleted_at, cleanup_pending,
         cleanup_next_attempt_at, cleanup_disposition
       ) values ($1, $2, now(), true, now(), 'automatic')`,
      [ownerConflictMeetingId, userId],
    );
    await assert.rejects(
      meetingStore.deleteAllUserMeetings(userId),
      /owner evidence conflicts with its deletion owner/i,
    );
    const ownerConflict = await pool.query(
      `select tombstone.cleanup_disposition, tombstone.cleanup_last_error,
              meeting.owner_user_id
       from meeting_deletion_tombstones tombstone
       join meetings meeting on meeting.id = tombstone.meeting_id
       where tombstone.meeting_id = $1`,
      [ownerConflictMeetingId],
    );
    assert.equal(ownerConflict.rows[0]?.owner_user_id, conflictUserId);
    assert.equal(ownerConflict.rows[0]?.cleanup_disposition, "pending_manual_cleanup");
    assert.equal(
      ownerConflict.rows[0]?.cleanup_last_error,
      "meeting_catalog_owner_conflict_manual_cleanup_required",
    );
    await pool.query("delete from meeting_deletion_tombstones where meeting_id = $1", [ownerConflictMeetingId]);
    await pool.query("delete from meetings where id = $1", [ownerConflictMeetingId]);
    await pool.query("delete from users where id = $1", [conflictUserId]);

    objects.set(
      `${unattributedMeetingId}/chunks/chunk-000001.m4a`,
      Buffer.from("chunk-committed-before-owner-manifest"),
    );
    const crashCleanup = await meetingStore.deleteAllUserMeetings(userId);
    assert.equal(crashCleanup.cleanupPending, true);
    assert.equal(
      [...objects.keys()].some((key) => key.startsWith(`${unattributedMeetingId}/`)),
      true,
    );
    const unattributedBlocker = await pool.query(
      `select reason, resolved_at
       from meeting_catalog_coverage_fences
       where prefix_ref = $1`,
      [meetingCatalog.meetingCatalogBackfillPrefixRef(unattributedMeetingId)],
    );
    assert.equal(unattributedBlocker.rows[0]?.reason, "canonical_unattributed");
    assert.equal(unattributedBlocker.rows[0]?.resolved_at, null);
    assert.equal(await meetingCatalog.isMeetingCatalogReady(), false);

    console.log(JSON.stringify({
      catalogDeleteRaceSerializedAcrossProcesses: true,
      catalogOnlyRowPurgedWhileCatalogNotReady: true,
      canonicalChunkCrashPrefixBlocksAccountCleanup: true,
      completedCatalogAndAnalyticsPhysicallyPurged: true,
      failedObjectDeletionRetainsScrubbedRetryTombstone: true,
      failedObjectDeletionImmediatelyMinimizesRelationalIdentity: true,
      repeatedMeetingLedgerPurgeDoesNotDoubleCountProviderCost: true,
      concurrentAccountAndMeetingCostArchiveCountsExactlyOnce: true,
      meetingProcessingIdentityPurgedAndUsageMinimized: true,
      legacyObjectOnlyPrefixCreatesDurableBlocker: true,
      legacyOwnerProofCreatesManualCleanupTombstone: true,
      catalogReadyRequiresResolvedBlockers: true,
      resolvedCatalogBlockersRetainNoOwnerLink: true,
      expiredCatalogTransferRecoveredWithoutFalseReady: true,
      activeTransferKeepsAccountCleanupPending: true,
      ownerConflictCannotFalselyCompleteDeletion: true,
      postgresRuntime: true,
    }, null, 2));
  } finally {
    releaseManifestRead.resolve();
    await cleanupRows(pool, {
      legacyMeetingId,
      meetingId,
      retryMeetingId,
      catalogOnlyMeetingId,
      staleFenceMeetingId,
      unresolvedFenceMeetingId,
      ownerConflictMeetingId,
      costRaceMeetingId,
      unattributedMeetingId,
      userId,
      conflictUserId,
      meetingCatalog,
      meetingLock,
    }).catch(() => undefined);
    await pool.end();
    await new Promise((resolve) => objectServer.close(resolve));
  }
}

function startDeletionChild(meetingId, userId) {
  const child = spawn(
    process.execPath,
    [new URL(import.meta.url).pathname, "--delete-child", meetingId, userId],
    {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let exitCode;
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
  const completion = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => {
      exitCode = code;
      if (code !== 0) {
        reject(new Error(`catalog deletion child failed (${code}): ${stderr || stdout}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout.trim()));
      } catch {
        reject(new Error(`catalog deletion child returned invalid JSON: ${stdout}`));
      }
    });
  });
  return {
    exited: () => exitCode !== undefined,
    result: () => completion,
  };
}

async function advisoryWaiterCount(pool) {
  const result = await pool.query(
    "select count(*) as count from pg_locks where locktype = 'advisory' and granted = false",
  );
  return Number(result.rows[0]?.count || 0);
}

async function waitForAdvisoryWaiter(pool, baseline, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await advisoryWaiterCount(pool)) > baseline) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("cross-process deletion never waited on the PostgreSQL meeting advisory lock");
}

async function readProviderCostTotals(pool) {
  const result = await pool.query(
    `select coalesce(sum(provider_steps), 0)::bigint as provider_steps,
            coalesce(sum(official_minutes_settled), 0)::bigint as official_minutes_settled,
            coalesce(sum(free_trial_minutes_settled), 0)::bigint as free_trial_minutes_settled
     from account_deletion_provider_cost_aggregates`,
  );
  return {
    providerSteps: Number(result.rows[0]?.provider_steps || 0),
    officialMinutesSettled: Number(result.rows[0]?.official_minutes_settled || 0),
    freeTrialMinutesSettled: Number(result.rows[0]?.free_trial_minutes_settled || 0),
  };
}

async function withTransaction(pool, operation) {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await operation(client);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function cleanupRows(pool, input) {
  await pool.query("delete from meeting_catalog_state where catalog_key in ('meeting-catalog-v4', 'meeting-catalog-v5')");
  const meetingIds = [
    input.meetingId,
    input.retryMeetingId,
    input.catalogOnlyMeetingId,
    input.staleFenceMeetingId,
    input.unresolvedFenceMeetingId,
    input.ownerConflictMeetingId,
    input.costRaceMeetingId,
    input.legacyMeetingId,
    input.unattributedMeetingId,
  ];
  const prefixRefs = meetingIds.map(input.meetingCatalog.meetingCatalogBackfillPrefixRef);
  await pool.query(
    "delete from meeting_object_transfer_intents where meeting_id = any($1::text[])",
    [meetingIds],
  );
  await Promise.all([
    pool.query(
      "delete from meeting_catalog_backfill_blockers where prefix_ref = any($1::text[])",
      [prefixRefs],
    ),
    pool.query(
      "delete from meeting_catalog_coverage_fences where prefix_ref = any($1::text[])",
      [prefixRefs],
    ),
  ]);
  await pool.query(
    "delete from meeting_deletion_fences where meeting_ref = any($1::text[])",
    [meetingIds.map(input.meetingLock.meetingDeletionFenceRef)],
  );
  await pool.query("delete from meeting_deletion_tombstones where meeting_id = any($1::text[])", [meetingIds]);
  await pool.query("delete from meetings where id = any($1::text[])", [meetingIds]);
  if (input.conflictUserId) {
    await pool.query("delete from users where id = $1", [input.conflictUserId]);
  }
  await pool.query("delete from users where id = $1", [input.userId]);
}

function makeManifest(meetingId, ownerUserId) {
  const now = new Date().toISOString();
  return {
    meetingId,
    ownerUserId,
    metadata: {
      participants: [],
      tags: ["catalog-runtime"],
      title: "Catalog deletion race",
    },
    shareAnalytics: { viewCount: 0 },
    share: { visibility: "private", includeTranscript: false },
    chunks: [{
      sequence: 1,
      fileName: "part-1.m4a",
      bytes: 18,
      mimeType: "audio/mp4",
      recordedAt: Date.now(),
      durationMs: 1_000,
      receivedAt: now,
    }],
    totalBytes: 18,
    updatedAt: now,
  };
}

function makeProjection(meetingId, ownerUserId) {
  const updatedAt = new Date().toISOString();
  return {
    meetingId,
    ownerUserId,
    title: `Catalog metadata ${meetingId}`,
    objectPrefix: meetingId,
    project: "Private project",
    tags: ["private", "catalog"],
    shareVisibility: "public",
    shareIncludeTranscript: true,
    shareExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    totalBytes: 1234,
    totalChunks: 4,
    durationMs: 56_789,
    updatedAt,
  };
}

function listObjectsXml(objects, searchParams) {
  const prefix = searchParams.get("prefix") || "";
  const delimiter = searchParams.get("delimiter") || "";
  const keys = [...objects.keys()].filter((key) => key.startsWith(prefix)).sort();
  if (delimiter === "/") {
    const prefixes = new Set();
    for (const key of keys) {
      const rest = key.slice(prefix.length);
      const index = rest.indexOf(delimiter);
      if (index >= 0) prefixes.add(`${prefix}${rest.slice(0, index + 1)}`);
    }
    return `<ListBucketResult>${[...prefixes].map((value) => `<CommonPrefixes><Prefix>${escapeXml(value)}</Prefix></CommonPrefixes>`).join("")}</ListBucketResult>`;
  }
  return `<ListBucketResult>${keys.map((key) => `<Contents><Key>${escapeXml(key)}</Key><Size>${objects.get(key)?.byteLength || 0}</Size></Contents>`).join("")}</ListBucketResult>`;
}

function sendXml(response, status, body) {
  response.writeHead(status, { "content-type": "application/xml" });
  response.end(body);
}

function escapeXml(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function deferred() {
  let resolve;
  const promise = new Promise((nextResolve) => { resolve = nextResolve; });
  return { promise, resolve };
}

async function withTimeout(promise, timeoutMs, message) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
}
