#!/usr/bin/env node

import assert from "node:assert/strict";
import http from "node:http";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { Pool } = require("pg");
const databaseUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL || "";
if (!databaseUrl) throw new Error("DATABASE_URL or POSTGRES_URL is required.");

const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const userId = `legacy-audit-user-${suffix}`;
const legacyMeetingId = `legacy.meeting-${suffix}`;
const latePutMeetingId = `late-put-${suffix}`;
const guessedPrefix = legacyMeetingId.replace(/[^A-Za-z0-9_-]/g, "-");
const manifest = JSON.stringify({
  meetingId: legacyMeetingId,
  ownerUserId: userId,
  chunks: [{ sequence: 1, fileName: "part-1.m4a" }],
});
const objects = new Map([
  [`${legacyMeetingId}/manifest.json`, Buffer.from(manifest)],
  [`${legacyMeetingId}/chunks/part-1.m4a`, Buffer.from("owner-proven-audio")],
  [`${guessedPrefix}/sentinel.bin`, Buffer.from("MUST_NOT_BE_DELETED")],
]);
const deletedKeys = [];
const objectServer = http.createServer((request, response) => handleObjectRequest(request, response));
await new Promise((resolve, reject) => {
  objectServer.once("error", reject);
  objectServer.listen(0, "127.0.0.1", resolve);
});
const objectPort = objectServer.address().port;

Object.assign(process.env, {
  OWNMINUTES_AUTH_REPOSITORY: "postgres",
  OWNMINUTES_MEETING_WRITE_LOCK: "postgres-advisory",
  S3_BUCKET: "legacy-deletion-audit-smoke",
  S3_ENDPOINT: `http://127.0.0.1:${objectPort}`,
  S3_ACCESS_KEY_ID: "legacy-audit-access",
  S3_SECRET_ACCESS_KEY: "legacy-audit-secret",
  S3_REGION: "us-east-1",
});

const jiti = require("jiti")(path.join(process.cwd(), "scripts", "legacy-deletion-cleanup-loader.cjs"), {
  interopDefault: true,
  alias: { "@": path.join(process.cwd(), "src") },
});
const cleanup = jiti("../src/lib/server/legacy-deletion-cleanup.ts");
const accountDeletion = jiti("../src/lib/server/account-deletion-state.ts");
const writeLock = jiti("../src/lib/server/meeting-write-lock.ts");
const pool = new Pool({ connectionString: databaseUrl, max: 2 });

