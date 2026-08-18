#!/usr/bin/env node

import http from "node:http";
import net from "node:net";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const { Pool } = require("pg");
const databaseUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL || "";
const serverWorkdir = process.env.SMOKE_SERVER_WORKDIR || process.cwd();
const bucket = "ownminutes-write-coordination-smoke";
const accessKeyId = "write-coordination-access";
const secretAccessKey = "write-coordination-secret";
const timestamp = Date.now();
const meetingId = `write-coordination-${timestamp}`;
const cleanupFailureMeetingId = `write-coordination-cleanup-${timestamp}`;
const realtimeDeleteRaceMeetingId = `write-coordination-realtime-delete-${timestamp}`;
const realtimeBlockedMeetingDeleteId = `write-coordination-realtime-provider-delete-${timestamp}`;
const realtimeBlockedAccountDeleteId = `write-coordination-realtime-provider-account-${timestamp}`;
const realtimeBlockedFinishDeleteId = `write-coordination-realtime-finish-delete-${timestamp}`;
const snapshotDeleteRaceMeetingId = `write-coordination-snapshot-delete-${timestamp}`;
const snapshotGetDeleteRaceMeetingId = `write-coordination-snapshot-get-delete-${timestamp}`;
const snapshotCleanupRaceMeetingId = `write-coordination-snapshot-cleanup-${timestamp}`;
const recordingPartDeleteRaceMeetingId = `write-coordination-recording-part-delete-${timestamp}`;
const recordingCommitDeleteRaceMeetingId = `write-coordination-recording-commit-delete-${timestamp}`;
const recordingPartUploadId = `recording-part-${timestamp}`;
const recordingCommitUploadId = `recording-commit-${timestamp}`;
const readDeleteRaceMeetingId = `write-coordination-read-delete-${timestamp}`;
const providerDeleteRaceMeetingId = `write-coordination-provider-delete-${timestamp}`;
const accountMeetingId = `write-coordination-account-${timestamp}`;
const objects = new Map();
let activeManifestReads = 0;
let maxConcurrentManifestReads = 0;
const deleteFailuresRemaining = new Map();
const blockedPuts = new Map();
const blockedPutPrefixes = new Map();
const blockedGets = new Map();
let providerRequestCount = 0;
let providerRequestStarted;
let releaseProviderRequest;
const providerStarted = new Promise((resolve) => { providerRequestStarted = resolve; });
const providerRelease = new Promise((resolve) => { releaseProviderRequest = resolve; });
const runtimeAuthDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ownminutes-write-coordination-auth-"));
const runtimeResultPath = process.env.SMOKE_RESULT_PATH || "";
let runtimeResult = { exitCode: null, stage: "startup", summary: null };
process.on("exit", (exitCode) => {
  if (!runtimeResultPath) return;
  fs.writeFileSync(runtimeResultPath, `${JSON.stringify({ ...runtimeResult, exitCode }, null, 2)}\n`, { mode: 0o600 });
});
const blockedRealtimeProviderKeys = new Set([
  `accept:${realtimeBlockedMeetingDeleteId}`,
  `accept:${realtimeBlockedAccountDeleteId}`,
  `finish:${realtimeBlockedFinishDeleteId}`,
]);
const realtimeProviderStarts = new Map(
  [...blockedRealtimeProviderKeys].map((key) => [key, createDeferred()]),
);

async function fetch(input, init = {}) {
  const method = String(init.method || (input instanceof Request ? input.method : "GET")).toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") {
    return globalThis.fetch(input, init);
  }

  const headers = new Headers(input instanceof Request ? input.headers : undefined);
  new Headers(init.headers).forEach((value, name) => headers.set(name, value));
  if (!headers.has("origin")) {
    const requestUrl = input instanceof Request ? input.url : String(input);
    const origin = new URL(requestUrl);
    // Next's production server canonicalizes direct IPv4 loopback requests to
    // localhost in Request.url. Mirror that browser-facing origin here while
    // keeping each spawned instance's port isolated.
    if (origin.hostname === "127.0.0.1") origin.hostname = "localhost";
    headers.set("origin", origin.origin);
  }
  return globalThis.fetch(input, { ...init, headers });
}

if (!databaseUrl) {
  console.error("DATABASE_URL or POSTGRES_URL is required.");
  process.exit(1);
}

assertRuntimeBuildFresh();
await main();

function assertRuntimeBuildFresh() {
  const buildIdPath = path.join(serverWorkdir, ".next", "BUILD_ID");
  if (!fs.existsSync(buildIdPath)) {
    throw new Error("Missing .next/BUILD_ID. Run `npm run build` before the runtime coordination smoke.");
  }
  const buildMtime = fs.statSync(buildIdPath).mtimeMs;
  const runtimeSources = [
    "src/lib/server/meeting-audio-store.ts",
    "src/lib/server/meeting-write-lock.ts",
    "src/lib/server/finalization-queue.ts",
    "src/lib/server/meeting-finalization-state.ts",
    "src/lib/server/meeting-finalizer.ts",
    "src/lib/server/meeting-processing-checkpoint.ts",
    "src/lib/server/realtime-session-store.ts",
    "src/lib/server/volcano-realtime-asr.ts",
    "src/app/api/meetings/[id]/realtime-chunks/route.ts",
    "src/lib/server/recording-upload-store.ts",
    "src/app/api/meetings/[id]/recording-upload/route.ts",
    "src/app/api/meetings/[id]/route.ts",
    "src/app/api/auth/delete/route.ts",
    "src/lib/server/account-deletion-cleanup-worker.ts",
    "src/lib/server/account-deletion-state.ts",
    "src/lib/server/account-deletion-ticket.ts",
  ];
  const newerSource = runtimeSources.find((source) => {
    const sourcePath = path.join(serverWorkdir, source);
    return fs.existsSync(sourcePath) && fs.statSync(sourcePath).mtimeMs > buildMtime;
  });
  if (newerSource) {
    throw new Error(`Runtime build is older than ${newerSource}. Run \`npm run build\` before this smoke.`);
  }
}

