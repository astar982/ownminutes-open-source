#!/usr/bin/env node

const { readFileSync } = await import("node:fs");

const baseUrl = process.env.SMOKE_BASE_URL || "http://127.0.0.1:3003";
const browserOrigin = process.env.SMOKE_BROWSER_ORIGIN || baseUrl;
const timestamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
const email = `smoke-mobile-realtime-${timestamp}@ownminutes.local`;
const password = `OwnMinutes-${timestamp}`;
const secondEmail = `smoke-mobile-realtime-other-${timestamp}@ownminutes.local`;
const secondPassword = `OwnMinutes-Other-${timestamp}`;
const testIp = `198.51.${Math.floor(Math.random() * 200) + 1}.${Math.floor(Math.random() * 200) + 1}`;
const meetingId = `smoke-mobile-realtime-${timestamp}`;
const realtimeRouteSource = readFileSync("src/app/api/meetings/[id]/realtime-chunks/route.ts", "utf8");
const adapterSource = readFileSync("src/lib/transcription-adapter.ts", "utf8");

async function main() {
  const unauthenticated = await postRealtimeChunk(null, { allowError: true });
  const register = await postJson(
    "/api/auth/register",
    {
      name: "Mobile Realtime Smoke",
      email,
      password,
    },
    null,
    { "x-forwarded-for": testIp },
  );
  const cookie = extractCookie(register.response);
  const realtime = await postRealtimeChunk(cookie);
  const duplicateRealtime = await postRealtimeChunk(cookie);
  const outOfOrderRealtime = await postRealtimeChunk(cookie, { sequence: 3, allowError: true });
  const realtimeStatus = await getJson(`${baseUrl}/api/meetings/${meetingId}/realtime-chunks`, cookie);
  const secondRegister = await postJson(
    "/api/auth/register",
    { name: "Other Realtime User", email: secondEmail, password: secondPassword },
    null,
    { "x-forwarded-for": `203.0.113.${Math.floor(Math.random() * 200) + 1}` },
  );
  const secondCookie = extractCookie(secondRegister.response);
  const crossUserRealtime = await postRealtimeChunk(secondCookie, { sequence: 2, allowError: true });
  const secondDelete = await fetch(`${baseUrl}/api/auth/delete`, {
    method: "DELETE",
    headers: { Cookie: secondCookie, Origin: browserOrigin, "Sec-Fetch-Site": "same-origin" },
  });
  const saveProvider = await postJson(
    "/api/account/provider-credentials",
    {
      providerId: "volcano-asr",
      label: "Realtime ASR Smoke",
      fields: {
        VOLCANO_ASR_APP_ID: "realtime-smoke-app-id",
        VOLCANO_ASR_RESOURCE_ID: "volc.seedasr.auc",
        VOLCANO_REALTIME_ASR_RESOURCE_ID: "volc.seedasr.sauc.duration",
        VOLCANO_ASR_WS_URL: "wss://127.0.0.1:1/realtime-smoke",
      },
      secrets: {
        VOLCANO_ASR_API_KEY: "realtime-smoke-secret-api-key",
      },
    },
    cookie,
  );
  const configuredRealtime = await postRealtimeChunk(cookie, { sequence: 2 });
  const configuredRealtimeStatus = await getJson(`${baseUrl}/api/meetings/${meetingId}/realtime-chunks`, cookie);
  const finishedRealtime = await finishRealtimeSession(cookie);
  const finishedRealtimeStatus = await getJson(`${baseUrl}/api/meetings/${meetingId}/realtime-chunks`, cookie);
  const invalidRealtime = await postRealtimeChunk(cookie, { sequence: 3, durationMs: 1000, allowError: true });
  const rejectedRealtimeStatus = await getJson(`${baseUrl}/api/meetings/${meetingId}/realtime-chunks`, cookie);
  const meetingDetail = await fetch(`${baseUrl}/api/meetings/${meetingId}`, {
    headers: { Cookie: cookie },
  });
  const meetingPayload = await readJson(meetingDetail, `/api/meetings/${meetingId}`, { allowError: true });
  const deletionReceipt = await getJson(`${baseUrl}/api/auth/delete`, cookie);
  const deleteResult = await fetch(`${baseUrl}/api/auth/delete`, {
    method: "DELETE",
    headers: { Cookie: cookie, Origin: browserOrigin, "Sec-Fetch-Site": "same-origin" },
  });
  const deletePayload = await readJson(deleteResult, "/api/auth/delete", { allowError: true });
  const deletionStatus = await waitForDeletionStatus(deletionReceipt.ticket);
  const realtimeAfterDelete = await fetch(`${baseUrl}/api/meetings/${meetingId}/realtime-chunks`, {
    headers: { Cookie: cookie },
  });
  const initialProviderStatus = realtime.payload.providerStatus;
  const configuredProviderStatus = configuredRealtime.payload.providerStatus;
  const statusesMatch = initialProviderStatus === configuredProviderStatus;

  const summary = {
    unauthenticatedRejected: unauthenticated.response.status === 401 && unauthenticated.payload.ok === false,
    registerOk: register.payload.ok === true,
    realtimeOk: realtime.payload.ok === true,
    realtimeNotStoredForFinalization: realtime.payload.realtime?.storedForFinalization === false,
    realtimeProvider: realtime.payload.provider,
    realtimeAdapter: realtime.payload.adapter,
    realtimeProviderStatus: realtime.payload.providerStatus,
    realtimeSessionId: realtime.payload.realtimeSessionId,
    realtimeSessionTracked:
      realtime.payload.realtimeSession?.meetingId === meetingId &&
      realtime.payload.realtimeSession?.ownerUserId &&
      realtime.payload.realtimeSession?.chunkCount === 1 &&
      realtime.payload.realtimeSession?.totalBytes === 96000 &&
      realtime.payload.realtimeSession?.statusCounts?.[initialProviderStatus] === 1,
    duplicateRealtimeIgnored:
      duplicateRealtime.response.status === 200 &&
      duplicateRealtime.payload.ok === true &&
      duplicateRealtime.payload.duplicate === true &&
      duplicateRealtime.payload.expectedSequence === 2 &&
      duplicateRealtime.payload.realtimeSession?.chunkCount === 1 &&
      duplicateRealtime.payload.realtimeSession?.duplicateSequenceCount === 1,
    outOfOrderRealtimeRejected:
      outOfOrderRealtime.response.status === 409 &&
      outOfOrderRealtime.payload.ok === false &&
      outOfOrderRealtime.payload.providerStatus === "out_of_order" &&
      outOfOrderRealtime.payload.expectedSequence === 2 &&
      outOfOrderRealtime.payload.realtimeSession?.chunkCount === 1 &&
      outOfOrderRealtime.payload.realtimeSession?.outOfOrderCount === 1,
    crossUserRealtimeRejected:
      secondRegister.payload.ok === true &&
      crossUserRealtime.response.status === 403 &&
      crossUserRealtime.payload.ok === false &&
      secondDelete.ok,
    realtimeStatusReadable:
      realtimeStatus.ok === true &&
      realtimeStatus.realtimeSession?.meetingId === meetingId &&
      realtimeStatus.realtimeSession?.chunkCount === 1 &&
      realtimeStatus.realtimeSession?.totalBytes === 96000 &&
      realtimeStatus.realtimeSession?.duplicateSequenceCount === 1 &&
      realtimeStatus.realtimeSession?.outOfOrderCount === 1,
    realtimeFormatOk: realtime.payload.realtime?.formatOk,
    realtimeExpectedBytes: realtime.payload.realtime?.expectedBytes,
    realtimeByteDrift: realtime.payload.realtime?.byteDrift,
    realtimeReceivedBytes: realtime.payload.receivedBytes,
    saveProviderOk: saveProvider.payload.ok === true,
    configuredRealtimeOk: configuredRealtime.payload.ok === true,
    configuredRealtimeProviderStatus: configuredRealtime.payload.providerStatus,
    configuredRealtimeBehaviorValid:
      (realtime.payload.provider === "mock" && ["accepted", "draft"].includes(configuredProviderStatus)) ||
      (realtime.payload.provider === "volcano" && ["not_configured", "provider_error"].includes(configuredProviderStatus)),
    configuredRealtimeCreatesProviderSession: configuredRealtime.payload.realtimeSessionId?.startsWith(`rt-${meetingId}`),
    configuredRealtimeSessionTracked:
      configuredRealtime.payload.realtimeSession?.chunkCount === 2 &&
      configuredRealtime.payload.realtimeSession?.highestSequence === 2 &&
      configuredRealtime.payload.realtimeSession?.duplicateSequenceCount === 1 &&
      configuredRealtime.payload.realtimeSession?.outOfOrderCount === 1 &&
      configuredRealtime.payload.realtimeSession?.statusCounts?.[initialProviderStatus] === (statusesMatch ? 2 : 1) &&
      configuredRealtime.payload.realtimeSession?.statusCounts?.[configuredProviderStatus] === (statusesMatch ? 2 : 1),
    configuredRealtimeStatusReadable:
      configuredRealtimeStatus.ok === true &&
      configuredRealtimeStatus.realtimeSession?.chunkCount === 2 &&
      configuredRealtimeStatus.realtimeSession?.totalBytes === 192000 &&
      configuredRealtimeStatus.realtimeSession?.lastProviderStatus === configuredProviderStatus,
    configuredRealtimeKeepsAudioSaved:
      configuredRealtime.payload.realtime?.storedForFinalization === false &&
      configuredRealtime.payload.realtime?.formatOk === true &&
      configuredRealtime.payload.receivedBytes === 96000,
    realtimeFinishOk: finishedRealtime.response.status === 200 && finishedRealtime.payload.providerStatus === "completed",
    realtimeFinishDoesNotStoreAudio: finishedRealtime.payload.realtime?.storedForFinalization === false,
    realtimeFinishTracked:
      finishedRealtimeStatus.ok === true &&
      finishedRealtimeStatus.realtimeSession?.chunkCount === 2 &&
      finishedRealtimeStatus.realtimeSession?.lastProviderStatus === "completed" &&
      finishedRealtimeStatus.realtimeSession?.statusCounts?.completed === 1,
    invalidRealtimeRejected: invalidRealtime.response.status === 422 && invalidRealtime.payload.ok === false,
    invalidRealtimeFormatFlag: invalidRealtime.payload.realtime?.formatOk === false,
    invalidRealtimeTracked:
      invalidRealtime.payload.providerStatus === "rejected_format" &&
      invalidRealtime.payload.realtime?.storedForFinalization === false &&
      invalidRealtime.payload.realtime?.byteDrift === 64000 &&
      invalidRealtime.payload.realtimeSession?.rejectedChunkCount === 1 &&
      invalidRealtime.payload.realtimeSession?.formatMismatchCount === 1 &&
      invalidRealtime.payload.realtimeSession?.statusCounts?.rejected_format === 1,
    rejectedRealtimeStatusReadable:
      rejectedRealtimeStatus.ok === true &&
      rejectedRealtimeStatus.realtimeSession?.chunkCount === 3 &&
      rejectedRealtimeStatus.realtimeSession?.acceptedChunkCount === 2 &&
      rejectedRealtimeStatus.realtimeSession?.rejectedChunkCount === 1 &&
      rejectedRealtimeStatus.realtimeSession?.formatMismatchCount === 1 &&
      rejectedRealtimeStatus.realtimeSession?.maxAbsByteDrift === 64000 &&
      rejectedRealtimeStatus.realtimeSession?.lastProviderStatus === "rejected_format",
    noFormalMeetingManifestCreated: meetingDetail.status === 404 || meetingPayload.error === "meeting_not_found",
    routeLoadsUserProviderRuntime:
      realtimeRouteSource.includes('getProviderRuntimeConfig(user.id, "volcano-asr")') &&
      realtimeRouteSource.includes("providerRuntime"),
    routeExposesRealtimeSessionStatus:
      realtimeRouteSource.includes("recordRealtimeSessionChunk") &&
      realtimeRouteSource.includes("readUserRealtimeSession") &&
      realtimeRouteSource.includes("export async function GET") &&
      realtimeRouteSource.includes("export async function DELETE") &&
      realtimeRouteSource.includes("finishVolcanoRealtimeSession") &&
      realtimeRouteSource.includes("withRealtimeSessionLock") &&
      realtimeRouteSource.includes("classifyRealtimeSequence") &&
      realtimeRouteSource.includes("recordRealtimeSequenceAnomaly") &&
      realtimeRouteSource.includes('providerStatus: "rejected_format"') &&
      realtimeRouteSource.includes('adapter: "realtime-pcm-validator"'),
    adapterAcceptsUserProviderRuntime:
      adapterSource.includes("providerRuntime?: ProviderRuntimeConfig | null") &&
      adapterSource.includes("Realtime adapter is using the current user's encrypted Volcano ASR BYOK runtime config.") &&
      adapterSource.includes("transcribeWithVolcanoRealtime"),
    mockTranscriptTimestampUsesAudioDuration:
      configuredRealtime.payload.transcriptSegment?.timestamp === "00:03" &&
      adapterSource.includes("formatChunkTimestamp(input.sequence, input.durationMs)"),
    accountDeleteCleansRealtimeOnlySession:
      deletionStatus === "deleted" &&
      realtimeAfterDelete.status === 401,
    accountDeleteResponseMinimizesIdentifiers:
      deletePayload.ok === true &&
      ((deletePayload.status === "pending_cleanup" && deleteResult.status === 202) ||
        (deletePayload.status === "deleted" && deleteResult.status === 200)) &&
      !("deletedMeetingIds" in deletePayload) &&
      !("deletedMeetings" in deletePayload) &&
      !JSON.stringify(deletePayload).includes(meetingId),
    deleteOk: deletePayload.ok === true,
    leaksSecrets: JSON.stringify(realtime.payload).includes("AKL") || JSON.stringify(realtime.payload).includes("Secret Access Key") || JSON.stringify(realtime.payload).includes("sk-proj"),
    configuredResponseLeaksSecrets:
      JSON.stringify(configuredRealtime.payload).includes("realtime-smoke-secret-api-key") ||
      JSON.stringify(configuredRealtime.payload).includes("AKL") ||
      JSON.stringify(configuredRealtime.payload).includes("Secret Access Key") ||
      JSON.stringify(configuredRealtime.payload).includes("sk-proj"),
    realtimeStatusLeaksSecrets:
      JSON.stringify(configuredRealtimeStatus).includes("realtime-smoke-secret-api-key") ||
      JSON.stringify(rejectedRealtimeStatus).includes("realtime-smoke-secret-api-key") ||
      JSON.stringify(configuredRealtimeStatus).includes("AKL") ||
      JSON.stringify(rejectedRealtimeStatus).includes("AKL") ||
      JSON.stringify(configuredRealtimeStatus).includes("Secret Access Key") ||
      JSON.stringify(rejectedRealtimeStatus).includes("Secret Access Key") ||
      JSON.stringify(configuredRealtimeStatus).includes("sk-proj"),
  };

  console.log(JSON.stringify(summary, null, 2));

  if (
    !summary.unauthenticatedRejected ||
    !summary.registerOk ||
    !summary.realtimeOk ||
    !summary.realtimeNotStoredForFinalization ||
    !summary.realtimeAdapter ||
    !summary.realtimeProviderStatus ||
    !summary.realtimeSessionId ||
    !summary.realtimeSessionTracked ||
    !summary.duplicateRealtimeIgnored ||
    !summary.outOfOrderRealtimeRejected ||
    !summary.crossUserRealtimeRejected ||
    !summary.realtimeStatusReadable ||
    !summary.realtimeFormatOk ||
    summary.realtimeExpectedBytes !== 96000 ||
    summary.realtimeByteDrift !== 0 ||
    summary.realtimeReceivedBytes !== 96000 ||
    !summary.saveProviderOk ||
    !summary.configuredRealtimeOk ||
    !summary.configuredRealtimeBehaviorValid ||
    !summary.configuredRealtimeCreatesProviderSession ||
    !summary.configuredRealtimeSessionTracked ||
    !summary.configuredRealtimeStatusReadable ||
    !summary.configuredRealtimeKeepsAudioSaved ||
    !summary.realtimeFinishOk ||
    !summary.realtimeFinishDoesNotStoreAudio ||
    !summary.realtimeFinishTracked ||
    !summary.invalidRealtimeRejected ||
    !summary.invalidRealtimeFormatFlag ||
    !summary.invalidRealtimeTracked ||
    !summary.rejectedRealtimeStatusReadable ||
    !summary.noFormalMeetingManifestCreated ||
    !summary.routeLoadsUserProviderRuntime ||
    !summary.routeExposesRealtimeSessionStatus ||
    !summary.adapterAcceptsUserProviderRuntime ||
    !summary.mockTranscriptTimestampUsesAudioDuration ||
    !summary.accountDeleteCleansRealtimeOnlySession ||
    !summary.accountDeleteResponseMinimizesIdentifiers ||
    !summary.deleteOk ||
    summary.leaksSecrets ||
    summary.configuredResponseLeaksSecrets ||
    summary.realtimeStatusLeaksSecrets
  ) {
    process.exitCode = 1;
  }
}