try {
  await pool.query(
    `insert into users (
       id, email, name, role, plan, official_minutes_total,
       official_minutes_used, password_salt, password_hash, created_at, deleted_at
     ) values ($1, $2, 'Legacy Audit Smoke', 'user', 'free', 0, 0, 'salt', 'hash', now(), now())`,
    [userId, `legacy-audit-${suffix}@ownminutes.local`],
  );
  await pool.query(
    `insert into meeting_deletion_tombstones (
       meeting_id, owner_user_id, deleted_at, cleanup_pending,
       cleanup_attempts, cleanup_next_attempt_at
     ) values ($1, $2, now(), true, 0, now())`,
    [legacyMeetingId, userId],
  );

  const pendingStatus = await accountDeletion.resolveAccountDeletionStatus(userId);
  const diagnostics = await cleanup.getLegacyDeletionCleanupDiagnostics(10);
  const diagnosticsText = JSON.stringify(diagnostics);
  assert.equal(pendingStatus, "pending_cleanup");
  assert.equal(diagnostics.unresolvedOwnedCount, 1);
  assert.equal(diagnostics.releaseBlocked, true);
  assert.equal(diagnostics.inventory.length, 1);
  assert.ok(!diagnosticsText.includes(legacyMeetingId));
  assert.ok(!diagnosticsText.includes(userId));

  const blockedGate = runGate();
  assert.notEqual(blockedGate.status, 0);
  assert.ok(blockedGate.stdout.includes('"releaseBlocked": true'));
  assert.ok(!`${blockedGate.stdout}${blockedGate.stderr}`.includes(legacyMeetingId));
  assert.ok(!`${blockedGate.stdout}${blockedGate.stderr}`.includes(userId));

  const resolution = await cleanup.resolveLegacyMeetingDeletionCleanup({
    approvedBy: "legacy-cleanup-smoke-operator",
    meetingId: legacyMeetingId,
    ownerUserId: userId,
  });
  assert.equal(resolution.cleaned, true);
  assert.ok(!JSON.stringify(resolution).includes(legacyMeetingId));
  assert.ok(!JSON.stringify(resolution).includes(userId));

  await pool.query(
    `insert into meeting_deletion_tombstones (
       meeting_id, owner_user_id, deleted_at, cleanup_pending,
       cleanup_attempts, cleanup_next_attempt_at, cleanup_disposition
     ) values ($1, $2, now(), true, 0, now(), 'automatic')`,
    [latePutMeetingId, userId],
  );
  await writeLock.purgeMeetingCatalogAfterObjectDeletion(latePutMeetingId, userId);
  await writeLock.completeMeetingDeletionCleanup(latePutMeetingId, userId);
  const afterInitialCleanup = await pool.query(
    "select 1 from meeting_deletion_tombstones where meeting_id = $1",
    [latePutMeetingId],
  );
  const reopened = await writeLock.reopenMeetingDeletionCleanup(
    latePutMeetingId,
    userId,
    "late object cleanup failed after the deletion fence was recorded",
  );
  const afterReopen = await pool.query(
    `select cleanup_pending, cleanup_disposition, cleanup_last_error
     from meeting_deletion_tombstones where meeting_id = $1`,
    [latePutMeetingId],
  );
  await writeLock.purgeMeetingCatalogAfterObjectDeletion(latePutMeetingId, userId);
  await writeLock.completeMeetingDeletionCleanup(latePutMeetingId, userId);
  const afterSecondCleanup = await pool.query(
    "select 1 from meeting_deletion_tombstones where meeting_id = $1",
    [latePutMeetingId],
  );

  const [rawTombstone, fence] = await Promise.all([
    pool.query("select 1 from meeting_deletion_tombstones where meeting_id = $1", [legacyMeetingId]),
    pool.query(
      `select cleanup_resolution, approved_by_ref, proof_ref
       from meeting_deletion_fences where meeting_ref = $1`,
      [writeLock.meetingDeletionFenceRef(legacyMeetingId)],
    ),
  ]);
  const finalStatus = await accountDeletion.resolveAccountDeletionStatus(userId);
  const passingGate = runGate();
  const summary = {
    accountDeletionReceiptLifecycle: pendingStatus === "pending_cleanup" && finalStatus === "deleted",
    adminInventoryIsPseudonymousAndBounded:
      diagnostics.inventoryLimit <= 100 &&
      diagnostics.inventory.length === 1 &&
      !diagnosticsText.includes(legacyMeetingId) &&
      !diagnosticsText.includes(userId),
    exactOwnerManifestRuleDeletesOnlyApprovedPrefix:
      ![...objects.keys()].some((key) => key.startsWith(`${legacyMeetingId}/`)) &&
      objects.has(`${guessedPrefix}/sentinel.bin`) &&
      deletedKeys.every((key) => key.startsWith(`${legacyMeetingId}/`)),
    manualResolutionAuditRetainedWithoutRawIdentifiers:
      fence.rows[0]?.cleanup_resolution === "legacy_exact_manifest_owner_verified" &&
      /^operator_[a-f0-9]{20}$/.test(String(fence.rows[0]?.approved_by_ref || "")) &&
      /^[a-f0-9]{64}$/.test(String(fence.rows[0]?.proof_ref || "")),
    productionGateBlocksThenClears:
      blockedGate.status !== 0 && passingGate.status === 0 && passingGate.stdout.includes('"releaseBlocked": false'),
    rawOwnerAndMeetingIdentifiersRemovedAfterCleanup: rawTombstone.rowCount === 0 && fence.rowCount === 1,
    latePutCanReopenDurableCleanup:
      afterInitialCleanup.rowCount === 0 &&
      reopened.reopened === true &&
      afterReopen.rows[0]?.cleanup_pending === true &&
      afterReopen.rows[0]?.cleanup_disposition === "automatic" &&
      String(afterReopen.rows[0]?.cleanup_last_error || "").includes("late object cleanup failed") &&
      afterSecondCleanup.rowCount === 0,
  };
  console.log(JSON.stringify(summary, null, 2));
  if (Object.values(summary).some((value) => value !== true)) process.exitCode = 1;
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await pool.query("delete from meeting_deletion_fences where meeting_ref = $1", [writeLock.meetingDeletionFenceRef(legacyMeetingId)]).catch(() => undefined);
  await pool.query("delete from meeting_deletion_tombstones where meeting_id = $1", [latePutMeetingId]).catch(() => undefined);
  await pool.query("delete from meeting_deletion_fences where meeting_ref = $1", [writeLock.meetingDeletionFenceRef(latePutMeetingId)]).catch(() => undefined);
  await pool.query("delete from users where id = $1", [userId]).catch(() => undefined);
  await pool.end();
  await new Promise((resolve) => objectServer.close(resolve));
}
process.exit(process.exitCode || 0);

function runGate() {
  return spawnSync("node", ["scripts/check-legacy-meeting-deletion-gate.mjs", "--strict"], {
    cwd: process.cwd(),
    env: process.env,
    encoding: "utf8",
  });
}

function handleObjectRequest(request, response) {
  const url = new URL(request.url || "/", "http://127.0.0.1");
  const segments = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  const bucket = segments.shift();
  const key = segments.join("/");
  if (bucket !== "legacy-deletion-audit-smoke") return sendXml(response, 404, "<Error><Code>NoSuchBucket</Code></Error>");
  if (request.method === "GET" && url.searchParams.get("list-type") === "2") {
    return sendXml(response, 200, listObjectsXml(url.searchParams));
  }
  if (request.method === "GET" && url.searchParams.has("versions")) {
    return sendXml(response, 200, "<ListVersionsResult><IsTruncated>false</IsTruncated></ListVersionsResult>");
  }
  if (request.method === "GET") {
    const value = objects.get(key);
    if (!value) return sendXml(response, 404, "<Error><Code>NoSuchKey</Code></Error>");
    response.writeHead(200, { "content-type": key.endsWith(".json") ? "application/json" : "application/octet-stream" });
    return response.end(value);
  }
  if (request.method === "DELETE") {
    deletedKeys.push(key);
    objects.delete(key);
    response.writeHead(204);
    return response.end();
  }
  return sendXml(response, 405, "<Error><Code>MethodNotAllowed</Code></Error>");
}

function listObjectsXml(searchParams) {
  const prefix = searchParams.get("prefix") || "";
  const delimiter = searchParams.get("delimiter") || "";
  const keys = [...objects.keys()].filter((key) => key.startsWith(prefix)).sort();
  if (delimiter === "/") {
    const prefixes = new Set();
    for (const key of keys) {
      const rest = key.slice(prefix.length);
      const index = rest.indexOf("/");
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