async function main() {
  const s3 = createFakeS3Server();
  const provider = createFakeProviderServer();
  await listen(s3, 0);
  await listen(provider, 0);
  const s3Port = s3.address().port;
  const providerPort = provider.address().port;
  const runtimeMeetingStore = loadRuntimeMeetingStore(s3Port);
  const runtimeRealtimeStore = loadRuntimeRealtimeStore(s3Port);
  const [portA, portB] = await Promise.all([getFreePort(), getFreePort()]);
  const appA = startNext(portA, s3Port, providerPort, "app-a");
  const appB = startNext(portB, s3Port, providerPort, "app-b");
  const baseA = `http://127.0.0.1:${portA}`;
  const baseB = `http://127.0.0.1:${portB}`;
  const pool = new Pool({ connectionString: databaseUrl, max: 2 });

  try {
    await Promise.all([waitForApp(baseA, appA), waitForApp(baseB, appB)]);
    const registration = await postJson(`${baseA}/api/auth/register`, {
      name: "Write Coordination Smoke",
      email: `write-coordination-${timestamp}@ownminutes.local`,
      password: `OwnMinutes-${timestamp}`,
    });
    const cookie = registration.response.headers.get("set-cookie")?.split(";")[0] || "";
    if (!registration.response.ok || !cookie) {
      throw new Error(
        `Registration failed in write coordination smoke (${registration.response.status}): ${JSON.stringify(registration.payload)}`,
      );
    }
    const ownerUserId = registration.payload.user?.id;
    if (typeof ownerUserId !== "string" || !ownerUserId) throw new Error("Registration did not return a user id.");
    // Public production registration is intentionally never allowed to create
    // an administrator. Promote only this disposable smoke user in the test DB
    // so the protected diagnostics route can be asserted with real admin auth.
    await pool.query("update users set role = 'admin' where id = $1", [ownerUserId]);

    const chunks = Array.from({ length: 24 }, (_, index) => {
      const sequence = index + 1;
      const content = Buffer.from(`WRITE_COORDINATION_CHUNK_${String(sequence).padStart(3, "0")}_${"x".repeat(sequence)}`);
      return { sequence, content, baseUrl: sequence % 2 === 0 ? baseA : baseB };
    });
    const uploads = await Promise.all(chunks.map((chunk) => uploadChunk(chunk.baseUrl, cookie, meetingId, chunk.sequence, chunk.content)));
    const maxConcurrentInitialManifestReads = maxConcurrentManifestReads;
    const detail = await getJson(`${baseA}/api/meetings/${meetingId}`, cookie);
    const manifest = JSON.parse(objects.get(`${meetingId}/manifest.json`)?.toString("utf8") || "{}");
    const expectedBytes = chunks.reduce((sum, chunk) => sum + chunk.content.byteLength, 0);
    const outsiderRegistration = await postJson(`${baseB}/api/auth/register`, {
      name: "Write Coordination Outsider",
      email: `write-coordination-outsider-${timestamp}@ownminutes.local`,
      password: `OwnMinutes-outsider-${timestamp}`,
    });
    const outsiderCookie = outsiderRegistration.response.headers.get("set-cookie")?.split(";")[0] || "";
    const crossOwnerUpload = await uploadChunk(baseB, outsiderCookie, meetingId, 99, Buffer.from("CROSS_OWNER"), false);
    const invalidAliasUpload = await uploadChunk(baseB, cookie, `${meetingId}!`, 99, Buffer.from("INVALID_ALIAS"), false);
    const invalidAliasDelete = await fetch(`${baseB}/api/meetings/${meetingId}!`, { method: "DELETE", headers: { Cookie: cookie } });

    const deletion = await fetch(`${baseA}/api/meetings/${meetingId}`, { method: "DELETE", headers: { Cookie: cookie } });
    const deletionPayload = await readJson(deletion);
    const staleUpload = await uploadChunk(baseB, cookie, meetingId, 25, Buffer.from("STALE_AFTER_DELETE"), false);
    const staleMetadataWrite = await fetch(`${baseB}/api/meetings/${meetingId}`, {
      method: "PATCH",
      headers: { Cookie: cookie, "content-type": "application/json" },
      body: JSON.stringify({ title: "MUST_NOT_RESURRECT" }),
    });
    const staleRecordingUploadStatus = await fetch(
      `${baseB}/api/meetings/${meetingId}/recording-upload?uploadId=${encodeURIComponent(`recording-status-${timestamp}`)}`,
      { headers: { Cookie: cookie } },
    );
    await waitForDeletionCleanup(pool, meetingId);
    const remainingObjects = [...objects.keys()].filter((key) => key.startsWith(`${meetingId}/`));
    const deletionProof = await readMeetingDeletionProof(pool, meetingId);
    const diagnostics = await getJson(`${baseB}/api/storage/diagnostics`, cookie);
    const realtimePutGate = blockNextPut(`${realtimeDeleteRaceMeetingId}/realtime-session.json`);
    const realtimeWrite = uploadRealtimeChunk(baseA, cookie, realtimeDeleteRaceMeetingId, 1, false);
    await realtimePutGate.started;
    const realtimeDelete = fetch(`${baseB}/api/meetings/${realtimeDeleteRaceMeetingId}`, {
      method: "DELETE",
      headers: { Cookie: cookie },
    });
    const deletionStayedQueued = await Promise.race([
      realtimeDelete.then(() => false),
      delay(100).then(() => true),
    ]);
    realtimePutGate.release();
    const [realtimeWriteResult, realtimeDeleteResponse] = await Promise.all([realtimeWrite, realtimeDelete]);
    const realtimeDeletePayload = await readJson(realtimeDeleteResponse);
    const lateRealtimeWrite = await uploadRealtimeChunk(baseA, cookie, realtimeDeleteRaceMeetingId, 2, false);
    const realtimeRaceObjects = [...objects.keys()].filter((key) => key.startsWith(`${realtimeDeleteRaceMeetingId}/`));

    const realtimeAccountRegistration = await postJson(`${baseA}/api/auth/register`, {
      name: "Blocked Realtime Account",
      email: `blocked-realtime-account-${timestamp}@ownminutes.local`,
      password: `OwnMinutes-blocked-realtime-${timestamp}`,
    });
    const realtimeAccountCookie = realtimeAccountRegistration.response.headers.get("set-cookie")?.split(";")[0] || "";
    const realtimeAccountUserId = realtimeAccountRegistration.payload.user?.id;
    if (!realtimeAccountRegistration.response.ok || !realtimeAccountCookie || !realtimeAccountUserId) {
      throw new Error("Blocked realtime account registration failed.");
    }
    const blockedAccountDeletionTicket = await getJson(`${baseA}/api/auth/delete`, realtimeAccountCookie);
    const providerCostAggregateBefore = await readProviderCostAggregateTotals(pool);
    await runtimeRealtimeStore.ensureRealtimeSessionOwnership({
      meetingId: realtimeBlockedFinishDeleteId,
      ownerUserId,
      provider: "volcano",
    });

    // These three provider calls deliberately remain blocked for 20 seconds.
    // Meeting and account deletion must complete while no user/meeting lock is
    // held by acceptChunk or finishVolcanoRealtimeSession.
    const blockedMeetingRealtime = uploadRealtimeChunk(baseA, cookie, realtimeBlockedMeetingDeleteId, 1, false);
    const blockedAccountRealtime = uploadRealtimeChunk(baseB, realtimeAccountCookie, realtimeBlockedAccountDeleteId, 1, false);
    const blockedFinish = fetch(`${baseA}/api/meetings/${realtimeBlockedFinishDeleteId}/realtime-chunks`, {
      method: "DELETE",
      headers: { Cookie: cookie },
    });
    await Promise.all([
      waitForRealtimeProviderStart(`accept:${realtimeBlockedMeetingDeleteId}`),
      waitForRealtimeProviderStart(`accept:${realtimeBlockedAccountDeleteId}`),
      waitForRealtimeProviderStart(`finish:${realtimeBlockedFinishDeleteId}`),
    ]);
    const blockedProvidersStillPending = await Promise.all([
      promiseStillPending(blockedMeetingRealtime),
      promiseStillPending(blockedAccountRealtime),
      promiseStillPending(blockedFinish),
    ]);

    const [blockedMeetingDeletion, blockedAccountDeletion, blockedFinishDeletion] = await Promise.all([
      timedFetch(`${baseB}/api/meetings/${realtimeBlockedMeetingDeleteId}`, {
        method: "DELETE",
        headers: { Cookie: cookie },
      }),
      timedFetch(`${baseA}/api/auth/delete`, {
        method: "DELETE",
        headers: { Cookie: realtimeAccountCookie },
      }),
      timedFetch(`${baseB}/api/meetings/${realtimeBlockedFinishDeleteId}`, {
        method: "DELETE",
        headers: { Cookie: cookie },
      }),
    ]);
    const blockedMeetingDeletionPayload = await readJson(blockedMeetingDeletion.response);
    const blockedAccountDeletionPayload = await readJson(blockedAccountDeletion.response);
    const blockedFinishDeletionPayload = await readJson(blockedFinishDeletion.response);
    const [blockedMeetingLateResult, blockedAccountLateResult, blockedFinishLateResult] = await Promise.all([
      blockedMeetingRealtime,
      blockedAccountRealtime,
      blockedFinish.then(async (response) => ({ status: response.status, payload: await readJson(response) })),
    ]);
    await Promise.all([
      waitForDeletionCleanup(pool, realtimeBlockedMeetingDeleteId),
      waitForDeletionCleanup(pool, realtimeBlockedAccountDeleteId),
      waitForDeletionCleanup(pool, realtimeBlockedFinishDeleteId),
      waitForProcessingLedgerCleanup(pool, realtimeAccountUserId),
    ]);
    const blockedAccountDeletionStatus = await waitForAccountDeletionStatus(
      baseA,
      blockedAccountDeletionTicket.ticket,
    );
    runtimeResult.stage = "blocked-realtime-completed";
    const blockedRealtimeObjects = [...objects.keys()].filter((key) =>
      key.startsWith(`${realtimeBlockedMeetingDeleteId}/`) ||
      key.startsWith(`${realtimeBlockedAccountDeleteId}/`) ||
      key.startsWith(`${realtimeBlockedFinishDeleteId}/`),
    );
    const blockedMeetingProviderLedger = await pool.query(
      `select count(*)::int as active_rows
       from meeting_processing_reservations reservation
       left join meeting_processing_provider_steps step on step.reservation_id = reservation.id
       where reservation.meeting_id = $1`,
      [realtimeBlockedMeetingDeleteId],
    );
    const blockedAccountProviderLedger = await pool.query(
      `select count(*)::int as active_rows
       from meeting_processing_reservations reservation
       left join meeting_processing_provider_steps step on step.reservation_id = reservation.id
       where reservation.user_id = $1`,
      [realtimeAccountUserId],
    );
    const providerCostAggregateAfter = await waitForProviderCostAggregateDelta(
      pool,
      providerCostAggregateBefore,
      { providerSteps: 2, officialMinutesSettled: 2 },
    );
    const snapshotWav = buildSilentWavBuffer();
    await uploadChunk(baseA, cookie, snapshotDeleteRaceMeetingId, 1, snapshotWav, true, "audio/wav");
    await runtimeMeetingStore.sealMeetingAudio({
      meetingId: snapshotDeleteRaceMeetingId,
      ownerUserId,
      expectedLastSequence: 1,
      totalBytes: snapshotWav.byteLength,
    });
    const deletionSnapshot = await runtimeMeetingStore.prepareMeetingAudioSnapshot(snapshotDeleteRaceMeetingId);
    const snapshotPutGate = blockNextPutPrefix(`${snapshotDeleteRaceMeetingId}/transient/asr/`);
    scheduleGateRelease(snapshotPutGate, 20_000);
    const snapshotPrepare = deletionSnapshot.prepareForAsr().then(
      (value) => ({ ok: true, value }),
      (error) => ({ ok: false, error }),
    );

    await uploadChunk(baseA, cookie, snapshotGetDeleteRaceMeetingId, 1, snapshotWav, true, "audio/wav");
    await runtimeMeetingStore.sealMeetingAudio({
      meetingId: snapshotGetDeleteRaceMeetingId,
      ownerUserId,
      expectedLastSequence: 1,
      totalBytes: snapshotWav.byteLength,
    });
    const snapshotGetGate = blockNextGet(`${snapshotGetDeleteRaceMeetingId}/chunks/chunk-000001.wav`);
    scheduleGateRelease(snapshotGetGate, 20_000);
    const snapshotGetPrepare = runtimeMeetingStore.prepareMeetingAudioSnapshot(snapshotGetDeleteRaceMeetingId).then(
      (value) => ({ ok: true, value }),
      (error) => ({ ok: false, error }),
    );

    const recordingPartGate = blockNextPut(
      `${recordingPartDeleteRaceMeetingId}/uploads/${recordingPartUploadId}/parts/part-0000.bin`,
    );
    scheduleGateRelease(recordingPartGate, 20_000);
    const recordingPartWrite = uploadRecordingPart({
      baseUrl: baseA,
      buffer: snapshotWav,
      cookie,
      meetingId: recordingPartDeleteRaceMeetingId,
      uploadId: recordingPartUploadId,
    });

    await uploadRecordingPart({
      baseUrl: baseA,
      buffer: snapshotWav,
      cookie,
      meetingId: recordingCommitDeleteRaceMeetingId,
      uploadId: recordingCommitUploadId,
    });
    const recordingCommitGate = blockNextPut(`${recordingCommitDeleteRaceMeetingId}/chunks/chunk-000001.wav`);
    scheduleGateRelease(recordingCommitGate, 20_000);
    const recordingCommit = commitRecordingUpload({
      baseUrl: baseB,
      cookie,
      meetingId: recordingCommitDeleteRaceMeetingId,
      uploadId: recordingCommitUploadId,
    });

    await Promise.all([
      snapshotPutGate.started,
      snapshotGetGate.started,
      recordingPartGate.started,
      recordingCommitGate.started,
    ]);
    const blockedStorageOperationsPending = await Promise.all([
      promiseStillPending(snapshotPrepare),
      promiseStillPending(snapshotGetPrepare),
      promiseStillPending(recordingPartWrite),
      promiseStillPending(recordingCommit),
    ]);
    const [snapshotDelete, snapshotGetDelete, recordingPartDelete, recordingCommitDelete] = await Promise.all([
      timedFetch(`${baseB}/api/meetings/${snapshotDeleteRaceMeetingId}`, { method: "DELETE", headers: { Cookie: cookie } }),
      timedFetch(`${baseA}/api/meetings/${snapshotGetDeleteRaceMeetingId}`, { method: "DELETE", headers: { Cookie: cookie } }),
      timedFetch(`${baseB}/api/meetings/${recordingPartDeleteRaceMeetingId}`, { method: "DELETE", headers: { Cookie: cookie } }),
      timedFetch(`${baseA}/api/meetings/${recordingCommitDeleteRaceMeetingId}`, { method: "DELETE", headers: { Cookie: cookie } }),
    ]);
    const [snapshotDeletePayload, snapshotGetDeletePayload, recordingPartDeletePayload, recordingCommitDeletePayload] = await Promise.all([
      readJson(snapshotDelete.response),
      readJson(snapshotGetDelete.response),
      readJson(recordingPartDelete.response),
      readJson(recordingCommitDelete.response),
    ]);
    const [snapshotPrepareResult, snapshotGetPrepareResult, recordingPartResult, recordingCommitResult] = await Promise.all([
      snapshotPrepare,
      snapshotGetPrepare,
      recordingPartWrite,
      recordingCommit,
    ]);
    await deletionSnapshot.cleanup().catch(() => undefined);
    if (snapshotGetPrepareResult.ok) await snapshotGetPrepareResult.value.cleanup().catch(() => undefined);
    await Promise.all([
      waitForDeletionCleanup(pool, snapshotDeleteRaceMeetingId),
      waitForDeletionCleanup(pool, snapshotGetDeleteRaceMeetingId),
      waitForDeletionCleanup(pool, recordingPartDeleteRaceMeetingId),
      waitForDeletionCleanup(pool, recordingCommitDeleteRaceMeetingId),
    ]);
    const blockedStorageObjects = [...objects.keys()].filter((key) =>
      key.startsWith(`${snapshotDeleteRaceMeetingId}/`) ||
      key.startsWith(`${snapshotGetDeleteRaceMeetingId}/`) ||
      key.startsWith(`${recordingPartDeleteRaceMeetingId}/`) ||
      key.startsWith(`${recordingCommitDeleteRaceMeetingId}/`),
    );
    runtimeResult.stage = "blocked-storage-completed";

    await uploadChunk(baseA, cookie, snapshotCleanupRaceMeetingId, 1, snapshotWav, true, "audio/wav");
    await runtimeMeetingStore.sealMeetingAudio({
      meetingId: snapshotCleanupRaceMeetingId,
      ownerUserId,
      expectedLastSequence: 1,
      totalBytes: snapshotWav.byteLength,
    });
    const cleanupSnapshot = await runtimeMeetingStore.prepareMeetingAudioSnapshot(snapshotCleanupRaceMeetingId);
    const cleanupPutGate = blockNextPutPrefix(`${snapshotCleanupRaceMeetingId}/transient/asr/`);
    const cleanupPrepareOutcome = cleanupSnapshot.prepareForAsr().then(
      () => ({ completed: true }),
      (error) => ({ completed: false, error }),
    );
    await cleanupPutGate.started;
    const cleanupDuringPut = cleanupSnapshot.cleanup();
    const cleanupStayedQueuedBehindPut = await Promise.race([
      cleanupDuringPut.then(() => false),
      delay(100).then(() => true),
    ]);
    cleanupPutGate.release();
    const [cleanupPrepareResult] = await Promise.all([cleanupPrepareOutcome, cleanupDuringPut]);
    await cleanupSnapshot.cleanup();
    const cleanupTransientObjects = [...objects.keys()].filter((key) =>
      key.startsWith(`${snapshotCleanupRaceMeetingId}/transient/asr/`),
    );
    await uploadChunk(baseA, cookie, readDeleteRaceMeetingId, 1, Buffer.from("READ_DELETE_BARRIER"));
    const manifestReadGate = blockNextGet(`${readDeleteRaceMeetingId}/manifest.json`);
    const inFlightDetail = fetch(`${baseA}/api/meetings/${readDeleteRaceMeetingId}`, { headers: { Cookie: cookie } });
    await manifestReadGate.started;
    const deleteAfterRead = fetch(`${baseB}/api/meetings/${readDeleteRaceMeetingId}`, {
      method: "DELETE",
      headers: { Cookie: cookie },
    });
    const deleteStayedQueuedBehindRead = await Promise.race([
      deleteAfterRead.then(() => false),
      delay(100).then(() => true),
    ]);
    manifestReadGate.release();
    const [inFlightDetailResponse, deleteAfterReadResponse] = await Promise.all([inFlightDetail, deleteAfterRead]);
    const detailAfterDelete = await fetch(`${baseA}/api/meetings/${readDeleteRaceMeetingId}`, { headers: { Cookie: cookie } });

    await uploadChunk(baseA, cookie, providerDeleteRaceMeetingId, 1, snapshotWav, true, "audio/wav");
    await runtimeMeetingStore.sealMeetingAudio({
      meetingId: providerDeleteRaceMeetingId,
      ownerUserId,
      expectedLastSequence: 1,
      totalBytes: snapshotWav.byteLength,
    });
    const runtimeFinalizer = loadRuntimeMeetingFinalizer(s3Port, providerPort);
    const providerFinalization = runtimeFinalizer.finalizeMeetingForUser({
      meetingId: providerDeleteRaceMeetingId,
      user: registration.payload.user,
    }).then(
      (value) => ({ ok: true, value }),
      (error) => ({ ok: false, error }),
    );
    await providerStarted;
    const providerStillBlockedBeforeDelete = await Promise.race([
      providerFinalization.then(() => false),
      delay(100).then(() => true),
    ]);
    const providerDeleteStartedAt = Date.now();
    const providerDeleteResponse = await fetch(`${baseB}/api/meetings/${providerDeleteRaceMeetingId}`, {
      method: "DELETE",
      headers: { Cookie: cookie },
    });
    const providerDeleteElapsedMs = Date.now() - providerDeleteStartedAt;
    const providerDeletePayload = await readJson(providerDeleteResponse);
    releaseProviderRequest();
    const providerFinalizationOutcome = await providerFinalization;
    const providerRaceObjects = [...objects.keys()].filter((key) => key.startsWith(`${providerDeleteRaceMeetingId}/`));
    const providerStepsAfterDelete = await pool.query(
      `select step.status,
              step.official_minutes_settled as step_official_minutes_settled,
              reservation.released_at,
              reservation.official_minutes_settled as reservation_official_minutes_settled
       from meeting_processing_provider_steps step
       inner join meeting_processing_reservations reservation on reservation.id = step.reservation_id
       where reservation.meeting_id = $1
       order by step.created_at asc`,
      [providerDeleteRaceMeetingId],
    );
    const providerCostAggregateAfterProviderDelete = await waitForProviderCostAggregateDelta(
      pool,
      providerCostAggregateAfter,
      { providerSteps: 1, officialMinutesSettled: 1 },
    );
    const providerUsageAfterDelete = await pool.query(
      `select id from usage_events
       where user_id = $1 and type = 'meeting_finalize' and note like $2`,
      [ownerUserId, `%meeting:${providerDeleteRaceMeetingId}%`],
    );
    await uploadChunk(baseA, cookie, cleanupFailureMeetingId, 1, Buffer.from("CLEANUP_FAILURE_RETRY"));
    deleteFailuresRemaining.set(`${cleanupFailureMeetingId}/manifest.json`, 3);
    const cleanupFailureDelete = await fetch(`${baseA}/api/meetings/${cleanupFailureMeetingId}`, { method: "DELETE", headers: { Cookie: cookie } });
    const cleanupFailurePayload = await readJson(cleanupFailureDelete);
    const hiddenAfterLogicalDelete = await fetch(`${baseB}/api/meetings/${cleanupFailureMeetingId}`, { headers: { Cookie: cookie } });
    await waitForDeletionCleanup(pool, cleanupFailureMeetingId);
    const historyAfterLogicalDelete = await getJson(`${baseB}/api/meetings`, cookie);
    const cleanupFailureRemainingObjects = [...objects.keys()].filter((key) => key.startsWith(`${cleanupFailureMeetingId}/`));
    const cleanupDeletionProof = await readMeetingDeletionProof(pool, cleanupFailureMeetingId);
    const inFlightAccountUpload = uploadChunk(baseB, cookie, accountMeetingId, 1, Buffer.from("IN_FLIGHT_DURING_ACCOUNT_DELETE"));
    await waitForObject(`${accountMeetingId}/chunks/chunk-000001.webm`);
    const accountDeletionTicket = await getJson(`${baseA}/api/auth/delete`, cookie);
    const accountDelete = await fetch(`${baseA}/api/auth/delete`, { method: "DELETE", headers: { Cookie: cookie } });
    await delay(10);
    const preauthenticatedQueuedUpload = uploadChunk(baseA, cookie, `queued-behind-account-delete-${timestamp}`, 1, Buffer.from("QUEUED_BEHIND_ACCOUNT_DELETE"), false);
    const [accountUploadResult, accountDeletePayload, queuedUploadResult] = await Promise.all([
      inFlightAccountUpload,
      readJson(accountDelete),
      preauthenticatedQueuedUpload,
    ]);
    const accountDeletionStatus = await waitForAccountDeletionStatus(baseB, accountDeletionTicket.ticket);
    await waitForDeletionCleanup(pool, accountMeetingId);
    const accountObjects = [...objects.keys()].filter((key) => key.startsWith(`${accountMeetingId}/`));
    const accountUserAfterDelete = await pool.query(
      "select id, deleted_at, email from users where id = $1",
      [ownerUserId],
    );
    runtimeResult.stage = "account-deletion-completed";
    const afterAccountDeleteUpload = await uploadChunk(baseB, cookie, `after-account-delete-${timestamp}`, 1, Buffer.from("AFTER_ACCOUNT_DELETE"), false);

    const summary = {
      bothInstancesStarted: true,
      registrationSharedAcrossInstances: uploads.every((upload) => upload.status === 200),
      allConcurrentUploadsAccepted: uploads.length === chunks.length && uploads.every((upload) => upload.payload?.ok === true),
      manifestContainsEverySequence:
        Array.isArray(manifest.chunks) &&
        manifest.chunks.length === chunks.length &&
        chunks.every((chunk) => manifest.chunks.some((item) => item.sequence === chunk.sequence)),
      manifestTotalBytesExact: manifest.totalBytes === expectedBytes,
      detailTotalChunksExact: detail.meeting?.totalChunks === chunks.length,
      detailTotalBytesExact: detail.meeting?.totalBytes === expectedBytes,
      canonicalMeetingIdRejectsLossyAlias: invalidAliasUpload.status === 400 && invalidAliasDelete.status === 400,
      canonicalMeetingOwnerCannotBeCrossed: crossOwnerUpload.status === 403,
      advisoryLockSerializedInitialManifestReads: maxConcurrentInitialManifestReads === 1,
      diagnosticsExposeCrossInstanceLock: diagnostics.diagnostics?.capabilities?.supportsCrossInstanceWrites === true,
      diagnosticsExposeDeletionFence: diagnostics.diagnostics?.capabilities?.preventsDeletedMeetingRecreation === true,
      deleteSucceeded: deletion.status === 200 && deletionPayload.ok === true,
      deletionFencePersisted:
        deletionProof.rawTombstoneCount === 0 && deletionProof.fingerprintFenceCount === 1,
      staleUploadRejectedWith410: staleUpload.status === 410,
      ordinaryLateMutationRejectedWith410: staleMetadataWrite.status === 410,
      recordingUploadStatusRejectedWith410: staleRecordingUploadStatus.status === 410,
      deletedObjectsNotRecreated: remainingObjects.length === 0,
      realtimeOwnershipPreflightLinearizedWithDelete:
        deletionStayedQueued && realtimeDeleteResponse.status === 200 && realtimeDeletePayload.ok === true,
      realtimePublishLosesToQueuedDelete: realtimeWriteResult.status === 410,
      lateRealtimeWriteRejectedWithoutResurrection:
        lateRealtimeWrite.status === 410 && realtimeRaceObjects.length === 0,
      blockedRealtimeProvidersRemainLockFree:
        blockedProvidersStillPending.every(Boolean) &&
        blockedMeetingDeletion.elapsedMs < 5_000 &&
        blockedAccountDeletion.elapsedMs < 5_000 &&
        blockedFinishDeletion.elapsedMs < 5_000,
      meetingDeleteCompletesDuringBlockedRealtimeProvider:
        blockedMeetingDeletion.response.status === 200 &&
        blockedMeetingDeletionPayload.ok === true &&
        blockedFinishDeletion.response.status === 200 &&
        blockedFinishDeletionPayload.ok === true,
      accountDeleteCompletesDuringBlockedRealtimeProvider:
        (blockedAccountDeletion.response.status === 200 || blockedAccountDeletion.response.status === 202) &&
        blockedAccountDeletionPayload.ok === true &&
        blockedAccountDeletionStatus === "deleted",
      blockedRealtimeLateResultsRejected:
        blockedMeetingLateResult.status === 410 &&
        (blockedAccountLateResult.status === 401 || blockedAccountLateResult.status === 410) &&
        blockedFinishLateResult.status === 410,
      blockedRealtimeCannotResurrectObjects: blockedRealtimeObjects.length === 0,
      blockedRealtimeProviderLedgerReconciled:
        Number(blockedMeetingProviderLedger.rows[0]?.active_rows || 0) === 0 &&
        Number(blockedAccountProviderLedger.rows[0]?.active_rows || 0) === 0 &&
        providerCostAggregateAfter.providerSteps === providerCostAggregateBefore.providerSteps + 2 &&
        providerCostAggregateAfter.officialMinutesSettled >= providerCostAggregateBefore.officialMinutesSettled + 2,
      blockedStorageIoDoesNotHoldDeleteLocks:
        blockedStorageOperationsPending.every(Boolean) &&
        snapshotDelete.elapsedMs < 5_000 &&
        snapshotGetDelete.elapsedMs < 5_000 &&
        recordingPartDelete.elapsedMs < 5_000 &&
        recordingCommitDelete.elapsedMs < 5_000,
      snapshotTransientPutLosesToDelete:
        snapshotDelete.response.status === 200 &&
        snapshotDeletePayload.ok === true &&
        snapshotPrepareResult.ok === false &&
        Number(snapshotPrepareResult.error?.status) === 410,
      snapshotChunkGetLosesToDelete:
        snapshotGetDelete.response.status === 200 &&
        snapshotGetDeletePayload.ok === true &&
        snapshotGetPrepareResult.ok === false &&
        (Number(snapshotGetPrepareResult.error?.status) === 404 || Number(snapshotGetPrepareResult.error?.status) === 410),
      recordingPartStagingPutLosesToDelete:
        recordingPartDelete.response.status === 200 &&
        recordingPartDeletePayload.ok === true &&
        (recordingPartResult.status === 401 || recordingPartResult.status === 410),
      recordingCommitCanonicalPutLosesToDelete:
        recordingCommitDelete.response.status === 200 &&
        recordingCommitDeletePayload.ok === true &&
        recordingCommitResult.status === 410,
      blockedStorageLateWritesLeaveNoObjects: blockedStorageObjects.length === 0,
      snapshotCleanupWaitsForTransientPut:
        cleanupStayedQueuedBehindPut &&
        cleanupPrepareResult.completed === false &&
        cleanupTransientObjects.length === 0,
      meetingReadIsLinearizedWithDelete:
        deleteStayedQueuedBehindRead &&
        inFlightDetailResponse.status === 200 &&
        deleteAfterReadResponse.status === 200 &&
        detailAfterDelete.status === 404,
      deleteDoesNotWaitForExternalProvider:
        providerStillBlockedBeforeDelete &&
        providerDeleteResponse.status === 200 &&
        providerDeletePayload.ok === true &&
        providerDeleteElapsedMs < 5_000,
      lateProviderResultCannotResurrectDeletedMeeting:
        providerFinalizationOutcome.ok === false &&
        Number(providerFinalizationOutcome.error?.status) === 410 &&
        providerRequestCount === 1 &&
        providerRaceObjects.length === 0 &&
        providerUsageAfterDelete.rowCount === 0,
      providerCostFenceReconciledAfterDelete:
        providerStepsAfterDelete.rowCount === 0 &&
        providerCostAggregateAfterProviderDelete.providerSteps === providerCostAggregateAfter.providerSteps + 1 &&
        providerCostAggregateAfterProviderDelete.officialMinutesSettled >=
          providerCostAggregateAfter.officialMinutesSettled + 1,
      logicalDeleteReportsDeferredCleanup:
        cleanupFailureDelete.status === 200 && cleanupFailurePayload.ok === true && cleanupFailurePayload.cleanupPending === true,
      logicalDeleteImmediatelyHidesMeeting:
        hiddenAfterLogicalDelete.status === 404 &&
        !historyAfterLogicalDelete.meetings?.some((meeting) => meeting.meetingId === cleanupFailureMeetingId),
      deferredCleanupRetriesWithoutSecondDelete:
        cleanupFailureRemainingObjects.length === 0 &&
        cleanupDeletionProof.rawTombstoneCount === 0 &&
        cleanupDeletionProof.fingerprintFenceCount === 1,
      accountDeleteAcceptedAfterInFlightUpload:
        accountUploadResult.status === 200 &&
        (accountDelete.status === 200 || accountDelete.status === 202) &&
        accountDeletePayload.ok === true,
      accountDeleteCompletesAsynchronously:
        accountDeletionStatus === "deleted" &&
        accountObjects.length === 0 &&
        accountUserAfterDelete.rowCount === 1 &&
        Boolean(accountUserAfterDelete.rows[0]?.deleted_at) &&
        String(accountUserAfterDelete.rows[0]?.email || "").startsWith("deleted-"),
      preauthenticatedQueuedUploadRejected: queuedUploadResult.status === 410 || queuedUploadResult.status === 401,
      accountDeleteInvalidatedFurtherUploads: afterAccountDeleteUpload.status === 401,
      noSecretsLeaked: true,
    };
    runtimeResult = {
      ...runtimeResult,
      metrics: {
        blockedProviderDeleteElapsedMs: {
          account: blockedAccountDeletion.elapsedMs,
          finish: blockedFinishDeletion.elapsedMs,
          meeting: blockedMeetingDeletion.elapsedMs,
        },
        blockedProviderDeleteStatus: {
          account: blockedAccountDeletion.response.status,
          finish: blockedFinishDeletion.response.status,
          meeting: blockedMeetingDeletion.response.status,
        },
        blockedStorageDeleteElapsedMs: {
          recordingCommit: recordingCommitDelete.elapsedMs,
          recordingPart: recordingPartDelete.elapsedMs,
          snapshotGet: snapshotGetDelete.elapsedMs,
          snapshotPut: snapshotDelete.elapsedMs,
        },
        blockedStorageDeleteStatus: {
          recordingCommit: recordingCommitDelete.response.status,
          recordingPart: recordingPartDelete.response.status,
          snapshotGet: snapshotGetDelete.response.status,
          snapshotPut: snapshotDelete.response.status,
        },
        providerCostAggregateDelta: {
          officialMinutesSettled:
            providerCostAggregateAfter.officialMinutesSettled - providerCostAggregateBefore.officialMinutesSettled,
          providerSteps: providerCostAggregateAfter.providerSteps - providerCostAggregateBefore.providerSteps,
        },
        realtimeOwnershipRace: {
          deleteQueuedDuringPreflight: deletionStayedQueued,
          deleteStatus: realtimeDeleteResponse.status,
          firstWriteStatus: realtimeWriteResult.status,
          lateWriteStatus: lateRealtimeWrite.status,
        },
      },
      stage: "summary",
      summary,
    };

    console.log(JSON.stringify(summary, null, 2));
    const failedAssertions = Object.entries(summary)
      .filter(([, value]) => value !== true)
      .map(([name]) => name);
    if (failedAssertions.length > 0) {
      console.error(`FAILED_RUNTIME_ASSERTIONS=${failedAssertions.join(",")}`);
      process.exitCode = 1;
    }
  } finally {
    releaseProviderRequest?.();
    appA.kill("SIGTERM");
    appB.kill("SIGTERM");
    s3.close();
    provider.close();
    await pool.end();
    fs.rmSync(runtimeAuthDataDir, { force: true, recursive: true });
  }
}

