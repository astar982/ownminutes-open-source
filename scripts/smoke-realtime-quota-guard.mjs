#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const baseUrl = process.env.SMOKE_BASE_URL || "http://127.0.0.1:3003";
const stamp = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
const email = `realtime-quota-${stamp}@ownminutes.local`;
const password = `OwnMinutes-${stamp}`;
const meetingId = `realtime-quota-${stamp}`;
const storePath = path.join(process.env.OWNMINUTES_AUTH_DATA_DIR || path.join(process.cwd(), ".data", "auth"), "store.json");

const register = await json("/api/auth/register", {
  method: "POST",
  body: { name: "Realtime Quota Guard", email, password },
  headers: { "x-forwarded-for": `198.51.100.${Math.floor(Math.random() * 200) + 1}` },
});
const cookie = register.response.headers.get("set-cookie")?.split(";")[0];
if (!cookie) throw new Error("Registration did not return a session cookie.");

const store = JSON.parse(fs.readFileSync(storePath, "utf8"));
const user = store.users.find((item) => item.email === email);
if (!user) throw new Error("Registered test user was not found in the isolated local store.");
user.officialMinutesTotal = 1;
user.officialMinutesUsed = 1;
user.freeTrialMinutesTotal = 1;
user.freeTrialMinutesUsed = 1;
fs.writeFileSync(storePath, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });

const first = await postChunk(1, cookie);
const second = await postChunk(2, cookie);
const usage = await json("/api/account/usage", { cookie });
await json("/api/auth/delete", { method: "DELETE", cookie, allowError: true });

const summary = {
  build7ReceivesSoftSuccess:
    first.response.status === 200 &&
    first.payload.ok === true &&
    first.payload.code === "official_quota_insufficient" &&
    first.payload.providerStatus === "provider_error",
  providerSpendIsStopped: first.payload.adapter === "official-quota-exhausted",
  followingChunksStayCostFree:
    second.response.status === 200 &&
    second.payload.ok === true &&
    second.payload.adapter === "official-quota-exhausted" &&
    second.payload.expectedSequence === 3,
  sessionSequenceContinues: second.payload.realtimeSession?.highestSequence === 2,
  quotaDoesNotGoNegative:
    usage.payload.usage?.officialMinutesUsed === 1 && usage.payload.usage?.officialMinutesRemaining === 0,
  diagnosticPreservesLocalRecording: /本地完整录音继续保存/.test(first.payload.diagnostic || ""),
  noSecrets: !/AKL|sk-proj|X-Api-Key/.test(JSON.stringify({ first: first.payload, second: second.payload })),
};

console.log(JSON.stringify({ ok: Object.values(summary).every(Boolean), checks: summary }, null, 2));
if (Object.values(summary).some((value) => value !== true)) process.exitCode = 1;

async function postChunk(sequence, cookieValue) {
  const durationMs = 3000;
  const sampleRate = 16000;
  const channels = 1;
  const bytes = Buffer.alloc(sampleRate * channels * 2 * (durationMs / 1000));
  const response = await fetch(`${baseUrl}/api/meetings/${meetingId}/realtime-chunks`, {
    method: "POST",
    headers: {
      Cookie: cookieValue,
      "Content-Type": "audio/pcm",
      "X-OwnMinutes-Sequence": String(sequence),
      "X-OwnMinutes-Duration-Ms": String(durationMs),
      "X-OwnMinutes-Sample-Rate": String(sampleRate),
      "X-OwnMinutes-Channels": String(channels),
      "X-OwnMinutes-Recorded-At": String(Date.now()),
    },
    body: bytes,
  });
  return { response, payload: await response.json() };
}

async function json(route, options = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    method: options.method || "GET",
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      ...(options.cookie ? { Cookie: options.cookie } : {}),
      ...(options.headers || {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const payload = await response.json();
  if (!response.ok && !options.allowError) throw new Error(`${route} failed: ${response.status}`);
  return { response, payload };
}
