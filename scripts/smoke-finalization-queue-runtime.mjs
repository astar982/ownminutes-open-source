#!/usr/bin/env node

import { Client } from "pg";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { buildSilentWav } from "./lib/audio-fixtures.mjs";

const baseUrl = process.env.SMOKE_BASE_URL || "http://127.0.0.1:3102";
const databaseUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL || "";
const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
const meetingId = `queue-runtime-${timestamp}`;
const cancelledMeetingId = `queue-cancel-${timestamp}`;
const reclaimedMeetingId = `queue-reclaim-${timestamp}`;
const retryMeetingId = `queue-retry-${timestamp}`;
const exhaustedMeetingId = `queue-exhausted-${timestamp}`;
const email = `queue-runtime-${timestamp}@ownminutes.local`;
const password = `OwnMinutes-${timestamp}`;
const testIp = `198.51.${Math.floor(Math.random() * 180) + 10}.${Math.floor(Math.random() * 180) + 10}`;

async function main() {
  if (!databaseUrl) throw new Error("DATABASE_URL or POSTGRES_URL is required for the queue runtime smoke.");
  const register = await postJson("/api/auth/register", { name: "Queue Runtime Smoke", email, password }, "", {
    "x-forwarded-for": testIp,
  });
  const cookie = extractCookie(register.response);
  const upload = await uploadChunk(cookie, meetingId);
  const meetingSeal = sealFromUpload(upload);
  const first = await postJson(`/api/meetings/${meetingId}/finalize`, { title: "OwnMinutes Queue Runtime", ...meetingSeal }, cookie);
  const duplicate = await postJson(`/api/meetings/${meetingId}/finalize`, { title: "OwnMinutes Queue Runtime", ...meetingSeal }, cookie);
  const finalStatus = await waitForCompletion(cookie);
  const usage = await getJson("/api/account/usage", cookie);

  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  const jobsBeforeDelete = await client.query(
    "select id, status, attempt, max_attempts, locked_by, lease_expires_at, processing_operation_key, audio_revision from meeting_finalization_jobs where meeting_id = $1 order by created_at",
    [meetingId],
  );

  const cancelUpload = await uploadChunk(cookie, cancelledMeetingId);
  const cancelJobId = `finalize_cancel_${timestamp}`;
  const cancelLease = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  await client.query(
    "insert into meeting_finalization_jobs (id, meeting_id, owner_user_id, title, status, attempt, max_attempts, available_at, locked_at, locked_by, lease_expires_at, created_at, updated_at) values ($1,$2,$3,$4,'processing',1,5,now(),now(),'active-worker',$5,now(),now())",
    [cancelJobId, cancelledMeetingId, register.payload.user.id, "Queue cancellation smoke", cancelLease],
  );
  writeProcessingState({
    meetingId: cancelledMeetingId,
    ownerUserId: register.payload.user.id,
    title: "Queue cancellation smoke",
    jobId: cancelJobId,
    attempt: 1,
    leaseExpiresAt: cancelLease,
  });
  const duplicateDuringProcessing = await postJson(
    `/api/meetings/${cancelledMeetingId}/finalize`,
    { title: "Queue cancellation smoke", ...sealFromUpload(cancelUpload) },
    cookie,
  );
  const processingBeforeDelete = await getJson(`/api/meetings/${cancelledMeetingId}/finalize`, cookie);
  const cancelledMeeting = await deleteJson(`/api/meetings/${cancelledMeetingId}`, cookie);
  const cancelledJob = await client.query("select status from meeting_finalization_jobs where id = $1", [cancelJobId]);

  const exhaustedUpload = await uploadChunk(cookie, exhaustedMeetingId);
  const exhaustedJobId = `finalize_exhausted_${timestamp}`;
  await client.query(
    "insert into meeting_finalization_jobs (id, meeting_id, owner_user_id, title, status, attempt, max_attempts, available_at, locked_at, locked_by, lease_expires_at, created_at, updated_at) values ($1,$2,$3,$4,'processing',5,5,now(),now() - interval '2 minutes','crashed-final-worker',now() - interval '1 minute',now(),now())",
    [exhaustedJobId, exhaustedMeetingId, register.payload.user.id, "Queue exhaustion smoke"],
  );
  writeProcessingState({
    meetingId: exhaustedMeetingId,
    ownerUserId: register.payload.user.id,
    title: "Queue exhaustion smoke",
    jobId: exhaustedJobId,
    attempt: 5,
    leaseExpiresAt: new Date(Date.now() - 60_000).toISOString(),
  });
  await postJson(
    `/api/meetings/${exhaustedMeetingId}/finalize`,
    { title: "Queue exhaustion smoke", ...sealFromUpload(exhaustedUpload) },
    cookie,
  );
  const exhaustedJob = await waitForJobStatus(client, exhaustedJobId, "failed");
  const exhaustedStatus = await getJson(`/api/meetings/${exhaustedMeetingId}/finalize`, cookie);

  const reclaimUpload = await uploadChunk(cookie, reclaimedMeetingId);
  const reclaimJobId = `finalize_reclaim_${timestamp}`;
  await client.query(
    "insert into meeting_finalization_jobs (id, meeting_id, owner_user_id, title, status, attempt, max_attempts, available_at, locked_at, locked_by, lease_expires_at, created_at, updated_at) values ($1,$2,$3,$4,'processing',0,5,now(),now() - interval '2 minutes','crashed-worker',now() - interval '1 minute',now(),now())",
    [reclaimJobId, reclaimedMeetingId, register.payload.user.id, "Queue reclaim smoke"],
  );
  await postJson(
    `/api/meetings/${reclaimedMeetingId}/finalize`,
    { title: "Queue reclaim smoke", ...sealFromUpload(reclaimUpload) },
    cookie,
  );
  const reclaimedStatus = await waitForCompletion(cookie, reclaimedMeetingId);
  const reclaimedJob = await client.query("select status, attempt, locked_by, lease_expires_at from meeting_finalization_jobs where id = $1", [reclaimJobId]);

  const retryUpload = await uploadChunk(cookie, retryMeetingId);
  removeServerChunk(retryMeetingId);
  const retryQueued = await postJson(
    `/api/meetings/${retryMeetingId}/finalize`,
    { title: "Queue retry smoke", ...sealFromUpload(retryUpload) },
    cookie,
  );
  const retryWait = await waitForJobStatus(client, retryQueued.payload.job?.id, "retry_wait");
  const retryProjectionRemoved = removeServerProcessingState(retryMeetingId);
  const retryRestore = await uploadChunk(cookie, retryMeetingId);
  const retriedStatus = await waitForCompletion(cookie, retryMeetingId);
  const retriedJob = await client.query(
    "select status, attempt, locked_by, lease_expires_at, processing_operation_key, audio_revision from meeting_finalization_jobs where id = $1",
    [retryQueued.payload.job?.id],
  );

  const deleted = await deleteJson("/api/auth/delete", cookie);
  const jobsAfterDelete = await client.query("select id from meeting_finalization_jobs where owner_user_id = $1", [register.payload.user.id]);
  await client.end();

  const usageEvents = usage.payload.usage?.events?.filter((event) => event.type === "meeting_finalize" && event.note.includes(meetingId)) ?? [];
  const job = jobsBeforeDelete.rows[0];
  const serialized = JSON.stringify({ first: first.payload, duplicate: duplicate.payload, finalStatus: finalStatus.payload, job, retryWait });
  const checks = {
    registerOk: [200, 201].includes(register.response.status) && register.payload.ok === true && Boolean(cookie),
    uploadOk: upload.response.status === 200 && upload.payload.ok === true,
    firstRequestQueued:
      first.response.status === 202 &&
      first.payload.ok === true &&
      first.payload.queued === true &&
      first.payload.processing?.status === "queued" &&
      first.payload.processing?.processingOperationKey === `meeting:${meetingId}:initial` &&
      /^[a-f0-9]{64}$/.test(first.payload.processing?.audioRevision || "") &&
      Boolean(first.payload.job?.id),
    duplicateRequestUsesSameJob:
      duplicate.response.status === 202 &&
      duplicate.payload.queued === true &&
      duplicate.payload.job?.id === first.payload.job?.id,
    workerCompleted:
      finalStatus.response.status === 200 &&
      finalStatus.payload.processing?.status === "completed" &&
      finalStatus.payload.processing?.processingOperationKey === first.payload.processing?.processingOperationKey &&
      finalStatus.payload.processing?.audioRevision === first.payload.processing?.audioRevision &&
      Boolean(finalStatus.payload.result?.generatedAt),
    postgresJobCompleted:
      jobsBeforeDelete.rowCount === 1 &&
      job?.id === first.payload.job?.id &&
      job?.status === "completed" &&
      Number(job?.attempt) === 1 &&
      Number(job?.max_attempts) >= 1 &&
      job?.locked_by === null &&
      job?.lease_expires_at === null &&
      job?.processing_operation_key === first.payload.processing?.processingOperationKey &&
      job?.audio_revision === first.payload.processing?.audioRevision,
    meetingDeleteCancelsQueuedJob:
      cancelUpload.payload.ok === true &&
      duplicateDuringProcessing.payload.job?.id === cancelJobId &&
      duplicateDuringProcessing.payload.processing?.status === "processing" &&
      processingBeforeDelete.payload.processing?.status === "processing" &&
      cancelledMeeting.payload.ok === true &&
      cancelledJob.rows[0]?.status === "cancelled",
    exhaustedAttemptUpdatesUserVisibleState:
      exhaustedUpload.payload.ok === true &&
      exhaustedJob?.status === "failed" &&
      exhaustedStatus.payload.processing?.status === "failed" &&
      exhaustedStatus.payload.processing?.error?.code === "worker_attempts_exhausted" &&
      exhaustedStatus.payload.processing?.error?.retryable === false,
    expiredLeaseIsReclaimed:
      reclaimUpload.payload.ok === true &&
      reclaimedStatus.payload.processing?.status === "completed" &&
      reclaimedJob.rows[0]?.status === "completed" &&
      Number(reclaimedJob.rows[0]?.attempt) === 1 &&
      reclaimedJob.rows[0]?.locked_by === null &&
      reclaimedJob.rows[0]?.lease_expires_at === null,
    retryWaitRecoversAfterAudioRestore:
      retryUpload.payload.ok === true &&
      retryQueued.response.status === 202 &&
      retryWait?.status === "retry_wait" &&
      retryProjectionRemoved === true &&
      retryRestore.payload.ok === true &&
      retriedStatus.payload.processing?.status === "completed" &&
      retriedStatus.payload.processing?.processingOperationKey === retryQueued.payload.processing?.processingOperationKey &&
      retriedStatus.payload.processing?.audioRevision === retryQueued.payload.processing?.audioRevision &&
      retriedJob.rows[0]?.processing_operation_key === retryQueued.payload.processing?.processingOperationKey &&
      retriedJob.rows[0]?.audio_revision === retryQueued.payload.processing?.audioRevision &&
      retriedJob.rows[0]?.status === "completed" &&
      Number(retriedJob.rows[0]?.attempt) === 2 &&
      retriedJob.rows[0]?.locked_by === null &&
      retriedJob.rows[0]?.lease_expires_at === null,
    usageChargedOnce: usageEvents.length === 1,
    accountDeleteCascadesJobs: deleted.payload.ok === true && jobsAfterDelete.rowCount === 0,
    noSecretsLeaked: !/postgres(?:ql)?:\/\/|AKL[A-Za-z0-9_-]+|sk-[A-Za-z0-9_-]+|X-Api-Key/i.test(serialized),
  };

  console.log(JSON.stringify({ ok: Object.values(checks).every(Boolean), checks }, null, 2));
  if (Object.values(checks).some((value) => !value)) process.exitCode = 1;
}