async function waitForDeletionStatus(ticket) {
  if (typeof ticket !== "string" || !ticket) throw new Error("Missing signed account deletion receipt.");
  const startedAt = Date.now();
  let lastStatus = "unknown";
  while (Date.now() - startedAt < 30_000) {
    const result = await postJson("/api/auth/delete", { ticket }, null);
    lastStatus = String(result.payload.status || "unknown");
    if (lastStatus === "deleted") return lastStatus;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Account deletion did not reach deleted; last status was ${lastStatus}.`);
}

async function finishRealtimeSession(cookie) {
  const response = await fetch(`${baseUrl}/api/meetings/${meetingId}/realtime-chunks`, {
    method: "DELETE",
    headers: { Cookie: cookie, Origin: browserOrigin, "Sec-Fetch-Site": "same-origin" },
  });
  const payload = await readJson(response, `/api/meetings/${meetingId}/realtime-chunks`, { allowError: true });
  return { response, payload };
}

async function postRealtimeChunk(cookie, options = {}) {
  const formData = new FormData();
  const pcm = new Uint8Array(96000);
  formData.append("sequence", String(options.sequence ?? 1));
  formData.append("mimeType", "audio/pcm;encoding=signed-integer;bits=16");
  formData.append("recordedAt", String(Date.now()));
  formData.append("durationMs", String(options.durationMs ?? 3000));
  formData.append("sampleRate", "16000");
  formData.append("channels", "1");
  formData.append("chunk", new Blob([pcm], { type: "audio/pcm" }), `realtime-${String(options.sequence ?? 1).padStart(6, "0")}.pcm`);

  const response = await fetch(`${baseUrl}/api/meetings/${meetingId}/realtime-chunks`, {
    method: "POST",
    headers: cookie
      ? { Cookie: cookie, Origin: browserOrigin, "Sec-Fetch-Site": "same-origin" }
      : { Origin: browserOrigin, "Sec-Fetch-Site": "same-origin" },
    body: formData,
  });
  const payload = await readJson(response, `/api/meetings/${meetingId}/realtime-chunks`, options);
  return { response, payload };
}

async function postJson(path, body, cookie, extraHeaders = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Origin: browserOrigin,
      "Sec-Fetch-Site": "same-origin",
      ...(cookie ? { Cookie: cookie } : {}),
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });
  const payload = await readJson(response, path);
  return { response, payload };
}

async function getJson(url, cookie) {
  const response = await fetch(url, {
    headers: cookie ? { Cookie: cookie } : undefined,
  });
  return readJson(response, url);
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