function createFakeProviderServer() {
  return http.createServer(async (request, response) => {
    if (request.method === "POST" && request.url === "/realtime") {
      const payload = JSON.parse((await readBody(request)).toString("utf8") || "{}");
      const key = `${payload.operation}:${payload.meetingId}`;
      if (blockedRealtimeProviderKeys.has(key)) {
        realtimeProviderStarts.get(key)?.resolve();
        await delay(20_000);
      }
      response.writeHead(200, { "content-type": "application/json" });
      return response.end(JSON.stringify({
        diagnostic: `Runtime smoke ${payload.operation || "realtime"} provider completed.`,
        providerStatus: payload.operation === "finish" ? "completed" : "accepted",
        sessionId: `rt-smoke-${payload.meetingId}`,
      }));
    }
    if (request.method !== "POST" || request.url !== "/recognize") {
      response.writeHead(404);
      return response.end();
    }
    providerRequestCount += 1;
    await readBody(request);
    providerRequestStarted();
    await providerRelease;
    response.writeHead(200, {
      "content-type": "application/json",
      "x-api-status-code": "20000000",
      "x-api-request-id": `provider-delete-${timestamp}`,
    });
    return response.end(JSON.stringify({ result: { text: "The provider completed after the meeting deletion barrier test." } }));
  });
}

