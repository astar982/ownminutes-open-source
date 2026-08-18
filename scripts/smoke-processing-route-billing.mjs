#!/usr/bin/env node

import { buildSilentWav } from "./lib/audio-fixtures.mjs";
import { createServer } from "node:http";
import { randomInt, randomUUID } from "node:crypto";

const baseUrl = process.env.SMOKE_BASE_URL || "http://127.0.0.1:3003";
const browserOrigin = process.env.SMOKE_BROWSER_ORIGIN || baseUrl;
const stamp = `${Date.now()}-${randomUUID().slice(0, 8)}`;
const email = `route-billing-${stamp}@ownminutes.local`;
const password = `OwnMinutes-${stamp}`;
const arkProbeServer = createServer((request, response) => {
  if (request.method === "POST" && request.url === "/asr/submit") {
    response.writeHead(200, { "Content-Type": "application/json", "X-Api-Status-Code": "20000000", "X-Api-Message": "OK" });
    response.end(JSON.stringify({ result: {} }));
    return;
  }
  if (request.method === "POST" && request.url === "/chat/completions") {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
    return;
  }
  response.writeHead(404).end();
});
await new Promise((resolve) => arkProbeServer.listen(0, "127.0.0.1", resolve));
const arkProbeAddress = arkProbeServer.address();
if (!arkProbeAddress || typeof arkProbeAddress === "string") throw new Error("Could not start the local Ark health probe fixture.");
const arkProbeBaseUrl = `http://127.0.0.1:${arkProbeAddress.port}`;

const register = await json("/api/auth/register", {
  method: "POST",
  body: { name: "Route Billing Smoke", email, password },
  headers: { "x-forwarded-for": `198.51.100.${randomInt(1, 201)}` },
});
const cookie = register.response.headers.get("set-cookie")?.split(";")[0];
if (!cookie) throw new Error("Registration did not return a session cookie.");

const official = await finalizeFixture("official", cookie, undefined, "official_quota");
await saveProvider(cookie, {
  providerId: "volcano-asr",
  label: "Route ASR",
  fields: {
    VOLCANO_ASR_MODE: "standard",
    VOLCANO_ASR_RESOURCE_ID: "volc.bigasr.auc_turbo",
    VOLCANO_ASR_SUBMIT_URL: `${arkProbeBaseUrl}/asr/submit`,
  },
  secrets: { VOLCANO_ASR_API_KEY: "route-asr-key" },
});
const partialStillOfficial = await finalizeFixture("partial-still-official", cookie, undefined, "official_quota");
await saveProvider(cookie, {
  providerId: "volcano-ark",
  label: "Route Ark",
  fields: { ARK_CHAT_MODEL: "ep-route-smoke", ARK_BASE_URL: arkProbeBaseUrl },
  secrets: { ARK_API_KEY: "route-ark-key" },
});
const byokSelection = await json("/api/account/processing-mode", {
  method: "PUT",
  cookie,
  body: { processingMode: "byok" },
  allowError: true,
});
if (!byokSelection.response.ok) {
  const health = await json("/api/account/provider-health?live=1", { cookie, allowError: true });
  throw new Error(`BYOK selection failed: ${JSON.stringify({ selection: byokSelection.payload, health: health.payload })}`);
}
const officialForceOperationId = `reprocess-official-${stamp}`;
const officialForceAfterAccountByok = await refinalizeFixture(
  official,
  cookie,
  officialForceOperationId,
  "official_quota",
);
const frozenByokMeetingId = `route-byok-frozen-${stamp}`;
const frozenRealtime = await postRealtimeChunk(frozenByokMeetingId, cookie, "byok");
const switchAfterMeetingStart = await json("/api/account/processing-mode", {
  method: "PUT",
  cookie,
  body: { processingMode: "official_quota" },
});
const byok = await finalizeFixture("byok-frozen", cookie, frozenByokMeetingId, "byok");
const conflictingRetry = await json(`/api/meetings/${frozenByokMeetingId}/finalize`, {
  method: "POST",
  cookie,
  allowError: true,
  body: { title: "Conflicting retry", processingMode: "official_quota", ...byok.seal },
});
const firstReprocessOperationId = `reprocess-first-${stamp}`;
const secondReprocessOperationId = `reprocess-second-${stamp}`;
const byokReprocess = await refinalizeFixture(byok, cookie, firstReprocessOperationId, "byok");
const duplicateByokReprocess = await refinalizeFixture(byok, cookie, firstReprocessOperationId, "byok");
await new Promise((resolve) => setTimeout(resolve, 5));
const secondByokReprocess = await refinalizeFixture(byok, cookie, secondReprocessOperationId, "byok");
await deleteProvider(cookie, "volcano-asr");
await deleteProvider(cookie, "volcano-ark");
const afterDeletion = await json("/api/auth/me", { cookie });
const usage = await json("/api/account/usage", { cookie });
const meetingEvents = usage.payload.usage?.events?.filter((event) => event.type === "meeting_finalize") ?? [];
const eventFor = (meetingId) => meetingEvents.find((event) => event.note.includes(`meeting:${meetingId}`));
const officialEvent = eventFor(official.meetingId);
const partialStillOfficialEvent = eventFor(partialStillOfficial.meetingId);
const officialMeetingEvents = meetingEvents.filter((event) => event.note.includes(`meeting:${official.meetingId}`));
const byokMeetingEvents = meetingEvents.filter((event) => event.note.includes(`meeting:${byok.meetingId}`));
const byokEvent = byokMeetingEvents.find((event) => event.processingRoute === "byok");
const mockProviderRuntime = [official, partialStillOfficial, officialForceAfterAccountByok, byok, byokReprocess]
  .every((fixture) => fixture.payload.result?.provider === "mock");