async function waitForCompletion(cookie, targetMeetingId = meetingId) {
  const deadline = Date.now() + 45_000;
  let latest;
  while (Date.now() < deadline) {
    latest = await getJson(`/api/meetings/${targetMeetingId}/finalize`, cookie);
    if (latest.payload.processing?.status === "completed" || latest.payload.processing?.status === "failed") return latest;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Queue runtime smoke timed out; latest status=${latest?.payload?.processing?.status || "missing"}.`);
}

async function uploadChunk(cookie, targetMeetingId) {
  const form = new FormData();
  form.append("sequence", "1");
  form.append("mimeType", "audio/wav");
  form.append("recordedAt", String(Date.now()));
  form.append("durationMs", "1000");
  form.append("chunk", new Blob([buildSilentWav()], { type: "audio/wav" }), "chunk-000001.wav");
  const response = await fetch(`${baseUrl}/api/meetings/${targetMeetingId}/chunks`, { method: "POST", headers: { Cookie: cookie }, body: form });
  return { response, payload: await response.json() };
}

function sealFromUpload(upload) {
  return {
    expectedLastSequence: upload.payload.totalChunks,
    totalBytes: upload.payload.totalBytes,
  };
}

async function waitForJobStatus(client, jobId, expectedStatus) {
  if (!jobId) throw new Error("Queue response did not include a job id.");
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const result = await client.query("select status, attempt, available_at from meeting_finalization_jobs where id = $1", [jobId]);
    if (result.rows[0]?.status === expectedStatus) return result.rows[0];
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Queue job ${jobId} did not reach ${expectedStatus}.`);
}