function createFakeS3Server() {
  return http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url || "/", "http://127.0.0.1");
      const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
      const requestBucket = parts.shift();
      const key = parts.join("/");
      const body = await readBody(request);
      if (requestBucket !== bucket) return sendXml(response, 404, "<Error><Code>NoSuchBucket</Code></Error>");

      if (request.method === "PUT") {
        const prefixGateEntry = [...blockedPutPrefixes.entries()].find(([prefix]) => key.startsWith(prefix));
        const gate = blockedPuts.get(key) ?? prefixGateEntry?.[1];
        if (gate) {
          gate.markStarted();
          await gate.waitForRelease;
          blockedPuts.delete(key);
          if (prefixGateEntry) blockedPutPrefixes.delete(prefixGateEntry[0]);
        }
        objects.set(key, body);
        response.writeHead(200);
        return response.end();
      }
      if (request.method === "GET" && url.searchParams.get("list-type") === "2") {
        return sendXml(response, 200, listObjectsXml(url.searchParams));
      }
      if (request.method === "GET" && url.searchParams.has("versions")) {
        return sendXml(response, 200, "<ListVersionsResult><IsTruncated>false</IsTruncated></ListVersionsResult>");
      }
      if (request.method === "GET") {
        const isManifest = key.endsWith("/manifest.json");
        if (isManifest) {
          activeManifestReads += 1;
          maxConcurrentManifestReads = Math.max(maxConcurrentManifestReads, activeManifestReads);
          await delay(60);
        }
        const gate = blockedGets.get(key);
        if (gate) {
          gate.markStarted();
          await gate.waitForRelease;
          blockedGets.delete(key);
        }
        try {
          if (!objects.has(key)) return sendXml(response, 404, "<Error><Code>NoSuchKey</Code></Error>");
          response.writeHead(200, { "content-type": "application/octet-stream" });
          return response.end(objects.get(key));
        } finally {
          if (isManifest) activeManifestReads -= 1;
        }
      }
      if (request.method === "DELETE") {
        const failuresRemaining = deleteFailuresRemaining.get(key) ?? 0;
        if (failuresRemaining > 0) {
          deleteFailuresRemaining.set(key, failuresRemaining - 1);
          return sendXml(response, 503, "<Error><Code>SlowDown</Code></Error>");
        }
        objects.delete(key);
        response.writeHead(204);
        return response.end();
      }
      return sendXml(response, 405, "<Error><Code>MethodNotAllowed</Code></Error>");
    } catch (error) {
      return sendXml(response, 500, `<Error><Code>InternalError</Code><Message>${escapeXml(error instanceof Error ? error.message : String(error))}</Message></Error>`);
    }
  });
}