const expectedOfficialMinutesUsed = mockProviderRuntime ? 0 : 3;

const summary = {
  officialRouteRecorded: official.payload.result?.processingRoute === "official_quota",
  officialMinuteCharged:
    official.payload.result?.officialMinutesCharged === (mockProviderRuntime ? 0 : 1) &&
    officialEvent?.officialMinutesCharged === (mockProviderRuntime ? 0 : 1),
  partialConfigDoesNotCreateHybrid:
    partialStillOfficial.payload.result?.processingRoute === "official_quota" &&
    partialStillOfficialEvent?.processingRoute === "official_quota" &&
    partialStillOfficial.payload.result?.officialMinutesCharged === (mockProviderRuntime ? 0 : 1),
  explicitByokSelectionPersisted:
    byokSelection.payload.processingMode === "byok" && byokSelection.payload.user?.processingMode === "byok",
  meetingRouteFrozenAtStart:
    frozenRealtime.payload.ok === true &&
    switchAfterMeetingStart.payload.processingMode === "official_quota" &&
    byok.payload.result?.processingRoute === "byok",
  conflictingRetryRejectedWithoutFallback:
    conflictingRetry.response.status === 409 &&
    conflictingRetry.payload.code === "meeting_processing_mode_conflict" &&
    conflictingRetry.payload.retryable === false,
  byokRouteRecorded: byok.payload.result?.processingRoute === "byok",
  byokDoesNotConsumeOfficialMinutes: byok.payload.result?.officialMinutesCharged === 0 && byokEvent?.officialMinutesCharged === 0 && byokEvent?.minutes === 0,
  forceOfficialRemainsOfficialAfterAccountSwitchToByok:
    byokSelection.payload.processingMode === "byok" &&
    officialForceAfterAccountByok.payload.result?.processingRoute === "official_quota" &&
    officialMeetingEvents.length === 2 &&
    officialMeetingEvents.every((event) => event.processingRoute === "official_quota"),
  forceByokRemainsByokAfterAccountSwitchToOfficial:
    switchAfterMeetingStart.payload.processingMode === "official_quota" &&
    byokReprocess.payload.result?.processingRoute === "byok" &&
    secondByokReprocess.payload.result?.processingRoute === "byok" &&
    byokMeetingEvents.length === 3 &&
    byokMeetingEvents.every((event) => event.processingRoute === "byok" && event.officialMinutesCharged === 0),
  sameForceOperationRetryIsIdempotent:
    duplicateByokReprocess.payload.idempotent === true &&
    duplicateByokReprocess.payload.operationId === firstReprocessOperationId &&
    duplicateByokReprocess.payload.result?.generatedAt === byokReprocess.payload.result?.generatedAt &&
    duplicateByokReprocess.payload.result?.processingOperationKey === byokReprocess.payload.result?.processingOperationKey,
  consecutiveForceActionsGenerateFreshResults:
    byokReprocess.payload.idempotent === false &&
    secondByokReprocess.payload.idempotent === false &&
    byokReprocess.payload.operationId === firstReprocessOperationId &&
    secondByokReprocess.payload.operationId === secondReprocessOperationId &&
    byokReprocess.payload.result?.generatedAt !== secondByokReprocess.payload.result?.generatedAt &&
    byokReprocess.payload.result?.processingOperationKey?.endsWith(`:reprocess:${firstReprocessOperationId}`) &&
    secondByokReprocess.payload.result?.processingOperationKey?.endsWith(`:reprocess:${secondReprocessOperationId}`),
  processedMinutesPreserved: [officialEvent, partialStillOfficialEvent, byokEvent].every((event) => event?.processedMinutes === 1),
  officialUsageTotalCorrect:
    usage.payload.usage?.officialMinutesUsed === expectedOfficialMinutesUsed &&
    usage.payload.usage?.officialMinutesRemaining === 60 - expectedOfficialMinutesUsed,
  mockProviderNeverCreatesPhantomOfficialSpend: !mockProviderRuntime || expectedOfficialMinutesUsed === 0,
  providerDeletionReturnsToOfficialMode:
    afterDeletion.payload.user?.processingMode === "official_quota" &&
    usage.payload.usage?.costControl?.selectedMode === "official_quota" &&
    usage.payload.usage?.costControl?.mode === "official_quota",
  usageNotesExposeNoSecrets: !JSON.stringify(meetingEvents).includes("route-asr-key") && !JSON.stringify(meetingEvents).includes("route-ark-key"),
};

