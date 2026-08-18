#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { createServer } from "node:http";

process.env.OWNMINUTES_ALLOW_LOCAL_PROVIDER_ENDPOINTS = "1";

const { isRetryableVolcanoFlashResponse, resolveVolcanoRuntimeEndpoint, transcribeWithVolcanoFileAsr, volcanoFlashRetryDelayMs } = await import(
  "../src/lib/volcano-asr.ts"
);
const { isProviderAccessibleAsrAudioUrl } = await import("../src/lib/asr-audio-url.ts");
const asrSource = readFileSync("src/lib/volcano-asr.ts", "utf8");
const processingSource = readFileSync("src/lib/meeting-processing.ts", "utf8");
const contentCopySource = readFileSync("src/lib/meeting-content-locale.ts", "utf8");
const finalizerSource = readFileSync("src/lib/server/meeting-finalizer.ts", "utf8");
const audioStoreSource = readFileSync("src/lib/server/meeting-audio-store.ts", "utf8");
const objectStoreSource = readFileSync("src/lib/server/meeting-object-store.ts", "utf8");
let mode = "retry";
let requestCount = 0;
const receivedBodies = [];
const server = createServer((request, response) => {
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => {
    requestCount += 1;
    receivedBodies.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    response.setHeader("content-type", "application/json");
    if ((mode === "retry" && requestCount < 3) || mode === "exhausted") {
      response.setHeader("x-api-status-code", "45000000");
      response.end(JSON.stringify({ message: "synthetic transient response" }));
      return;
    }
    if (mode === "no-speech") {
      response.setHeader("x-api-status-code", "20000003");
      response.end(JSON.stringify({ result: {} }));
      return;
    }
    response.setHeader("x-api-status-code", "20000000");
    response.end(JSON.stringify({ result: { utterances: [{ start_time: 0, speaker_id: 1, text: "重试后识别成功。" }] } }));
  });
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("ASR resilience fixture server did not bind.");
const recognizeUrl = `http://127.0.0.1:${address.port}/recognize`;
const baseInput = {
  buffer: buildSilentWav(16_000, 1),
  config: { apiKey: "fixture-key", mode: "flash", recognizeUrl, resourceId: "fixture-resource" },
  durationMs: 1000,
  fileName: "fixture.wav",
  meetingId: "asr-resilience-fixture",
  mimeType: "audio/wav",
};

process.env.VOLCANO_ASR_FLASH_RETRY_MS = "100";
let retryResult;
let noSpeechResult;
let exhaustedError = "";
let exhaustedRequestCount = 0;
let urlResult;
let unsafeUrlRejected = false;
let ambiguousSourceRejected = false;
try {
  retryResult = await transcribeWithVolcanoFileAsr(baseInput);
  mode = "no-speech";
  requestCount = 0;
  noSpeechResult = await transcribeWithVolcanoFileAsr({ ...baseInput, meetingId: "asr-no-speech-fixture" });
  mode = "exhausted";
  requestCount = 0;
  try {
    await transcribeWithVolcanoFileAsr({ ...baseInput, meetingId: "asr-exhausted-fixture" });
  } catch (error) {
    exhaustedError = error instanceof Error ? error.message : String(error);
  }
  exhaustedRequestCount = requestCount;
  mode = "url";
  requestCount = 0;
  urlResult = await transcribeWithVolcanoFileAsr({
    ...baseInput,
    buffer: undefined,
    audioUrl: "https://private.example.test/meeting.ogg?X-Amz-Signature=fixture",
    fileName: "meeting.ogg",
    mimeType: "audio/ogg",
    meetingId: "asr-private-url-fixture",
    transcoded: true,
  });
  try {
    await transcribeWithVolcanoFileAsr({
      ...baseInput,
      buffer: undefined,
      audioUrl: "http://public.example.test/meeting.ogg",
    });
  } catch {
    unsafeUrlRejected = true;
  }
  try {
    await transcribeWithVolcanoFileAsr({
      ...baseInput,
      audioUrl: "https://private.example.test/meeting.ogg",
    });
  } catch {
    ambiguousSourceRejected = true;
  }
} finally {
  await new Promise((resolve) => server.close(resolve));
  delete process.env.VOLCANO_ASR_FLASH_RETRY_MS;
}

const costRouter = await runCostRouterFixtures();

const checks = {
  retriesThroughRealAdapter:
    retryResult.attempts === 3 &&
    retryResult.text === "重试后识别成功。" &&
    retryResult.transcript.length === 1 &&
    retryResult.mode === "flash" &&
    retryResult.resourceId === "fixture-resource" &&
    retryResult.fallbackUsed === false &&
    retryResult.fallbackReason === null,
  noSpeechReturnsEmptyTranscript:
    noSpeechResult.noSpeech === true && noSpeechResult.text === "" && noSpeechResult.transcript.length === 0,
  exhaustedRetriesStayBoundedAndActionable:
    exhaustedRequestCount === 3 &&
    exhaustedError.includes("已重试 3 次") &&
    exhaustedError.includes("本地音频已保留") &&
    exhaustedError.includes("可稍后重新生成纪要"),
  retriesConcurrencyOrQuotaStatus: isRetryableVolcanoFlashResponse({ httpStatus: 200, statusCode: "45000000" }),
  retriesRateLimit: isRetryableVolcanoFlashResponse({ httpStatus: 429, statusCode: null }),
  retriesServerFailure: isRetryableVolcanoFlashResponse({ httpStatus: 503, statusCode: null }),
  doesNotRetryInvalidRequest: !isRetryableVolcanoFlashResponse({ httpStatus: 400, statusCode: "45000001" }),
  boundedExponentialBackoff:
    [1, 2, 3, 4, 5].map((attempt) => volcanoFlashRetryDelayMs(attempt, 750)).join(",") === "750,1500,3000,5000,5000",
  acceptsNoSpeechAsQualityOutcome:
    asrSource.includes('statusCode === "20000003"') &&
    asrSource.includes("const transcript = noSpeech ? []") &&
    processingSource.includes("copy.asrNoSpeechDiagnostic") &&
    contentCopySource.includes("火山会后识别未检测到可用人声"),
  preservesAudioAndOffersRetry:
    asrSource.includes("本地音频已保留") &&
    asrSource.includes("可稍后重新生成纪要"),
  providerFailureCannotPublishFallback:
    !processingSource.includes('adapter = "volcano-file-asr-fallback"') &&
    processingSource.includes("throw error"),
  boundsRetryAttempts:
    asrSource.includes("Math.min(5, Math.max(1") &&
    asrSource.includes("VOLCANO_ASR_FLASH_ATTEMPTS") &&
    asrSource.includes("VOLCANO_ASR_FLASH_RETRY_MS"),
  privateUrlUsesUrlWithoutBase64:
    urlResult.text === "重试后识别成功。" &&
    receivedBodies.at(-1)?.audio?.url?.startsWith("https://private.example.test/") &&
    !("data" in (receivedBodies.at(-1)?.audio ?? {})),
  unsafePublicHttpUrlRejected: unsafeUrlRejected,
  ambiguousAudioSourceRejected: ambiguousSourceRejected,
  finalizerUsesPreparedAudioSource:
    finalizerSource.includes("prepareMeetingAudioSnapshot") &&
    finalizerSource.includes("audioSnapshot.prepareForAsr()") &&
    !finalizerSource.includes("readMeetingAudioBundle"),
  meetingAudioAssemblyAvoidsWholeRecordingBuffer:
    audioStoreSource.includes("ownminutes-audio-snapshot-") &&
    audioStoreSource.includes("objectStore.getFile") &&
    !audioStoreSource.includes("Buffer.concat(buffers)"),
  remoteAsrUsesPrivateTransientObject:
    audioStoreSource.includes('buildMeetingObjectKey(meetingKey, "asrInput"') &&
    audioStoreSource.includes("createPresignedGetUrl") &&
    objectStoreSource.includes("presignAwsV4Get") &&
    objectStoreSource.includes("UNSIGNED-PAYLOAD"),
  sendsOnlyPublicHttpsPresignedUrlsToProvider:
    isProviderAccessibleAsrAudioUrl("https://storage.example.com/private/meeting.ogg?signature=fixture") &&
    !isProviderAccessibleAsrAudioUrl("http://storage.example.com/private/meeting.ogg") &&
    !isProviderAccessibleAsrAudioUrl("https://minio:9000/private/meeting.ogg") &&
    !isProviderAccessibleAsrAudioUrl("https://localhost/private/meeting.ogg") &&
    !isProviderAccessibleAsrAudioUrl("https://127.0.0.1/private/meeting.ogg") &&
    !isProviderAccessibleAsrAudioUrl("https://10.0.0.8/private/meeting.ogg") &&
    !isProviderAccessibleAsrAudioUrl("https://172.20.0.2/private/meeting.ogg") &&
    !isProviderAccessibleAsrAudioUrl("https://192.168.1.8/private/meeting.ogg") &&
    !isProviderAccessibleAsrAudioUrl("https://[::1]/private/meeting.ogg") &&
    !isProviderAccessibleAsrAudioUrl("https://minio.default.svc.cluster.local/private/meeting.ogg") &&
    audioStoreSource.includes("isProviderAccessibleAsrAudioUrl(audioUrl)") &&
    audioStoreSource.includes("const buffer = await readFile(normalized.filePath)") &&
    audioStoreSource.includes('"local-buffer-fallback" as const'),
  providerEndpointsRejectAuthenticatedSsrf:
    throwsEndpoint("http://169.254.169.254/latest/meta-data", { NODE_ENV: "production" }) &&
    throwsEndpoint("https://127.0.0.1/internal", { NODE_ENV: "production" }) &&
    throwsEndpoint("https://example.com/collect", { NODE_ENV: "production" }) &&
    resolveVolcanoRuntimeEndpoint("https://openspeech.bytedance.com/api/v3/auc/bigmodel/query").startsWith(
      "https://openspeech.bytedance.com/",
    ) &&
    resolveVolcanoRuntimeEndpoint("http://127.0.0.1:3210/fixture").startsWith("http://127.0.0.1:3210/"),
  standardStrategyForcesLowCostPrimary:
    costRouter.standardSuccess.result?.mode === "standard" &&
    costRouter.standardSuccess.result?.resourceId === "fixture-standard-resource" &&
    costRouter.standardSuccess.result?.fallbackUsed === false &&
    costRouter.standardSuccess.result?.fallbackReason === null &&
    costRouter.standardSuccess.paths.join(",") === "/submit,/query" &&
    costRouter.standardSuccess.resources.join(",") === "fixture-standard-resource,fixture-standard-resource",
  rateLimitAllowsSingleTurboFallback:
    costRouter.rateLimit.result?.fallbackUsed === true &&
    costRouter.rateLimit.result?.fallbackReason === "standard_submit_rate_limited" &&
    costRouter.rateLimit.result?.mode === "flash" &&
    costRouter.rateLimit.result?.resourceId === "fixture-turbo-resource" &&
    costRouter.rateLimit.paths.join(",") === "/submit,/recognize" &&
    costRouter.rateLimit.resources.join(",") === "fixture-standard-resource,fixture-turbo-resource",
  serverFailureAllowsSingleTurboFallback:
    costRouter.serverFailure.result?.fallbackReason === "standard_submit_server_error" &&
    costRouter.serverFailure.paths.join(",") === "/submit,/recognize",
  overloadAllowsSingleTurboFallback:
    costRouter.overload.result?.fallbackReason === "standard_submit_overloaded" &&
    costRouter.overload.paths.join(",") === "/submit,/recognize",
  fallbackRequiresExplicitEnable:
    costRouter.disabled.error.includes("status 45000000") && costRouter.disabled.paths.join(",") === "/submit",
  fallbackEnableEnvironmentUsesBinaryContract:
    costRouter.envEnabled.result?.fallbackUsed === true &&
    costRouter.envEnabled.paths.join(",") === "/submit,/recognize" &&
    costRouter.envDisabled.error.includes("status 45000000") &&
    costRouter.envDisabled.paths.join(",") === "/submit",
  fallbackRequiresDurationWithinCap:
    costRouter.tooLong.error.includes("status 45000000") && costRouter.tooLong.paths.join(",") === "/submit",
  fallbackRejectsUnknownZeroDuration:
    costRouter.unknownDuration.error.includes("status 45000000") &&
    costRouter.unknownDuration.paths.join(",") === "/submit",
  fallbackDefaultsToThirtyMinuteCap:
    costRouter.defaultCapExceeded.error.includes("status 45000000") &&
    costRouter.defaultCapExceeded.paths.join(",") === "/submit",
  fallbackRejectsUnboundedConfiguredCap:
    costRouter.unboundedCap.error.includes("status 45000000") &&
    costRouter.unboundedCap.paths.join(",") === "/submit",
  fallbackRejectsFractionalConfiguredCap:
    costRouter.fractionalCap.error.includes("status 45000000") &&
    costRouter.fractionalCap.paths.join(",") === "/submit",
  turboPrimaryMisconfigurationFailsClosed:
    costRouter.turboPrimary.error.includes("primary resource must not use Turbo") && costRouter.turboPrimary.paths.length === 0,
  authorizationAndConfigurationFailuresNeverFallback:
    costRouter.forbidden.error.includes("HTTP 403") &&
    costRouter.forbidden.paths.join(",") === "/submit" &&
    costRouter.invalid.error.includes("status 45000001") &&
    costRouter.invalid.paths.join(",") === "/submit",
  unknownSubmitStatusNeverFallsBack:
    costRouter.unknown.error.includes("status unknown") && costRouter.unknown.paths.join(",") === "/submit",
  ambiguousSubmitNetworkFailureNeverFallsBack:
    Boolean(costRouter.submitNetwork.error) && costRouter.submitNetwork.paths.join(",") === "/submit",
  acceptedNoSpeechNeverFallsBack:
    costRouter.noSpeech.result?.noSpeech === true &&
    costRouter.noSpeech.result?.fallbackUsed === false &&
    costRouter.noSpeech.paths.join(",") === "/submit,/query",
  acceptedQueryFailuresNeverFallback:
    costRouter.queryTimeout.error.includes("timed out") &&
    costRouter.queryTimeout.paths.join(",") === "/submit,/query" &&
    costRouter.queryTerminal.error.includes("terminal status 45000001") &&
    costRouter.queryTerminal.paths.join(",") === "/submit,/query" &&
    Boolean(costRouter.queryNetwork.error) &&
    costRouter.queryNetwork.paths.join(",") === "/submit,/query",
  turboFallbackAttemptIsAlwaysOne:
    costRouter.turboExhausted.error.includes("已重试 1 次") &&
    costRouter.turboExhausted.paths.filter((path) => path === "/recognize").length === 1,
  routingMetadataDoesNotExposeCredentials:
    !JSON.stringify(costRouter.rateLimit.result).includes("fixture-key") &&
    !JSON.stringify(costRouter.rateLimit.result).includes("X-Api-Key"),
  usesCostRouterEnvironmentContract:
    asrSource.includes("OWNMINUTES_ASR_FILE_STRATEGY") &&
    asrSource.includes("OWNMINUTES_ASR_TURBO_FALLBACK_ENABLED") &&
    asrSource.includes("OWNMINUTES_ASR_TURBO_FALLBACK_MAX_AUDIO_MINUTES") &&
    asrSource.includes("VOLCANO_ASR_TURBO_RECOGNIZE_URL") &&
    asrSource.includes("VOLCANO_ASR_TURBO_RESOURCE_ID"),
};

console.log(JSON.stringify(checks, null, 2));
if (Object.values(checks).some((value) => !value)) process.exitCode = 1;

function buildSilentWav(sampleRate, seconds) {
  const dataBytes = sampleRate * seconds * 2;
  const output = Buffer.alloc(44 + dataBytes);
  output.write("RIFF", 0);
  output.writeUInt32LE(36 + dataBytes, 4);
  output.write("WAVEfmt ", 8);
  output.writeUInt32LE(16, 16);
  output.writeUInt16LE(1, 20);
  output.writeUInt16LE(1, 22);
  output.writeUInt32LE(sampleRate, 24);
  output.writeUInt32LE(sampleRate * 2, 28);
  output.writeUInt16LE(2, 32);
  output.writeUInt16LE(16, 34);
  output.write("data", 36);
  output.writeUInt32LE(dataBytes, 40);
  return output;
}

function throwsEndpoint(value, environment) {
  try {
    resolveVolcanoRuntimeEndpoint(value, environment);
    return false;
  } catch {
    return true;
  }
}

async function runCostRouterFixtures() {
  let scenario = "standard-success";
  let requests = [];
  const fixtureServer = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      const path = request.url || "/";
      requests.push({ path, resourceId: request.headers["x-api-resource-id"] || "" });

      if (path === "/submit") {
        if (scenario === "submit-network") {
          request.socket.destroy();
          return;
        }
        if (scenario === "rate-limit") return respond(response, "42900000", {}, 429);
        if (scenario === "server-failure") return respond(response, null, {}, 503);
        if (["overload", "disabled", "too-long", "unbounded-cap", "fractional-cap", "turbo-exhausted"].includes(scenario)) {
          return respond(response, "45000000", {});
        }
        if (scenario === "forbidden") return respond(response, "45000030", {}, 403);
        if (scenario === "invalid") return respond(response, "45000001", {}, 400);
        if (scenario === "unknown") return respond(response, null, {});
        return respond(response, "20000000", {});
      }

      if (path === "/query") {
        if (scenario === "no-speech") return respond(response, "20000003", { result: {} });
        if (scenario === "query-timeout") return respond(response, "20000001", {});
        if (scenario === "query-terminal") return respond(response, "45000001", {});
        if (scenario === "query-network") {
          request.socket.destroy();
          return;
        }
        return respond(response, "20000000", {
          result: { utterances: [{ start_time: 0, speaker_id: 1, text: "低价主路径识别成功。" }] },
        });
      }

      if (path === "/recognize") {
        if (scenario === "turbo-exhausted") return respond(response, "45000000", {});
        return respond(response, "20000000", {
          result: { utterances: [{ start_time: 0, speaker_id: 1, text: "Turbo 受控兜底成功。" }] },
        });
      }

      respond(response, null, {}, 404);
    });
  });

  await new Promise((resolve) => fixtureServer.listen(0, "127.0.0.1", resolve));
  const fixtureAddress = fixtureServer.address();
  if (!fixtureAddress || typeof fixtureAddress === "string") throw new Error("ASR cost router fixture did not bind.");
  const baseUrl = `http://127.0.0.1:${fixtureAddress.port}`;
  const routerInput = {
    buffer: buildSilentWav(16_000, 1),
    config: {
      apiKey: "fixture-key",
      mode: "flash",
      resourceId: "fixture-standard-resource",
      strategy: "standard_then_turbo",
      turboResourceId: "fixture-turbo-resource",
      turboFallbackEnabled: true,
      turboFallbackMaxAudioMinutes: 1,
      maxAttempts: 5,
      submitUrl: `${baseUrl}/submit`,
      queryUrl: `${baseUrl}/query`,
      turboRecognizeUrl: `${baseUrl}/recognize`,
    },
    durationMs: 1_000,
    fileName: "cost-router.wav",
    meetingId: "asr-cost-router-fixture",
    mimeType: "audio/wav",
  };

  const previousQueryAttempts = process.env.VOLCANO_ASR_QUERY_ATTEMPTS;
  const previousQueryIntervalMs = process.env.VOLCANO_ASR_QUERY_INTERVAL_MS;
  const previousTurboFallbackEnabled = process.env.OWNMINUTES_ASR_TURBO_FALLBACK_ENABLED;
  process.env.VOLCANO_ASR_QUERY_ATTEMPTS = "1";
  process.env.VOLCANO_ASR_QUERY_INTERVAL_MS = "1";

  async function run(nextScenario, overrides = {}) {
    scenario = nextScenario;
    requests = [];
    let result;
    let error = "";
    try {
      result = await transcribeWithVolcanoFileAsr({
        ...routerInput,
        ...overrides,
        config: { ...routerInput.config, ...(overrides.config || {}) },
        meetingId: `asr-cost-router-${nextScenario}`,
      });
    } catch (caught) {
      error = caught instanceof Error ? caught.message : String(caught);
    }
    return {
      result,
      error,
      paths: requests.map((item) => item.path),
      resources: requests.map((item) => item.resourceId),
    };
  }

  try {
    const results = {
      standardSuccess: await run("standard-success"),
      rateLimit: await run("rate-limit"),
      serverFailure: await run("server-failure"),
      overload: await run("overload"),
      disabled: await run("disabled", { config: { turboFallbackEnabled: false } }),
      tooLong: await run("too-long", { durationMs: 60_001 }),
      unknownDuration: await run("too-long", { durationMs: 0 }),
      defaultCapExceeded: await run("too-long", {
        durationMs: 30 * 60_000 + 1,
        config: { turboFallbackMaxAudioMinutes: undefined },
      }),
      unboundedCap: await run("unbounded-cap", {
        durationMs: 120 * 60_000,
        config: { turboFallbackMaxAudioMinutes: 999 },
      }),
      fractionalCap: await run("fractional-cap", {
        durationMs: 10 * 60_000,
        config: { turboFallbackMaxAudioMinutes: 30.5 },
      }),
      turboPrimary: await run("overload", { config: { resourceId: "fixture-turbo-resource" } }),
      forbidden: await run("forbidden"),
      invalid: await run("invalid"),
      unknown: await run("unknown"),
      submitNetwork: await run("submit-network"),
      noSpeech: await run("no-speech"),
      queryTimeout: await run("query-timeout"),
      queryTerminal: await run("query-terminal"),
      queryNetwork: await run("query-network"),
      turboExhausted: await run("turbo-exhausted"),
    };
    process.env.OWNMINUTES_ASR_TURBO_FALLBACK_ENABLED = "1";
    results.envEnabled = await run("overload", { config: { turboFallbackEnabled: undefined } });
    process.env.OWNMINUTES_ASR_TURBO_FALLBACK_ENABLED = "0";
    results.envDisabled = await run("overload", { config: { turboFallbackEnabled: undefined } });
    return results;
  } finally {
    if (previousQueryAttempts === undefined) delete process.env.VOLCANO_ASR_QUERY_ATTEMPTS;
    else process.env.VOLCANO_ASR_QUERY_ATTEMPTS = previousQueryAttempts;
    if (previousQueryIntervalMs === undefined) delete process.env.VOLCANO_ASR_QUERY_INTERVAL_MS;
    else process.env.VOLCANO_ASR_QUERY_INTERVAL_MS = previousQueryIntervalMs;
    if (previousTurboFallbackEnabled === undefined) delete process.env.OWNMINUTES_ASR_TURBO_FALLBACK_ENABLED;
    else process.env.OWNMINUTES_ASR_TURBO_FALLBACK_ENABLED = previousTurboFallbackEnabled;
    await new Promise((resolve) => fixtureServer.close(resolve));
  }
}

function respond(response, statusCode, body, httpStatus = 200) {
  response.statusCode = httpStatus;
  response.setHeader("content-type", "application/json");
  if (statusCode) response.setHeader("x-api-status-code", statusCode);
  response.end(JSON.stringify(body));
}