function startNext(port, s3Port, providerPort, instanceId) {
  const child = spawn("./node_modules/.bin/next", ["start", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: serverWorkdir,
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      OWNMINUTES_AUTH_REPOSITORY: "postgres",
      OWNMINUTES_MEETING_WRITE_LOCK: "postgres-advisory",
      OWNMINUTES_MEETING_WRITE_LOCK_TIMEOUT_MS: "30000",
      OWNMINUTES_FINALIZATION_MODE: "inline",
      OWNMINUTES_FINALIZATION_WORKER: "0",
      OWNMINUTES_MEETING_DELETION_CLEANUP_WORKER: "1",
      OWNMINUTES_MEETING_DELETION_CLEANUP_POLL_MS: "250",
      OWNMINUTES_AUTH_DATA_DIR: runtimeAuthDataDir,
      OWNMINUTES_APP_SECRET: "runtime-only-account-deletion-ticket-signing-secret-v1",
      OWNMINUTES_OBJECT_STORE_HEADER_TIMEOUT_MS: "30000",
      OWNMINUTES_OBJECT_STORE_SMALL_TRANSFER_TIMEOUT_MS: "30000",
      TRANSCRIPTION_PROVIDER: "volcano",
      VOLCANO_ASR_API_KEY: "runtime-realtime-provider-fence-key",
      OWNMINUTES_RUNTIME_SMOKE: "1",
      OWNMINUTES_RUNTIME_SMOKE_REALTIME_PROVIDER_URL: `http://127.0.0.1:${providerPort}/realtime`,
      S3_BUCKET: bucket,
      S3_ENDPOINT: `http://127.0.0.1:${s3Port}`,
      S3_ACCESS_KEY_ID: accessKeyId,
      S3_SECRET_ACCESS_KEY: secretAccessKey,
      S3_REGION: "us-east-1",
      OWNMINUTES_STORAGE_LIFECYCLE_POLICY: "runtime smoke",
      OWNMINUTES_STORAGE_DELETE_PROOF: "runtime smoke",
      OWNMINUTES_STORAGE_COST_BUDGET: "runtime smoke",
      OWNMINUTES_STORAGE_LOCAL_INVENTORY_DECISION: "runtime smoke",
      OWNMINUTES_STORAGE_PRIVATE_ACCESS: "1",
      OWNMINUTES_STORAGE_MINIMUM_PRIVILEGE: "runtime smoke",
      OWNMINUTES_STORAGE_RESTORE_READ_PROOF: "runtime smoke",
      OWNMINUTES_INSTANCE_ID: instanceId,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (data) => {
    if (process.env.SMOKE_VERBOSE) process.stdout.write(`[${instanceId}] ${data}`);
  });
  child.stderr.on("data", (data) => {
    if (process.env.SMOKE_VERBOSE) process.stderr.write(`[${instanceId}] ${data}`);
  });
  return child;
}

async function uploadChunk(
  baseUrl,
  cookie,
  targetMeetingId,
  sequence,
  content,
  throwOnError = true,
  mimeType = "audio/webm;codecs=opus",
) {
  const form = new FormData();
  form.append("sequence", String(sequence));
  form.append("mimeType", mimeType);
  form.append("recordedAt", String(Date.now()));
  form.append("durationMs", "1000");
  const extension = mimeType.includes("wav") ? "wav" : "webm";
  form.append("chunk", new Blob([content], { type: mimeType }), `chunk-${sequence}.${extension}`);
  const response = await fetch(`${baseUrl}/api/meetings/${targetMeetingId}/chunks`, { method: "POST", headers: { Cookie: cookie }, body: form });
  const payload = await readJson(response);
  if (throwOnError && !response.ok) throw new Error(`Chunk ${sequence} failed with ${response.status}: ${JSON.stringify(payload)}`);
  return { status: response.status, payload };
}

function buildSilentWavBuffer(durationMs = 1_000, sampleRate = 16_000) {
  const channels = 1;
  const bitsPerSample = 16;
  const sampleCount = Math.round(sampleRate * durationMs / 1_000);
  const dataBytes = sampleCount * channels * bitsPerSample / 8;
  const wav = Buffer.alloc(44 + dataBytes);
  wav.write("RIFF", 0, "ascii");
  wav.writeUInt32LE(36 + dataBytes, 4);
  wav.write("WAVE", 8, "ascii");
  wav.write("fmt ", 12, "ascii");
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(channels, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * channels * bitsPerSample / 8, 28);
  wav.writeUInt16LE(channels * bitsPerSample / 8, 32);
  wav.writeUInt16LE(bitsPerSample, 34);
  wav.write("data", 36, "ascii");
  wav.writeUInt32LE(dataBytes, 40);
  return wav;
}

function loadRuntimeMeetingStore(s3Port) {
  Object.assign(process.env, {
    DATABASE_URL: databaseUrl,
    OWNMINUTES_AUTH_REPOSITORY: "postgres",
    OWNMINUTES_MEETING_WRITE_LOCK: "postgres-advisory",
    OWNMINUTES_MEETING_WRITE_LOCK_TIMEOUT_MS: "30000",
    OWNMINUTES_OBJECT_STORE_HEADER_TIMEOUT_MS: "30000",
    OWNMINUTES_OBJECT_STORE_SMALL_TRANSFER_TIMEOUT_MS: "30000",
    S3_BUCKET: bucket,
    S3_ENDPOINT: `http://127.0.0.1:${s3Port}`,
    S3_ACCESS_KEY_ID: accessKeyId,
    S3_SECRET_ACCESS_KEY: secretAccessKey,
    S3_REGION: "us-east-1",
  });
  const jiti = require("jiti")(
    path.join(serverWorkdir, "scripts", "meeting-write-coordination-runtime-loader.cjs"),
    {
      interopDefault: true,
      alias: { "@": path.join(serverWorkdir, "src") },
    },
  );
  return jiti("../src/lib/server/meeting-audio-store.ts");
}

function loadRuntimeRealtimeStore(s3Port) {
  Object.assign(process.env, {
    DATABASE_URL: databaseUrl,
    OWNMINUTES_AUTH_REPOSITORY: "postgres",
    OWNMINUTES_MEETING_WRITE_LOCK: "postgres-advisory",
    OWNMINUTES_MEETING_WRITE_LOCK_TIMEOUT_MS: "30000",
    S3_BUCKET: bucket,
    S3_ENDPOINT: `http://127.0.0.1:${s3Port}`,
    S3_ACCESS_KEY_ID: accessKeyId,
    S3_SECRET_ACCESS_KEY: secretAccessKey,
    S3_REGION: "us-east-1",
  });
  const jiti = require("jiti")(
    path.join(serverWorkdir, "scripts", "meeting-write-coordination-runtime-realtime-loader.cjs"),
    {
      interopDefault: true,
      alias: { "@": path.join(serverWorkdir, "src") },
    },
  );
  return jiti("../src/lib/server/realtime-session-store.ts");
}

function loadRuntimeMeetingFinalizer(s3Port, providerPort) {
  Object.assign(process.env, {
    DATABASE_URL: databaseUrl,
    OWNMINUTES_AUTH_REPOSITORY: "postgres",
    OWNMINUTES_MEETING_WRITE_LOCK: "postgres-advisory",
    OWNMINUTES_MEETING_WRITE_LOCK_TIMEOUT_MS: "30000",
    OWNMINUTES_ALLOW_LOCAL_PROVIDER_ENDPOINTS: "1",
    OWNMINUTES_ASR_TURBO_FALLBACK_ENABLED: "1",
    OWNMINUTES_ASR_TURBO_FALLBACK_MAX_AUDIO_MINUTES: "30",
    TRANSCRIPTION_PROVIDER: "volcano",
    VOLCANO_ASR_API_KEY: "runtime-provider-fence-key",
    VOLCANO_ASR_FLASH_ATTEMPTS: "1",
    VOLCANO_ASR_MODE: "flash",
    VOLCANO_ASR_RECOGNIZE_URL: `http://127.0.0.1:${providerPort}/recognize`,
    S3_BUCKET: bucket,
    S3_ENDPOINT: `http://127.0.0.1:${s3Port}`,
    S3_ACCESS_KEY_ID: accessKeyId,
    S3_SECRET_ACCESS_KEY: secretAccessKey,
    S3_REGION: "us-east-1",
  });
  const jiti = require("jiti")(
    path.join(serverWorkdir, "scripts", "meeting-write-coordination-runtime-finalizer-loader.cjs"),
    {
      interopDefault: true,
      alias: { "@": path.join(serverWorkdir, "src") },
    },
  );
  return jiti("../src/lib/server/meeting-finalizer.ts");
}

async function uploadRealtimeChunk(baseUrl, cookie, targetMeetingId, sequence, throwOnError = true) {
  const durationMs = 100;
  const sampleRate = 16_000;
  const content = Buffer.alloc(Math.round(sampleRate * 2 * durationMs / 1000));
  const response = await fetch(`${baseUrl}/api/meetings/${targetMeetingId}/realtime-chunks`, {
    method: "POST",
    headers: {
      Cookie: cookie,
      "content-type": "audio/pcm",
      "x-ownminutes-channels": "1",
      "x-ownminutes-duration-ms": String(durationMs),
      "x-ownminutes-mime-type": "audio/pcm",
      "x-ownminutes-recorded-at": String(Date.now()),
      "x-ownminutes-sample-rate": String(sampleRate),
      "x-ownminutes-sequence": String(sequence),
    },
    body: content,
  });
  const payload = await readJson(response);
  if (throwOnError && !response.ok) throw new Error(`Realtime chunk ${sequence} failed with ${response.status}: ${JSON.stringify(payload)}`);
  return { status: response.status, payload };
}

async function uploadRecordingPart({ baseUrl, buffer, cookie, meetingId, uploadId }) {
  const response = await fetch(
    `${baseUrl}/api/meetings/${meetingId}/recording-upload?uploadId=${encodeURIComponent(uploadId)}&part=0`,
    {
      method: "PUT",
      headers: {
        Cookie: cookie,
        "content-length": String(buffer.byteLength),
        "content-type": "application/octet-stream",
        "x-ownminutes-duration-ms": "1000",
        "x-ownminutes-mime-type": "audio/wav",
        "x-ownminutes-part-sha256": crypto.createHash("sha256").update(buffer).digest("hex"),
        "x-ownminutes-recorded-at": String(Date.now()),
        "x-ownminutes-total-bytes": String(buffer.byteLength),
        "x-ownminutes-total-parts": "1",
      },
      body: buffer,
    },
  );
  return { status: response.status, payload: await readJson(response) };
}

async function commitRecordingUpload({ baseUrl, cookie, meetingId, uploadId }) {
  const response = await fetch(
    `${baseUrl}/api/meetings/${meetingId}/recording-upload?uploadId=${encodeURIComponent(uploadId)}`,
    { method: "POST", headers: { Cookie: cookie } },
  );
  return { status: response.status, payload: await readJson(response) };
}

function blockNextPut(key) {
  let markStarted;
  let release;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const waitForRelease = new Promise((resolve) => { release = resolve; });
  blockedPuts.set(key, { markStarted, waitForRelease });
  return { started, release };
}

function blockNextPutPrefix(prefix) {
  let markStarted;
  let release;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const waitForRelease = new Promise((resolve) => { release = resolve; });
  blockedPutPrefixes.set(prefix, { markStarted, waitForRelease });
  return { started, release };
}

function blockNextGet(key) {
  let markStarted;
  let release;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const waitForRelease = new Promise((resolve) => { release = resolve; });
  blockedGets.set(key, { markStarted, waitForRelease });
  return { started, release };
}

function scheduleGateRelease(gate, delayMs) {
  void gate.started.then(() => {
    const timer = setTimeout(gate.release, delayMs);
    timer.unref?.();
  });
  return gate;
}

async function postJson(url, body) {
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { response, payload: await readJson(response) };
}

async function getJson(url, cookie) {
  const response = await fetch(url, { headers: cookie ? { Cookie: cookie } : {} });
  const payload = await readJson(response);
  if (!response.ok) throw new Error(`GET ${url} failed with ${response.status}: ${JSON.stringify(payload)}`);
  return payload;
}

async function timedFetch(url, init) {
  const startedAt = Date.now();
  const response = await fetch(url, init);
  return { response, elapsedMs: Date.now() - startedAt };
}

async function promiseStillPending(promise) {
  return await Promise.race([
    promise.then(() => false, () => false),
    delay(100).then(() => true),
  ]);
}

async function waitForRealtimeProviderStart(key) {
  const deferred = realtimeProviderStarts.get(key);
  if (!deferred) throw new Error(`Missing blocked realtime provider gate ${key}.`);
  await Promise.race([
    deferred.promise,
    delay(10_000).then(() => {
      throw new Error(`Timed out waiting for blocked realtime provider ${key}.`);
    }),
  ]);
}

async function waitForApp(baseUrl, child) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 30_000) {
    if (child.exitCode !== null) throw new Error(`Next instance exited with ${child.exitCode}.`);
    try {
      const response = await fetch(`${baseUrl}/api/health`);
      if (response.ok) return;
    } catch {}
    await delay(250);
  }
  throw new Error(`Timed out waiting for ${baseUrl}.`);
}