console.log(JSON.stringify(summary, null, 2));
if (Object.values(summary).some((value) => !value)) process.exitCode = 1;
await json("/api/auth/delete", { method: "DELETE", cookie, allowError: true });
await new Promise((resolve) => arkProbeServer.close(resolve));

async function finalizeFixture(label, cookieValue, existingMeetingId, processingMode) {
  const meetingId = existingMeetingId || `route-${label}-${stamp}`;
  const audio = new Blob([buildSilentWav()], { type: "audio/wav" });
  const form = new FormData();
  form.append("sequence", "1");
  form.append("mimeType", "audio/wav");
  form.append("recordedAt", String(Date.now()));
  form.append("durationMs", "1000");
  form.append("chunk", audio, `${label}.wav`);
  const uploadResponse = await fetch(`${baseUrl}/api/meetings/${meetingId}/chunks`, {
    method: "POST",
    headers: { Cookie: cookieValue, Origin: browserOrigin, "Sec-Fetch-Site": "same-origin" },
    body: form,
  });
  const upload = await uploadResponse.json();
  if (!uploadResponse.ok) throw new Error(`Upload ${label} failed: ${uploadResponse.status} ${JSON.stringify(upload)}`);
  const seal = {
    expectedLastSequence: upload.totalChunks,
    totalBytes: upload.totalBytes,
  };
  const finalized = await waitForFinalization(meetingId, cookieValue, {
    title: `Route ${label}`,
    processingMode,
    ...seal,
  });
  return { meetingId, payload: finalized.payload, seal };
}

async function postRealtimeChunk(meetingId, cookieValue, processingMode) {
  const durationMs = 1000;
  const sampleRate = 16000;
  const channels = 1;
  const response = await fetch(`${baseUrl}/api/meetings/${meetingId}/realtime-chunks`, {
    method: "POST",
    headers: {
      Cookie: cookieValue,
      Origin: browserOrigin,
      "Sec-Fetch-Site": "same-origin",
      "Content-Type": "audio/pcm",
      "X-OwnMinutes-Sequence": "1",
      "X-OwnMinutes-Duration-Ms": String(durationMs),
      "X-OwnMinutes-Sample-Rate": String(sampleRate),
      "X-OwnMinutes-Channels": String(channels),
      "X-OwnMinutes-Recorded-At": String(Date.now()),
      "X-OwnMinutes-Processing-Mode": processingMode,
    },
    body: Buffer.alloc(sampleRate * channels * 2),
  });
  return { response, payload: await response.json() };
}

async function refinalizeFixture(fixture, cookieValue, operationId, processingMode) {
  const finalized = await waitForFinalization(fixture.meetingId, cookieValue, {
    title: `Route forced ${processingMode}`,
    force: true,
    operationId,
    processingMode,
    ...fixture.seal,
  });
  return { meetingId: fixture.meetingId, payload: finalized.payload };
}

async function waitForFinalization(meetingId, cookieValue, body) {
  let finalized = await json(`/api/meetings/${meetingId}/finalize`, { method: "POST", cookie: cookieValue, body });
  if (!finalized.payload.result && (finalized.payload.queued || finalized.payload.processing?.status === "queued" || finalized.payload.processing?.status === "processing")) {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      finalized = await json(`/api/meetings/${meetingId}/finalize`, { cookie: cookieValue });
      if (finalized.payload.result && finalized.payload.processing?.status === "completed") break;
      if (finalized.payload.processing?.status === "failed") throw new Error(`Queued finalization failed: ${JSON.stringify(finalized.payload.processing.error)}`);
    }
  }
  if (!finalized.payload.result) throw new Error("Queued finalization timed out.");
  return finalized;
}

async function saveProvider(cookieValue, body) {
  return json("/api/account/provider-credentials", { method: "POST", cookie: cookieValue, body });
}

async function deleteProvider(cookieValue, providerId) {
  return json(`/api/account/provider-credentials?providerId=${encodeURIComponent(providerId)}`, { method: "DELETE", cookie: cookieValue });
}

async function json(path, options = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? "GET",
    headers: {
      ...(options.body ? { "Content-Type": "application/json" } : {}),
      Origin: browserOrigin,
      "Sec-Fetch-Site": "same-origin",
      ...(options.cookie ? { Cookie: options.cookie } : {}),
      ...(options.headers ?? {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const payload = await response.json();
  if (!response.ok && !options.allowError) throw new Error(`${path} failed: ${response.status} ${JSON.stringify(payload)}`);
  return { response, payload };
}
