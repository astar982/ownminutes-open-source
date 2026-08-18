#!/usr/bin/env node

import http from "node:http";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { Pool } = require("pg");
const databaseUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL || "";
if (!databaseUrl) {
  console.error("DATABASE_URL or POSTGRES_URL is required.");
  process.exit(1);
}

const timestamp = Date.now();
const userId = `legacy-cleanup-user-${timestamp}`;
const nonCanonicalLegacyId = `legacy.meeting-${timestamp}`;
const sanitizedPrefix = nonCanonicalLegacyId.replace(/[^A-Za-z0-9_-]/g, "-");
const sentinelObjectKey = `${sanitizedPrefix}/sentinel.bin`;
const objects = new Map([[sentinelObjectKey, Buffer.from("MUST_NOT_BE_DELETED_BY_LEGACY_TOMBSTONE")]]);
const deleteRequests = [];
const pool = new Pool({ connectionString: databaseUrl, max: 2 });
const objectStore = http.createServer(async (request, response) => {
  const url = new URL(request.url || "/", "http://127.0.0.1");
  const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  const requestBucket = parts.shift();
  const key = parts.join("/");
  if (requestBucket !== "legacy-cleanup-smoke") return sendXml(response, 404, "<Error><Code>NoSuchBucket</Code></Error>");

  if (request.method === "GET" && url.searchParams.get("list-type") === "2") {
    return sendXml(response, 200, listObjectsXml(url.searchParams));
  }
  if (request.method === "GET" && url.searchParams.has("versions")) {
    return sendXml(response, 200, "<ListVersionsResult><IsTruncated>false</IsTruncated></ListVersionsResult>");
  }
  if (request.method === "GET") {
    const value = objects.get(key);
    if (!value) return sendXml(response, 404, "<Error><Code>NoSuchKey</Code></Error>");
    response.writeHead(200, { "content-type": "application/octet-stream" });
    return response.end(value);
  }
  if (request.method === "DELETE") {
    deleteRequests.push(key);
    objects.delete(key);
    response.writeHead(204);
    return response.end();
  }
  return sendXml(response, 405, "<Error><Code>MethodNotAllowed</Code></Error>");
});

await listen(objectStore);
const port = objectStore.address().port;

Object.assign(process.env, {
  DATABASE_URL: databaseUrl,
  OWNMINUTES_AUTH_REPOSITORY: "postgres",
  OWNMINUTES_MEETING_WRITE_LOCK: "postgres-advisory",
  S3_BUCKET: "legacy-cleanup-smoke",
  S3_ENDPOINT: `http://127.0.0.1:${port}`,
  S3_ACCESS_KEY_ID: "legacy-cleanup-access",
  S3_SECRET_ACCESS_KEY: "legacy-cleanup-secret",
  S3_REGION: "us-east-1",
});

const jiti = require("jiti")(path.join(process.cwd(), "scripts", "legacy-meeting-deletion-loader.cjs"), {
  interopDefault: true,
  alias: { "@": path.join(process.cwd(), "src") },
});
const lock = jiti("../src/lib/server/meeting-write-lock.ts");
const meetingStore = jiti("../src/lib/server/meeting-audio-store.ts");
const authRepository = jiti("../src/lib/server/auth-repository.ts");

try {
  await pool.query(
    `insert into users (
       id, email, name, role, plan, official_minutes_total,
       official_minutes_used, password_salt, password_hash, created_at
     ) values ($1, $2, 'Legacy Cleanup Smoke', 'user', 'free', 0, 0, 'salt', 'hash', now())`,
    [userId, `legacy-cleanup-${timestamp}@ownminutes.local`],
  );
  await pool.query(
    `insert into meeting_deletion_tombstones (
       meeting_id, owner_user_id, deleted_at, cleanup_pending,
       cleanup_attempts, cleanup_next_attempt_at
     ) values ($1, $2, now(), true, 0, now())`,
    [nonCanonicalLegacyId, userId],
  );

  const listed = await lock.listMeetingDeletionIdsForOwner(userId);
  const cleanupRun = await meetingStore.runMeetingDeletionCleanupOnce("legacy-cleanup-smoke-worker", userId);
  const normalWriteLockRejectedLegacy = await lock.withMeetingWriteLock(nonCanonicalLegacyId, async () => false).then(
    () => false,
    (error) => error?.code === "invalid_meeting_id",
  );

  const deletedMeetings = await meetingStore.deleteAllUserMeetings(userId);
  await authRepository.deleteAccount(userId);
  const state = await pool.query(
    `select users.deleted_at,
            tombstone.cleanup_pending,
            tombstone.cleanup_attempts,
            tombstone.cleanup_next_attempt_at,
            tombstone.cleanup_last_error,
            tombstone.cleanup_disposition,
            tombstone.manual_cleanup_detected_at,
            tombstone.cleaned_at
     from users
     join meeting_deletion_tombstones tombstone on tombstone.owner_user_id = users.id
     where users.id = $1 and tombstone.meeting_id = $2`,
    [userId, nonCanonicalLegacyId],
  );
  const row = state.rows[0];
  const summary = {
    accountDeletionContinuesPastNonCanonicalTombstone:
      deletedMeetings.deletedMeetings === 0 && Boolean(row?.deleted_at),
    normalMeetingApiRemainsCanonical: normalWriteLockRejectedLegacy,
    nonCanonicalTombstoneIsNeverClaimed: listed.length === 0 && cleanupRun.claimed === false,
    nonCanonicalTombstoneRemainsPendingAndQuarantined:
      row?.cleanup_pending === true &&
      Number(row?.cleanup_attempts) === 0 &&
      row?.cleaned_at === null &&
      (row?.cleanup_next_attempt_at === Infinity || String(row?.cleanup_next_attempt_at).toLowerCase() === "infinity") &&
      row?.cleanup_disposition === "pending_manual_cleanup" &&
      Boolean(row?.manual_cleanup_detected_at) &&
      row?.cleanup_last_error === "legacy_noncanonical_manual_cleanup_required",
    sanitizedPrefixObjectIsPreserved:
      objects.has(sentinelObjectKey) && deleteRequests.length === 0,
  };
  console.log(JSON.stringify(summary, null, 2));
  if (Object.values(summary).some((value) => value !== true)) process.exitCode = 1;
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await pool.query("delete from users where id = $1", [userId]).catch(() => undefined);
  await pool.end();
  await new Promise((resolve) => objectStore.close(resolve));
  // jiti-loaded application modules own a separate global pg pool whose idle
  // timer is not part of this focused assertion. Exit after deterministic
  // cleanup so the smoke remains bounded in CI.
  process.exit(process.exitCode || 0);
}

function listObjectsXml(searchParams) {
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

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
}