function listObjectsXml(searchParams) {
  const prefix = searchParams.get("prefix") || "";
  const delimiter = searchParams.get("delimiter") || "";
  const keys = [...objects.keys()].filter((key) => key.startsWith(prefix)).sort();
  if (delimiter === "/") {
    const prefixes = new Set();
    const contents = [];
    for (const key of keys) {
      const rest = key.slice(prefix.length);
      const index = rest.indexOf(delimiter);
      if (index >= 0) prefixes.add(`${prefix}${rest.slice(0, index + 1)}`);
      else contents.push(key);
    }
    return `<ListBucketResult>${contents.map(objectXml).join("")}${[...prefixes].map((value) => `<CommonPrefixes><Prefix>${escapeXml(value)}</Prefix></CommonPrefixes>`).join("")}</ListBucketResult>`;
  }
  return `<ListBucketResult>${keys.map(objectXml).join("")}</ListBucketResult>`;
}

function objectXml(key) {
  return `<Contents><Key>${escapeXml(key)}</Key><Size>${objects.get(key)?.byteLength || 0}</Size></Contents>`;
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function readJson(response) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { raw: text.slice(0, 500) };
  }
}

function sendXml(response, status, body) {
  response.writeHead(status, { "content-type": "application/xml" });
  response.end(body);
}

