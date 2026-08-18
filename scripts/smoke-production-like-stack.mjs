#!/usr/bin/env node

import { buildSilentWav } from "./lib/audio-fixtures.mjs";

const baseUrl = process.env.SMOKE_BASE_URL || "http://127.0.0.1:3200";
const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
const meetingId = `smoke-production-stack-${timestamp}`;
const email = `production-stack-${timestamp}@ownminutes.local`;
const password = `OwnMinutes-${timestamp}`;
const testIp = `198.51.${Math.floor(Math.random() * 200) + 1}.${Math.floor(Math.random() * 200) + 1}`;

await main();

async function main() {
  let cookie = "";
  let accountDeleted = false;

  try {
    const register = await requestJson(`${baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "Production Stack Smoke", email, password }),
    });
    cookie = extractCookie(register.response);

    const audio = new Blob([buildSilentWav(16_000, 1)], {
      type: "audio/wav",
    });
    const form = new FormData();
    form.append("sequence", "1");
    form.append("mimeType", "audio/wav");
    form.append("recordedAt", String(Date.now()));
    form.append("durationMs", "1000");
    form.append("chunk", audio, "chunk-000001.wav");

    const upload = await requestJson(`${baseUrl}/api/meetings/${meetingId}/chunks`, {
      method: "POST",
      headers: { Cookie: cookie },
      body: form,
    });
    const finalize = await requestJson(`${baseUrl}/api/meetings/${meetingId}/finalize`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "OwnMinutes 生产化闭环烟测",
        expectedLastSequence: upload.payload.totalChunks,
        totalBytes: upload.payload.totalBytes,
      }),
      acceptedStatuses: [202],
    });
    const completed = await waitForFinalization(cookie);
    const detail = await requestJson(`${baseUrl}/api/meetings/${meetingId}`, {
      headers: { Cookie: cookie },
    });
    const review = await requestJson(`${baseUrl}/api/meetings/${meetingId}/review`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ confirmed: true }),
    });
    const publish = await requestJson(`${baseUrl}/api/meetings/${meetingId}/share`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ visibility: "public", includeTranscript: false, confirmUnverified: true }),
    });
    const publicShare = await fetch(`${baseUrl}/share/${meetingId}`);
    const publicMarkdown = await fetch(`${baseUrl}/api/share/${meetingId}/markdown`);
    const revoke = await requestJson(`${baseUrl}/api/meetings/${meetingId}/share`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ visibility: "private", includeTranscript: false }),
    });
    const revokedShare = await fetch(`${baseUrl}/share/${meetingId}`);
    const revokedShareText = await revokedShare.text();
    const deleteMeeting = await requestJson(`${baseUrl}/api/meetings/${meetingId}`, {
      method: "DELETE",
      headers: { Cookie: cookie },
    });
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
    const invalidatedSession = await requestJson(`${baseUrl}/api/auth/me`, {
      headers: { Cookie: cookie },
      acceptedStatuses: [401],
    });

    const result = completed.payload.result;
    const summary = {
      ok: true,
      baseUrl,
      checks: {
        registered: register.payload.ok === true && Boolean(cookie),
        audioStoredRemotely: upload.payload.ok === true && upload.payload.savedBytes > 0,
        finalizationQueued: finalize.payload.queued === true && Boolean(finalize.payload.job?.id),
        workerCompleted: completed.payload.processing?.status === "completed",
        isolatedMockProvider: result?.provider === "mock" && result?.adapter === "mock-file-transcriber",
        resultStoredRemotely: result?.meetingId === meetingId && Array.isArray(result?.transcript),
        meetingReadable: detail.payload.meeting?.meetingId === meetingId,
        reviewConfirmed: review.payload.ok === true && review.payload.humanReview?.status === "confirmed",
        publicSharePublished: publish.payload.ok === true && publicShare.status === 200,
        publicMarkdownPublished: publicMarkdown.status === 200,
        shareRevoked: revoke.payload.ok === true && revokedShareText.includes("尚未公开"),
        meetingDeleted: deleteMeeting.payload.ok === true,
        accountInvalidatedImmediately:
          accountDeleted &&
          invalidatedSession.response.status === 401,
        accountCleanupCompleted: deletionStatus.payload.status === "deleted",
      },
      provider: result?.provider,
      adapter: result?.adapter,
      processing: completed.payload.processing?.status,
      boundary: "The isolated stack explicitly uses the mock provider so queue, PostgreSQL, and object-storage orchestration never depend on production model credentials.",
    };
    summary.ok = Object.values(summary.checks).every(Boolean);
    console.log(JSON.stringify(summary, null, 2));
    if (!summary.ok) process.exitCode = 1;
  } finally {
    if (cookie && !accountDeleted) {
      await requestJson(`${baseUrl}/api/auth/delete`, {
        method: "DELETE",
        headers: { Cookie: cookie },
      }).catch(() => undefined);
    }
  }
}

async function waitForFinalization(cookie) {
  const deadline = Date.now() + 30_000;
  let latest = null;

  while (Date.now() < deadline) {
    latest = await requestJson(`${baseUrl}/api/meetings/${meetingId}/finalize`, {
      headers: { Cookie: cookie },
    });
    const status = latest.payload.processing?.status;
    if (status === "completed" && latest.payload.result) return latest;
    if (status === "failed") {
      throw new Error(`Finalization worker failed: ${JSON.stringify(latest.payload.processing?.error || {})}`);
    }
    await sleep(300);
  }

  throw new Error(`Finalization did not complete within 30 seconds: ${JSON.stringify(latest?.payload || {})}`);
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
      throw new Error("Account deletion status unexpectedly returned active.");
    }
    await sleep(300);
  }

  throw new Error(`Account deletion did not complete within 30 seconds: ${JSON.stringify(latest?.payload || {})}`);
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
    payload = { raw: text };
  }
  if (!acceptedStatuses.includes(response.status)) {
    throw new Error(`HTTP ${response.status} from ${url}: ${JSON.stringify(payload)}`);
  }
  return { payload, response };
}

function extractCookie(response) {
  const value = response.headers.get("set-cookie") || "";
  return value.split(";")[0];
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