function removeServerChunk(targetMeetingId) {
  const serverWorkdir = process.env.SMOKE_SERVER_WORKDIR;
  if (!serverWorkdir) throw new Error("SMOKE_SERVER_WORKDIR is required for retry recovery coverage.");
  rmSync(path.join(serverWorkdir, ".data", "meetings", targetMeetingId, "chunks", "chunk-000001.wav"), { force: true });
}

function removeServerProcessingState(targetMeetingId) {
  const serverWorkdir = process.env.SMOKE_SERVER_WORKDIR;
  if (!serverWorkdir) throw new Error("SMOKE_SERVER_WORKDIR is required for processing-state fault coverage.");
  const processingPath = path.join(serverWorkdir, ".data", "meetings", targetMeetingId, "processing.json");
  rmSync(processingPath, { force: true });
  return true;
}

function writeProcessingState({ meetingId: targetMeetingId, ownerUserId, title, jobId, attempt, leaseExpiresAt }) {
  const serverWorkdir = process.env.SMOKE_SERVER_WORKDIR;
  if (!serverWorkdir) throw new Error("SMOKE_SERVER_WORKDIR is required for queue state coverage.");
  const directory = path.join(serverWorkdir, ".data", "meetings", targetMeetingId);
  mkdirSync(directory, { recursive: true });
  const now = new Date().toISOString();
  writeFileSync(
    path.join(directory, "processing.json"),
    `${JSON.stringify(
      {
        meetingId: targetMeetingId,
        ownerUserId,
        title,
        status: "processing",
        attempt,
        jobId,
        requestedAt: now,
        startedAt: now,
        updatedAt: now,
        leaseExpiresAt,
      },
      null,
      2,
    )}\n`,
  );
}

async function getJson(route, cookie) {
  const response = await fetch(`${baseUrl}${route}`, { headers: { Cookie: cookie } });
  return { response, payload: await response.json() };
}

async function postJson(route, body, cookie, extraHeaders = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie, ...extraHeaders },
    body: JSON.stringify(body),
  });
  return { response, payload: await response.json() };
}

async function deleteJson(route, cookie) {
  const response = await fetch(`${baseUrl}${route}`, { method: "DELETE", headers: { Cookie: cookie } });
  return { response, payload: await response.json() };
}

function extractCookie(response) {
  return response.headers.get("set-cookie")?.split(";")[0] ?? "";
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