function escapeXml(value) {
  return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function listen(server, port) {
  return new Promise((resolve, reject) => server.once("error", reject).listen(port, "127.0.0.1", resolve));
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createDeferred() {
  let resolve;
  const promise = new Promise((next) => { resolve = next; });
  return { promise, resolve };
}

async function waitForObject(key) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 10_000) {
    if (objects.has(key)) return;
    await delay(10);
  }
  throw new Error(`Timed out waiting for object ${key}.`);
}

async function waitForDeletionCleanup(pool, meetingId) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 30_000) {
    const proof = await readMeetingDeletionProof(pool, meetingId);
    const remaining = [...objects.keys()].some((key) => key.startsWith(`${meetingId}/`));
    if (
      proof.rawTombstoneCount === 0 &&
      proof.fingerprintFenceCount === 1 &&
      !remaining
    ) return;
    await delay(100);
  }
  throw new Error(`Timed out waiting for automatic deletion cleanup for ${meetingId}.`);
}

async function readMeetingDeletionProof(pool, meetingId) {
  const meetingRef = crypto
    .createHash("sha256")
    .update(`ownminutes-meeting-deletion-fence:v1:${meetingId}`)
    .digest("hex");
  const [rawTombstone, fingerprintFence] = await Promise.all([
    pool.query("select meeting_id from meeting_deletion_tombstones where meeting_id = $1", [meetingId]),
    pool.query("select meeting_ref from meeting_deletion_fences where meeting_ref = $1", [meetingRef]),
  ]);
  return {
    fingerprintFenceCount: fingerprintFence.rowCount ?? 0,
    rawTombstoneCount: rawTombstone.rowCount ?? 0,
  };
}

