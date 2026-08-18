#!/usr/bin/env node

import { buildSilentWav } from "./lib/audio-fixtures.mjs";

const baseUrl = process.env.SMOKE_BASE_URL || "http://127.0.0.1:3003";
const requestOrigin = new URL(baseUrl).origin;
const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
const email = `smoke-delete-${timestamp}@ownminutes.local`;
const password = `OwnMinutesDelete-${timestamp}`;
const testIp = `198.51.120.${Number(timestamp.slice(-2)) || 42}`;
const meetingId = `smoke-delete-meeting-${timestamp}`;

async function main() {
  const register = await postJson(
    "/api/auth/register",
    {
      name: "Deletion Smoke",
      email,
      password,
    },
    null,
    { headers: { "x-forwarded-for": testIp } },
  );
  const cookie = extractCookie(register.response);

  const upload = await uploadChunk(meetingId, cookie);
  const finalized = await postJson(
    `/api/meetings/${meetingId}/finalize`,
    {
      title: "OwnMinutes deletion smoke meeting",
      expectedLastSequence: upload.totalChunks,
      totalBytes: upload.totalBytes,
    },
    cookie,
  );
  const review = await postJson(`/api/meetings/${meetingId}/review`, { confirmed: true }, cookie);
  const publish = await postJson(`/api/meetings/${meetingId}/share`, { visibility: "public", includeTranscript: false, confirmUnverified: true }, cookie);
  const provider = await postJson(
    "/api/account/provider-credentials",
    {
      providerId: "volcano-asr",
      label: "Deletion Smoke ASR",
      fields: { VOLCANO_ASR_APP_ID: "deletion-smoke-app-id" },
      secrets: { VOLCANO_ASR_API_KEY: "deletion-smoke-secret", VOLCANO_ASR_TOKEN: "deletion-smoke-token" },
    },
    cookie,
  );
  const providersBeforeDelete = await getJson("/api/account/provider-credentials", cookie);
  const usageBeforeDelete = await getJson("/api/account/usage", cookie);
  const exportBeforeDelete = await getJson("/api/account/export", cookie);
  const meetingsBeforeDelete = await getJson("/api/meetings", cookie);
  const shareBeforeDelete = await fetchText(`/share/${meetingId}`);
  const markdownBeforeDelete = await fetchText(`/api/share/${meetingId}/markdown`);

  // The client persists this signed receipt before DELETE so it can reconcile
  // an accepted asynchronous cleanup after the session cookie is invalidated.
  const deletionReceipt = await getJson("/api/auth/delete", cookie);

  const deleteResult = await fetch(`${baseUrl}/api/auth/delete`, {
    method: "DELETE",
    headers: { Cookie: cookie, Origin: requestOrigin },
  });
  const deletePayload = await readJson(deleteResult, "/api/auth/delete", { allowError: true });
  const deletionStatus = await waitForDeletionStatus(deletionReceipt.payload.ticket);

  const meAfterDelete = await getJson("/api/auth/me", cookie, { allowError: true });
  const providersAfterDelete = await getJson("/api/account/provider-credentials", cookie, { allowError: true });
  const usageAfterDelete = await getJson("/api/account/usage", cookie, { allowError: true });
  const exportAfterDelete = await fetch(`${baseUrl}/api/account/export`, { headers: { Cookie: cookie } });
  const exportAfterDeleteText = await exportAfterDelete.text();
  const meetingsAfterDelete = await getJson("/api/meetings", cookie, { allowError: true });
  const meetingAfterDelete = await getJson(`/api/meetings/${meetingId}`, cookie, { allowError: true });
  const shareAfterDelete = await fetchText(`/share/${meetingId}`);
  const markdownAfterDelete = await fetchText(`/api/share/${meetingId}/markdown`, { allowError: true });
  const secondDelete = await fetch(`${baseUrl}/api/auth/delete`, {
    method: "DELETE",
    headers: { Cookie: cookie, Origin: requestOrigin },
  });
  const secondDeletePayload = await readJson(secondDelete, "/api/auth/delete", { allowError: true });
  const loginAfterDelete = await postJson("/api/auth/login", { email, password }, null, { allowError: true });

  const exportBeforeDeleteText = JSON.stringify(exportBeforeDelete.payload);
  const summary = {
    registerOk: register.payload.ok === true,
    finalizeOk: finalized.payload.ok === true,
    reviewConfirmed: review.payload.ok === true && review.payload.humanReview?.status === "confirmed",
    publishOk: publish.payload.ok === true,
    providerSaveOk: provider.payload.ok === true,
    providerVisibleBeforeDelete: providersBeforeDelete.payload.providerCredentials?.some((item) => item.providerId === "volcano-asr") === true,
    usageVisibleBeforeDelete:
      usageBeforeDelete.payload.ok === true &&
      usageBeforeDelete.payload.usage?.events?.some((event) => event.type === "meeting_finalize" && event.note.includes(meetingId)) === true,
    exportHasMeetingBeforeDelete: exportBeforeDelete.payload.meetings?.some((meeting) => meeting.meetingId === meetingId) === true,
    exportHidesSecretsBeforeDelete:
      !exportBeforeDeleteText.includes("deletion-smoke-secret") && !exportBeforeDeleteText.includes("deletion-smoke-token"),
    meetingsListHasMeetingBeforeDelete: meetingsBeforeDelete.payload.meetings?.some((meeting) => meeting.meetingId === meetingId) === true,
    shareVisibleBeforeDelete: shareBeforeDelete.status === 200 && shareBeforeDelete.text.includes("公开分享的会议纪要"),
    markdownVisibleBeforeDelete: markdownBeforeDelete.status === 200 && markdownBeforeDelete.text.includes("OwnMinutes deletion smoke meeting"),
    deletionReceiptDurable:
      deletionReceipt.payload.ok === true &&
      typeof deletionReceipt.payload.ticket === "string" &&
      deletionReceipt.payload.ticket.length > 32 &&
      Number.isFinite(Date.parse(deletionReceipt.payload.expiresAt)),
    deleteStatusMatchesBody:
      (deletePayload.status === "pending_cleanup" && deleteResult.status === 202) ||
      (deletePayload.status === "deleted" && deleteResult.status === 200),
    deleteOk: deletePayload.ok === true,
    deletionEventuallyConfirmed: deletionStatus === "deleted",
    deletionResponseMinimizesIdentifiers:
      !("deletedMeetings" in deletePayload) &&
      !("deletedMeetingIds" in deletePayload) &&
      !JSON.stringify(deletePayload).includes(meetingId),
    sessionInvalidAfterDelete: meAfterDelete.response.status === 401 && meAfterDelete.payload.ok === false && meAfterDelete.payload.user === null,
    providersRejectedAfterDelete: providersAfterDelete.response.status === 401 && providersAfterDelete.payload.ok === false,
    usageRejectedAfterDelete: usageAfterDelete.response.status === 401 && usageAfterDelete.payload.ok === false,
    exportRejectedAfterDelete: exportAfterDelete.status === 401 && exportAfterDeleteText.includes("请先登录"),
    meetingsRejectedAfterDelete: meetingsAfterDelete.response.status === 401 && meetingsAfterDelete.payload.ok === false,
    meetingRejectedAfterDelete: meetingAfterDelete.response.status === 401 && meetingAfterDelete.payload.ok === false,
    shareHiddenAfterDelete: shareAfterDelete.status === 200 && shareAfterDelete.text.includes("尚未公开"),
    markdownRejectedAfterDelete: markdownAfterDelete.status === 404 && markdownAfterDelete.text.includes("尚未公开"),
    secondDeleteRejected: secondDelete.status === 401 && secondDeletePayload.ok === false,
    loginRejectedAfterDelete: loginAfterDelete.response.status === 401 && loginAfterDelete.payload.ok === false,
    leaksSecrets:
      JSON.stringify(deletePayload).includes("deletion-smoke-secret") ||
      JSON.stringify(providersAfterDelete.payload).includes("deletion-smoke-secret") ||
      exportAfterDeleteText.includes("deletion-smoke-secret"),
  };

  console.log(JSON.stringify(summary, null, 2));

  if (
    !summary.registerOk ||
    !summary.finalizeOk ||
    !summary.reviewConfirmed ||
    !summary.publishOk ||
    !summary.providerSaveOk ||
    !summary.providerVisibleBeforeDelete ||
    !summary.usageVisibleBeforeDelete ||
    !summary.exportHasMeetingBeforeDelete ||
    !summary.exportHidesSecretsBeforeDelete ||
    !summary.meetingsListHasMeetingBeforeDelete ||
    !summary.shareVisibleBeforeDelete ||
    !summary.markdownVisibleBeforeDelete ||
    !summary.deletionReceiptDurable ||
    !summary.deleteStatusMatchesBody ||
    !summary.deleteOk ||
    !summary.deletionEventuallyConfirmed ||
    !summary.deletionResponseMinimizesIdentifiers ||
    !summary.sessionInvalidAfterDelete ||
    !summary.providersRejectedAfterDelete ||
    !summary.usageRejectedAfterDelete ||
    !summary.exportRejectedAfterDelete ||
    !summary.meetingsRejectedAfterDelete ||
    !summary.meetingRejectedAfterDelete ||
    !summary.shareHiddenAfterDelete ||
    !summary.markdownRejectedAfterDelete ||
    !summary.secondDeleteRejected ||
    !summary.loginRejectedAfterDelete ||
    summary.leaksSecrets
  ) {
    process.exitCode = 1;
  }
}

