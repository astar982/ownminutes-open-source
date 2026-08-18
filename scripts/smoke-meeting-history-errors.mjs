#!/usr/bin/env node

import { mkdir, rm, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

const baseUrl = process.env.SMOKE_BASE_URL || "http://127.0.0.1:3003";
const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const email = `meeting-history-errors-${suffix}@ownminutes.local`;
const password = `OwnMinutes-${suffix}`;
const meetingId = `meeting-history-errors-${suffix}`;
const meetingDirectory = path.join(process.cwd(), ".data", "meetings", meetingId);
const testIp = `198.51.100.${Math.floor(Math.random() * 200) + 20}`;
let cookie = "";

try {
  const unauthorized = await fetch(`${baseUrl}/api/meetings`, { cache: "no-store" });
  const unauthorizedPayload = await readJson(unauthorized);

  const registration = await fetch(`${baseUrl}/api/auth/register`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-forwarded-for": testIp,
    },
    body: JSON.stringify({ name: "Meeting History Error Smoke", email, password }),
  });
  const registrationPayload = await readJson(registration);
  cookie = extractCookie(registration);
  const ownerUserId = registrationPayload.user?.id;
  if (!registration.ok || !registrationPayload.ok || !cookie || !ownerUserId) {
    throw new Error(`Fixture registration failed with HTTP ${registration.status}.`);
  }

  await mkdir(meetingDirectory, { recursive: true });
  await writeFile(
    path.join(meetingDirectory, "manifest.json"),
    `${JSON.stringify({
      meetingId,
      ownerUserId,
      metadata: { participants: [], tags: [], title: "Failure fixture" },
      share: { visibility: "private", includeTranscript: false },
      shareAnalytics: { viewCount: 0 },
      chunks: [
        {
          sequence: 1,
          fileName: "chunk-000001.wav",
          bytes: 1,
          mimeType: "audio/wav",
          recordedAt: Date.now(),
          durationMs: 1,
          receivedAt: new Date().toISOString(),
        },
      ],
      totalBytes: 1,
      updatedAt: new Date().toISOString(),
    })}\n`,
  );

  await writeFile(
    path.join(meetingDirectory, "result.json"),
    "ENOENT",
  );
  const corruptResult = await fetch(`${baseUrl}/api/meetings`, {
    headers: { Cookie: cookie },
    cache: "no-store",
  });
  const corruptResultText = await corruptResult.text();
  const corruptResultPayload = JSON.parse(corruptResultText);

  await unlink(path.join(meetingDirectory, "result.json"));
  await writeFile(
    path.join(meetingDirectory, "processing.json"),
    "not-json /Users/private/processing X-Amz-Credential=fixture-secret",
  );
  const corruptProcessing = await fetch(`${baseUrl}/api/meetings`, {
    headers: { Cookie: cookie },
    cache: "no-store",
  });
  const corruptProcessingText = await corruptProcessing.text();
  const corruptProcessingPayload = JSON.parse(corruptProcessingText);

  await rm(meetingDirectory, { force: true, recursive: true });
  const recovered = await fetch(`${baseUrl}/api/meetings`, {
    headers: { Cookie: cookie },
    cache: "no-store",
  });
  const recoveredPayload = await readJson(recovered);

  const summary = {
    unauthorizedSemanticsPreserved: unauthorized.status === 401 && unauthorizedPayload.ok === false,
    enoentJsonResultReturnsStructured503: isSafeTemporaryFailure(corruptResult, corruptResultPayload, corruptResultText),
    corruptProcessingReturnsStructured503: isSafeTemporaryFailure(corruptProcessing, corruptProcessingPayload, corruptProcessingText),
    healthyHistoryRecovers: recovered.status === 200 && recoveredPayload.ok === true && Array.isArray(recoveredPayload.meetings),
  };

  console.log(JSON.stringify(summary, null, 2));
  if (Object.values(summary).some((value) => value !== true)) process.exitCode = 1;
} finally {
  await rm(meetingDirectory, { force: true, recursive: true });
  if (cookie) {
    await fetch(`${baseUrl}/api/auth/delete`, {
      method: "DELETE",
      headers: { Cookie: cookie },
    }).catch(() => undefined);
  }
}

function isSafeTemporaryFailure(response, payload, text) {
  return (
    response.status === 503 &&
    response.headers.get("content-type")?.includes("application/json") === true &&
    response.headers.get("cache-control") === "no-store" &&
    response.headers.get("retry-after") === "30" &&
    payload.ok === false &&
    payload.code === "meeting_history_unavailable" &&
    payload.retryable === true &&
    !text.match(/postgres(?:ql)?:\/\/|password|secret|token|\/var\/|\/Users\/|X-Amz|https?:\/\//i)
  );
}

async function readJson(response) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Expected JSON from HTTP ${response.status}.`);
  }
}

function extractCookie(response) {
  return response.headers.get("set-cookie")?.split(";")[0] || "";
}