async function waitForAccountDeletionStatus(baseUrl, ticket) {
  if (typeof ticket !== "string" || !ticket) throw new Error("Missing account deletion status ticket.");
  const startedAt = Date.now();
  let lastStatus = "unknown";
  while (Date.now() - startedAt < 30_000) {
    const result = await postJson(`${baseUrl}/api/auth/delete`, { ticket });
    if (!result.response.ok) {
      throw new Error(`Account deletion status failed with ${result.response.status}: ${JSON.stringify(result.payload)}`);
    }
    lastStatus = String(result.payload.status || "unknown");
    if (lastStatus === "deleted") return lastStatus;
    await delay(100);
  }
  throw new Error(`Timed out waiting for asynchronous account deletion; last status was ${lastStatus}.`);
}

async function waitForProcessingLedgerCleanup(pool, userId) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 15_000) {
    const ledger = await pool.query(
      `select count(*)::int as active_rows
       from meeting_processing_reservations reservation
       left join meeting_processing_provider_steps step on step.reservation_id = reservation.id
       where reservation.user_id = $1`,
      [userId],
    );
    if (Number(ledger.rows[0]?.active_rows || 0) === 0) return;
    await delay(100);
  }
  throw new Error(`Timed out waiting for processing ledger cleanup for ${userId}.`);
}

async function readProviderCostAggregateTotals(pool) {
  const result = await pool.query(
    `select coalesce(sum(provider_steps), 0)::bigint as provider_steps,
            coalesce(sum(official_minutes_settled), 0)::bigint as official_minutes_settled
     from account_deletion_provider_cost_aggregates`,
  );
  return {
    providerSteps: Number(result.rows[0]?.provider_steps || 0),
    officialMinutesSettled: Number(result.rows[0]?.official_minutes_settled || 0),
  };
}

async function waitForProviderCostAggregateDelta(pool, baseline, expectedDelta, timeoutMs = 15_000) {
  const startedAt = Date.now();
  let latest = baseline;
  while (Date.now() - startedAt < timeoutMs) {
    latest = await readProviderCostAggregateTotals(pool);
    if (
      latest.providerSteps >= baseline.providerSteps + expectedDelta.providerSteps &&
      latest.officialMinutesSettled >= baseline.officialMinutesSettled + expectedDelta.officialMinutesSettled
    ) {
      return latest;
    }
    await delay(100);
  }
  throw new Error(
    `Timed out waiting for provider cost archival: baseline=${JSON.stringify(baseline)} latest=${JSON.stringify(latest)}`,
  );
}