async function waitForDeletionStatus(ticket) {
  if (typeof ticket !== "string" || !ticket) throw new Error("Missing signed account deletion receipt.");
  const startedAt = Date.now();
  let lastStatus = "unknown";
  while (Date.now() - startedAt < 30_000) {
    const result = await postJson("/api/auth/delete", { ticket }, null, { allowError: true });
    if (result.response.ok) {
      lastStatus = String(result.payload.status || "unknown");
      if (lastStatus === "deleted") return lastStatus;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Account deletion did not reach deleted; last status was ${lastStatus}.`);
}

async function uploadChunk(id, cookie) {
  const audio = new Blob([buildSilentWav(16_000, 1)], {
    type: "audio/wav",
  });
  const form = new FormData();
  form.append("sequence", "1");
  form.append("mimeType", "audio/wav");
  form.append("recordedAt", String(Date.now()));
  form.append("durationMs", "1000");
  form.append("chunk", audio, "chunk-000001.wav");

  const response = await fetch(`${baseUrl}/api/meetings/${id}/chunks`, {
    method: "POST",
    headers: { Cookie: cookie, Origin: requestOrigin },
    body: form,
  });
  return readJson(response, `/api/meetings/${id}/chunks`);
}

async function getJson(path, cookie, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    headers: cookie ? { Cookie: cookie } : {},
  });
  const payload = await readJson(response, path, options);
  return { response, payload };
}

async function postJson(path, body, cookie, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: requestOrigin,
      ...(cookie ? { Cookie: cookie } : {}),
      ...(options.headers || {}),
    },
    body: JSON.stringify(body),
  });
  const payload = await readJson(response, path, options);
  return { response, payload };
}

async function fetchText(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`);
  const text = await response.text();
  if (!response.ok && !options.allowError) {
    throw new Error(`HTTP ${response.status} from ${path}: ${text.slice(0, 500)}`);
  }
  return { response, status: response.status, text };
}

async function readJson(response, path, options = {}) {
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid JSON from ${path}: ${error.message}\n${text.slice(0, 500)}`);
  }

  if (!response.ok && !options.allowError) {
    throw new Error(`HTTP ${response.status} from ${path}: ${JSON.stringify(payload)}`);
  }

  return payload;
}

function extractCookie(response) {
  const cookie = response.headers.get("set-cookie");
  if (!cookie) throw new Error("Missing set-cookie header");
  return cookie.split(";")[0];
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
