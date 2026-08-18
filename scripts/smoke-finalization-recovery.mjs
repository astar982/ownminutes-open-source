#!/usr/bin/env node

import { existsSync, rmSync } from "node:fs";
import path from "node:path";
import { buildSilentWav } from "./lib/audio-fixtures.mjs";

const baseUrl = process.env.SMOKE_BASE_URL || "http://127.0.0.1:3003";
const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
const meetingId = `smoke-finalization-${timestamp}`;
const recoveryMeetingId = `smoke-finalization-retry-${timestamp}`;
const email = `finalization-${timestamp}@ownminutes.local`;
const password = `OwnMinutes-${timestamp}`;
const testIp = `198.51.${Math.floor(Math.random() * 180) + 10}.${Math.floor(Math.random() * 180) + 10}`;
const processingPath = path.join(process.cwd(), ".data", "meetings", meetingId, "processing.json");
const recoveryProcessingPath = path.join(process.cwd(), ".data", "meetings", recoveryMeetingId, "processing.json");

async function main() {
  const register = await postJson("/api/auth/register", { name: "Finalization Recovery Smoke", email, password }, "", {
    "x-forwarded-for": testIp,
  });
  const cookie = extractCookie(register.response);
  const upload = await uploadChunk(cookie, meetingId);
  const before = await getJson(`/api/meetings/${meetingId}/finalize`, cookie);
  const seal = {
    expectedLastSequence: upload.payload.totalChunks,
    totalBytes: upload.payload.totalBytes,
  };
  const [first, concurrent] = await Promise.all([
    postJson(`/api/meetings/${meetingId}/finalize`, { title: "OwnMinutes 会后恢复烟测", ...seal }, cookie),
    postJson(`/api/meetings/${meetingId}/finalize`, { title: "OwnMinutes 会后恢复烟测", ...seal }, cookie),
  ]);
  const status = await getJson(`/api/meetings/${meetingId}/finalize`, cookie);
  rmSync(path.join(process.cwd(), ".data", "meetings", meetingId, "chunks", "chunk-000001.wav"), { force: true });
  const idempotent = await postJson(`/api/meetings/${meetingId}/finalize`, { title: "OwnMinutes 会后恢复烟测", ...seal }, cookie);
  const detail = await getJson(`/api/meetings/${meetingId}`, cookie);
  const meetings = await getJson("/api/meetings", cookie);
  const listed = meetings.payload.meetings?.find((meeting) => meeting.meetingId === meetingId);
  const usage = await getJson("/api/account/usage", cookie);
  const meetingUsageEvents = usage.payload.usage?.events?.filter((event) => event.type === "meeting_finalize" && event.note.includes(meetingId)) ?? [];
  const humanReview = await postJson(`/api/meetings/${meetingId}/review`, { confirmed: true }, cookie);
  const blockedShare = await postJson(
    `/api/meetings/${meetingId}/share`,
    { visibility: "public", includeTranscript: false },
    cookie,
  );
  const confirmedShare = await postJson(
    `/api/meetings/${meetingId}/share`,
    { visibility: "public", includeTranscript: false, confirmUnverified: true },
    cookie,
  );

  const recoveryUpload = await uploadChunk(cookie, recoveryMeetingId);
  rmSync(path.join(process.cwd(), ".data", "meetings", recoveryMeetingId, "chunks", "chunk-000001.wav"), { force: true });
  const failedFinalize = await postJson(
    `/api/meetings/${recoveryMeetingId}/finalize`,
    {
      title: "OwnMinutes 会后失败恢复烟测",
      expectedLastSequence: recoveryUpload.payload.totalChunks,
      totalBytes: recoveryUpload.payload.totalBytes,
    },
    cookie,
  );
  const failedStatus = await getJson(`/api/meetings/${recoveryMeetingId}/finalize`, cookie);
  const failedUsage = await getJson("/api/account/usage", cookie);
  const failedMeetingUsageEvents = failedUsage.payload.usage?.events?.filter(
    (event) => event.type === "meeting_finalize" && event.note.includes(recoveryMeetingId),
  ) ?? [];
  const restoredUpload = await uploadChunk(cookie, recoveryMeetingId);
  const recoveredFinalize = await postJson(
    `/api/meetings/${recoveryMeetingId}/finalize`,
    {
      title: "OwnMinutes 会后失败恢复烟测",
      expectedLastSequence: restoredUpload.payload.totalChunks,
      totalBytes: restoredUpload.payload.totalBytes,
    },
    cookie,
  );
  const recoveredStatus = await getJson(`/api/meetings/${recoveryMeetingId}/finalize`, cookie);
  const recoveredUsage = await getJson("/api/account/usage", cookie);
  const recoveredMeetingUsageEvents = recoveredUsage.payload.usage?.events?.filter(
    (event) => event.type === "meeting_finalize" && event.note.includes(recoveryMeetingId),
  ) ?? [];
  const processingFileCreated = existsSync(processingPath);
  const recoveryProcessingFileCreated = existsSync(recoveryProcessingPath);
  const deleted = await deleteJson(`/api/meetings/${meetingId}`, cookie);
  const recoveryDeleted = await deleteJson(`/api/meetings/${recoveryMeetingId}`, cookie);
  const processingFileDeleted = !existsSync(processingPath) && !existsSync(recoveryProcessingPath);
  await deleteJson("/api/auth/delete", cookie);

  const serialized = JSON.stringify({ first: first.payload, concurrent: concurrent.payload, status: status.payload, idempotent: idempotent.payload });
  const checks = {
    registerOk: register.payload.ok === true && Boolean(cookie),
    uploadOk: upload.payload.ok === true && upload.payload.totalChunks === 1,
    initialStatusHasNoResult: before.response.status === 200 && before.payload.ok === true && before.payload.processing === null && before.payload.result === null,
    concurrentRequestsDeduplicated:
      first.response.status === 200 &&
      concurrent.response.status === 200 &&
      first.payload.result?.generatedAt === concurrent.payload.result?.generatedAt &&
      first.payload.processing?.attempt === 1 &&
      concurrent.payload.processing?.attempt === 1,
    completedStatePersisted:
      status.payload.processing?.status === "completed" &&
      status.payload.processing?.resultGeneratedAt === status.payload.result?.generatedAt &&
      status.payload.processing?.qualityStatus === "unverified" &&
      !status.payload.processing?.leaseExpiresAt,
    idempotentRetryReturnsExistingResult:
      idempotent.payload.ok === true &&
      idempotent.payload.idempotent === true &&
      idempotent.payload.result?.generatedAt === first.payload.result?.generatedAt &&
      idempotent.payload.processing?.attempt === 1,
    idempotentRecoveryDoesNotNeedAudioObject: idempotent.response.status === 200 && idempotent.payload.idempotent === true,
    detailExposesProcessing: detail.payload.meeting?.processing?.status === "completed" && detail.payload.meeting?.qualityStatus === "unverified",
    listExposesProcessing: listed?.processing?.status === "completed" && listed?.qualityStatus === "unverified",
    usageChargedOnce: meetingUsageEvents.length === 1,
    humanReviewConfirmed: humanReview.response.status === 200 && humanReview.payload.humanReview?.status === "confirmed",
    unverifiedShareRequiresApiConfirmation:
      blockedShare.response.status === 409 &&
      blockedShare.payload.code === "unverified_result_confirmation_required" &&
      blockedShare.payload.qualityConfirmationRequired === true,
    explicitUnverifiedShareAccepted: confirmedShare.response.status === 200 && confirmedShare.payload.share?.visibility === "public",
    failedStateIsDurableAndRetryable:
      recoveryUpload.payload.ok === true &&
      failedFinalize.response.status === 503 &&
      failedFinalize.payload.code === "provider_or_storage_temporary_failure" &&
      failedFinalize.payload.error === "会后处理服务暂时不可用，原始音频仍已保留。请稍后重新生成纪要。" &&
      failedFinalize.payload.processing?.status === "failed" &&
      failedFinalize.payload.processing?.attempt === 1 &&
      failedFinalize.payload.retryable === true &&
      failedStatus.payload.processing?.status === "failed" &&
      failedStatus.payload.processing?.error?.retryable === true,
    preProviderFailureDoesNotConsumeQuota:
      failedMeetingUsageEvents.length === 0 &&
      failedUsage.payload.usage?.officialMinutesUsed === usage.payload.usage?.officialMinutesUsed,
    failedMeetingRecoversAfterAudioRestore:
      restoredUpload.payload.ok === true &&
      recoveredFinalize.response.status === 200 &&
      recoveredFinalize.payload.processing?.status === "completed" &&
      recoveredFinalize.payload.processing?.attempt === 2 &&
      recoveredStatus.payload.processing?.status === "completed" &&
      recoveredStatus.payload.processing?.attempt === 2 &&
      recoveredMeetingUsageEvents.length === 1,
    processingFileLifecycle:
      processingFileCreated &&
      recoveryProcessingFileCreated &&
      deleted.payload.ok === true &&
      recoveryDeleted.payload.ok === true &&
      processingFileDeleted,
    noSecretsLeaked:
      !/AKL[A-Za-z0-9_-]+|sk-[A-Za-z0-9_-]+|X-Api-Key|\/var\/|\/tmp\/|\/Users\/|ENOENT|https?:\/\//i.test(serialized),
  };

  console.log(JSON.stringify({
    ok: Object.values(checks).every(Boolean),
    checks,
    recoveryDiagnostic: {
      failedHttpStatus: failedFinalize.response.status,
      failedCode: failedFinalize.payload.code,
      failedProcessingStatus: failedFinalize.payload.processing?.status,
      failedAttempt: failedFinalize.payload.processing?.attempt,
      failedRetryable: failedFinalize.payload.retryable,
      persistedStatus: failedStatus.payload.processing?.status,
      recoveredHttpStatus: recoveredFinalize.response.status,
      recoveredStatus: recoveredFinalize.payload.processing?.status,
      recoveredAttempt: recoveredFinalize.payload.processing?.attempt,
    },
  }, null, 2));
  if (Object.values(checks).some((value) => !value)) process.exitCode = 1;
}

async function uploadChunk(cookie, targetMeetingId) {
  const form = new FormData();
  form.append("sequence", "1");
  form.append("mimeType", "audio/wav");
  form.append("recordedAt", String(Date.now()));
  form.append("durationMs", "1000");
  form.append("chunk", new Blob([buildSilentWav()], { type: "audio/wav" }), "chunk-000001.wav");
  const response = await fetch(`${baseUrl}/api/meetings/${targetMeetingId}/chunks`, {
    method: "POST",
    headers: { Cookie: cookie },
    body: form,
  });
  return { response, payload: await response.json() };
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
  console.error(error);
  process.exitCode = 1;
});
