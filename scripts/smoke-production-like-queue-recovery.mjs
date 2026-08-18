#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { buildSilentWav } from "./lib/audio-fixtures.mjs";

const baseUrl = process.env.SMOKE_BASE_URL || "http://127.0.0.1:3200";
const composeFile = process.env.OWNMINUTES_COMPOSE_FILE || "";
const composeEnvFile = process.env.OWNMINUTES_COMPOSE_ENV_FILE || "";
const composeCwd = process.env.OWNMINUTES_COMPOSE_CWD || process.cwd();
const composeProjectName = process.env.OWNMINUTES_COMPOSE_PROJECT_NAME || "";
const timestamp = `${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${process.pid}`;
const crashMeetingId = `queue-crash-${timestamp}`;
const retryMeetingId = `queue-retry-${timestamp}`;
const exhaustMeetingId = `queue-exhaust-${timestamp}`;
const email = `queue-recovery-${timestamp}@ownminutes.local`;
const password = `OwnMinutes-${timestamp}`;
const testIp = `198.51.${Math.floor(Math.random() * 180) + 10}.${Math.floor(Math.random() * 180) + 10}`;

if (!composeFile || !composeEnvFile || !/^ownminutes-(?:production-like|pl-wt-[a-f0-9]{12})$/.test(composeProjectName)) {
  throw new Error("A valid production-like Compose file, environment file and project name are required.");
}

await main();

async function main() {
  let cookie = "";
  let accountDeleted = false;
  let workerOneKilled = false;

  try {
    compose(["up", "--detach", "worker-1", "worker-2"]);
    const register = await requestJson(`${baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Queue Recovery Smoke", email, password }),
      acceptedStatuses: [200, 201],
    });
    cookie = extractCookie(register.response);

    compose(["stop", "worker-2"]);
    const crashUpload = await uploadMeeting(cookie, crashMeetingId);
    const crashQueued = await queueMeeting(cookie, crashMeetingId, "Queue crash reclaim smoke", crashUpload);
    const initialClaim = await waitForJob(
      crashMeetingId,
      (job) => job.status === "processing" && job.attempt === 1 && Boolean(job.locked_by),
      15_000,
      "initial Worker claim",
    );
    compose(["kill", "worker-1"]);
    workerOneKilled = true;
    compose(["stop", "worker-1"]);
    compose(["up", "--detach", "worker-2"]);
    const recoveryServices = runningServices();

    const reclaimedClaim = await waitForJob(
      crashMeetingId,
      (job) =>
        job.status === "processing" &&
        job.attempt === 2 &&
        Boolean(job.locked_by) &&
        job.locked_by !== initialClaim.locked_by,
      55_000,
      "second Worker lease reclaim",
    );
    const crashCompleted = await waitForFinalization(cookie, crashMeetingId, "completed", 30_000);
    const crashJob = await readJob(crashMeetingId);

    compose(["up", "--detach", "worker-1"]);
    await waitForRunningWorkers();

    const retryUpload = await uploadMeeting(cookie, retryMeetingId);
    const retryQueued = await queueMeeting(cookie, retryMeetingId, "Queue retry-once smoke", retryUpload);
    const retryWait = await waitForJob(
      retryMeetingId,
      (job) => job.status === "retry_wait" && job.attempt === 1,
      15_000,
      "retry_wait after a temporary failure",
    );
    compose(["stop", "worker-1", "worker-2"]);
    const retryProjectionDeleted = deleteProcessingProjection(retryMeetingId);
    compose(["up", "--detach", "worker-1", "worker-2"]);
    await waitForRunningWorkers();
    const retryCompleted = await waitForFinalization(cookie, retryMeetingId, "completed", 30_000);
    const retryJob = await readJob(retryMeetingId);

    const exhaustUpload = await uploadMeeting(cookie, exhaustMeetingId);
    const exhaustQueued = await queueMeeting(cookie, exhaustMeetingId, "Queue bounded exhaustion smoke", exhaustUpload);
    const exhaustFailed = await waitForFinalization(cookie, exhaustMeetingId, "failed", 30_000);
    const exhaustJob = await readJob(exhaustMeetingId);
    const usage = await requestJson(`${baseUrl}/api/account/usage`, { headers: { Cookie: cookie } });
    const crashUsage = meetingUsageEvents(usage.payload, crashMeetingId);
    const retryUsage = meetingUsageEvents(usage.payload, retryMeetingId);
    const exhaustUsage = meetingUsageEvents(usage.payload, exhaustMeetingId);

    const deletionTicket = await requestJson(`${baseUrl}/api/auth/delete`, {
      headers: { Cookie: cookie },
    });
    const deleteAccount = await requestJson(`${baseUrl}/api/auth/delete`, {
      method: "DELETE",
      headers: { Cookie: cookie },
      acceptedStatuses: [200, 202],
    });
    accountDeleted = deleteAccount.payload.ok === true;
    const deletionStatus = await waitForAccountDeletion(deletionTicket.payload.ticket);
    const remainingJobs = await countJobsForUser(register.payload.user.id);
    const runningWorkers = runningServices();
    const serialized = JSON.stringify({
      crashQueued: crashQueued.payload,
      crashCompleted: crashCompleted.payload,
      retryQueued: retryQueued.payload,
      retryWait: { status: retryWait.status, attempt: retryWait.attempt },
      retryCompleted: retryCompleted.payload,
      exhaustQueued: exhaustQueued.payload,
      exhaustFailed: exhaustFailed.payload,
    });

    const checks = {
      registered: register.payload.ok === true && Boolean(cookie),
      firstWorkerActuallyKilled: workerOneKilled,
      onlySecondWorkerRunsDuringReclaim:
        !recoveryServices.includes("worker-1") && recoveryServices.includes("worker-2"),
      crashRequestQueued: crashQueued.response.status === 202 && crashQueued.payload.queued === true,
      secondWorkerReclaimedExpiredLease:
        initialClaim.attempt === 1 &&
        reclaimedClaim.attempt === 2 &&
        initialClaim.locked_by !== reclaimedClaim.locked_by,
      crashJobCompletedOnce:
        crashCompleted.payload.processing?.status === "completed" &&
        crashJob?.status === "completed" &&
        crashJob?.attempt === 2 &&
        crashJob?.locked_by === null &&
        crashUsage.length === 1,
      temporaryFailureEnteredRetryWait:
        retryQueued.response.status === 202 && retryWait.status === "retry_wait" && retryWait.attempt === 1,
      retrySucceededOnSecondAttempt:
        retryProjectionDeleted &&
        retryCompleted.payload.processing?.status === "completed" &&
        retryCompleted.payload.processing?.processingOperationKey === retryQueued.payload.processing?.processingOperationKey &&
        retryCompleted.payload.processing?.audioRevision === retryQueued.payload.processing?.audioRevision &&
        retryJob?.status === "completed" &&
        retryJob?.attempt === 2 &&
        retryJob?.locked_by === null &&
        retryJob?.processing_operation_key === retryQueued.payload.processing?.processingOperationKey &&
        retryJob?.audio_revision === retryQueued.payload.processing?.audioRevision &&
        retryUsage.length === 1,
      persistentFailureStoppedAtBound:
        exhaustFailed.payload.processing?.status === "failed" &&
        exhaustFailed.payload.processing?.error?.retryable === false &&
        exhaustJob?.status === "failed" &&
        exhaustJob?.attempt === 3 &&
        exhaustJob?.max_attempts === 3 &&
        exhaustJob?.locked_by === null &&
        exhaustUsage.length === 0,
      bothWorkersRestored: runningWorkers.includes("worker-1") && runningWorkers.includes("worker-2"),
      accountAndJobsDeleted:
        accountDeleted &&
        deletionStatus.payload.status === "deleted" &&
        remainingJobs === 0,
      noSecretsOrInternalErrorsExposed:
        !/postgres(?:ql)?:\/\/|AKL[A-Za-z0-9_-]+|sk-[A-Za-z0-9_-]+|X-Api-Key|\/var\/|\/tmp\/|X-Amz/i.test(
          serialized,
        ),
    };
    const summary = { ok: Object.values(checks).every(Boolean), checks };
    console.log(JSON.stringify(summary, null, 2));
    if (!summary.ok) process.exitCode = 1;
  } finally {
    compose(["up", "--detach", "worker-1", "worker-2"], { allowFailure: true });
    if (cookie && !accountDeleted) {
      await requestJson(`${baseUrl}/api/auth/delete`, {
        method: "DELETE",
        headers: { Cookie: cookie },
        acceptedStatuses: [200, 202],
      }).catch(() => undefined);
    }
  }
}

async function uploadMeeting(cookie, meetingId) {
  const form = new FormData();
  form.append("sequence", "1");
  form.append("mimeType", "audio/wav");
  form.append("recordedAt", String(Date.now()));
  form.append("durationMs", "1000");
  form.append("chunk", new Blob([buildSilentWav(16_000, 1)], { type: "audio/wav" }), "chunk-000001.wav");
  const upload = await requestJson(`${baseUrl}/api/meetings/${meetingId}/chunks`, {
    method: "POST",
    headers: { Cookie: cookie },
    body: form,
  });
  if (upload.payload.ok !== true) throw new Error(`Unable to upload queue recovery fixture for ${meetingId}.`);
  return upload.payload;
}

function queueMeeting(cookie, meetingId, title, upload) {
  return requestJson(`${baseUrl}/api/meetings/${meetingId}/finalize`, {
    method: "POST",
    headers: { Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify({
      title,
      expectedLastSequence: upload.totalChunks,
      totalBytes: upload.totalBytes,
    }),
    acceptedStatuses: [202],
  });
}

async function waitForFinalization(cookie, meetingId, expectedStatus, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let latest = null;
  while (Date.now() < deadline) {
    latest = await requestJson(`${baseUrl}/api/meetings/${meetingId}/finalize`, { headers: { Cookie: cookie } });
    const status = latest.payload.processing?.status;
    if (status === expectedStatus) return latest;
    if (status === "failed" && expectedStatus !== "failed") {
      throw new Error(`Meeting ${meetingId} failed instead of reaching ${expectedStatus}.`);
    }
    await sleep(250);
  }
  throw new Error(`Meeting ${meetingId} did not reach ${expectedStatus}; latest=${latest?.payload.processing?.status || "missing"}.`);
}

async function waitForJob(meetingId, predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let latest = null;
  while (Date.now() < deadline) {
    latest = await readJob(meetingId);
    if (latest && predicate(latest)) return latest;
    await sleep(100);
  }
  throw new Error(`${label} was not observed for ${meetingId}; latest=${JSON.stringify(latest)}.`);
}

async function readJob(meetingId) {
  assertSafeIdentifier(meetingId);
  const sql = `select row_to_json(job) from (select status, attempt, max_attempts, locked_by, lease_expires_at, processing_operation_key, audio_revision from meeting_finalization_jobs where meeting_id = '${meetingId}' order by created_at desc limit 1) job`;
  const output = compose(
    ["exec", "-T", "postgres", "psql", "-U", "postgres", "-d", "ownminutes", "-tA", "-v", "ON_ERROR_STOP=1", "-c", sql],
    { capture: true },
  ).trim();
  return output ? JSON.parse(output) : null;
}

function deleteProcessingProjection(meetingId) {
  assertSafeIdentifier(meetingId);
  const command = [
    'mc alias set local http://minio:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD" >/dev/null',
    `mc rm --force "local/$OWNMINUTES_BUCKET/$OWNMINUTES_STORAGE_PREFIX/${meetingId}/processing.json" >/dev/null`,
    `! mc stat "local/$OWNMINUTES_BUCKET/$OWNMINUTES_STORAGE_PREFIX/${meetingId}/processing.json" >/dev/null 2>&1`,
  ].join(" && ");
  compose(["run", "--rm", "--no-deps", "--entrypoint", "/bin/sh", "minio-init", "-c", command]);
  return true;
}

async function countJobsForUser(userId) {
  assertSafeIdentifier(userId);
  const sql = `select count(*) from meeting_finalization_jobs where owner_user_id = '${userId}'`;
  const output = compose(
    ["exec", "-T", "postgres", "psql", "-U", "postgres", "-d", "ownminutes", "-tA", "-v", "ON_ERROR_STOP=1", "-c", sql],
    { capture: true },
  ).trim();
  return Number(output);
}

async function waitForRunningWorkers() {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const services = runningServices();
    if (services.includes("worker-1") && services.includes("worker-2")) return;
    await sleep(250);
  }
  throw new Error("Both finalization workers did not return to running state.");
}

function runningServices() {
  return compose(["ps", "--status", "running", "--services"], { capture: true })
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean);
}

function meetingUsageEvents(payload, meetingId) {
  return payload.usage?.events?.filter((event) => event.type === "meeting_finalize" && event.note?.includes(meetingId)) || [];
}

async function waitForAccountDeletion(ticket) {
  const deadline = Date.now() + 30_000;
  let latest = null;
  while (Date.now() < deadline) {
    latest = await requestJson(`${baseUrl}/api/auth/delete`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ticket }),
    });
    if (latest.payload.status === "deleted") return latest;
    if (latest.payload.status === "active") {
      throw new Error("Queue recovery account deletion unexpectedly returned active.");
    }
    await sleep(300);
  }
  throw new Error(`Queue recovery account cleanup did not finish; latest=${latest?.payload.status || "missing"}.`);
}

function compose(args, options = {}) {
  const result = spawnSync(
    "docker",
    [
      "compose",
      "--project-name",
      composeProjectName,
      "--env-file",
      composeEnvFile,
      "--file",
      composeFile,
      ...args,
    ],
    { cwd: composeCwd, encoding: "utf8", stdio: options.capture ? "pipe" : "ignore" },
  );
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(`docker compose ${args.join(" ")} failed: ${(result.stderr || result.stdout || "").trim()}`);
  }
  return result.stdout || "";
}

async function requestJson(url, init = {}) {
  const { acceptedStatuses = [200], ...requestInit } = init;
  const method = String(requestInit.method || "GET").toUpperCase();
  const headers = new Headers(requestInit.headers);
  const publishedUrl = new URL(baseUrl);
  headers.set("X-OwnMinutes-Client-IP", testIp);
  headers.set("X-OwnMinutes-Proxy-Source", "production-like-smoke");
  headers.set("X-Forwarded-Host", publishedUrl.host);
  headers.set("X-Forwarded-Proto", publishedUrl.protocol.replace(":", ""));
  if (
    !["GET", "HEAD", "OPTIONS"].includes(method) &&
    !headers.has("Origin") &&
    !headers.has("Sec-Fetch-Site")
  ) {
    headers.set("Origin", publishedUrl.origin);
    headers.set("Sec-Fetch-Site", "same-origin");
  }
  const response = await fetch(url, { ...requestInit, headers });
  const text = await response.text();
  let payload = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    payload = {};
  }
  if (!acceptedStatuses.includes(response.status)) {
    throw new Error(`HTTP ${response.status} from ${new URL(url).pathname}.`);
  }
  return { payload, response };
}

function extractCookie(response) {
  return response.headers.get("set-cookie")?.split(";")[0] || "";
}

function assertSafeIdentifier(value) {
  if (!/^[a-zA-Z0-9_-]+$/.test(value)) throw new Error("Unsafe identifier in queue recovery verifier.");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
