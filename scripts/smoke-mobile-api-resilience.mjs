#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  fetchMobileApi,
  MobileApiError,
  parseMobileJsonResponse,
  parseMobileJsonText,
  resolveMobileApiLocale,
  runMobileApiOperationWithTimeout,
} = await jiti.import("../apps/mobile/src/mobile-http.ts");
const {
  assertNoAuthoritativeSessionRejection,
  MobileApiResponseError,
  runtimeSessionFailureDisposition,
} = await jiti.import("../apps/mobile/src/session-recovery.ts");

const apiSource = readFileSync("apps/mobile/src/api.ts", "utf8");
const mobileHttpSource = readFileSync("apps/mobile/src/mobile-http.ts", "utf8");
const sessionSource = readFileSync("apps/mobile/src/session-recovery.ts", "utf8");

const validPayload = await parseMobileJsonResponse(
  new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } }),
  "en",
);
const empty503 = await capture(() => parseMobileJsonResponse(new Response("", { status: 503 }), "zh-Hans"));
const html502 = await capture(() => parseMobileJsonResponse(new Response("<html>gateway error</html>", { status: 502 }), "en"));
const truncated200 = await capture(() => parseMobileJsonResponse(new Response('{"ok":', { status: 200 }), "zh-Hant"));
const empty200 = await capture(() => parseMobileJsonResponse(new Response("   ", { status: 200 }), "en"));
const null200 = await capture(() => parseMobileJsonResponse(new Response("null", { status: 200 }), "en"));
const array200 = await capture(() => parseMobileJsonResponse(new Response("[]", { status: 200 }), "zh-Hans"));
const json500 = await capture(() => parseMobileJsonResponse(new Response(JSON.stringify({ error: "internal trace" }), { status: 500 }), "zh-Hans"));
const coded503 = await capture(() => parseMobileJsonResponse(new Response(
  JSON.stringify({ code: "RECORDING_UPLOAD_BUSY", error: "internal queue details" }),
  { headers: { "retry-after": "17" }, status: 503 },
), "en"));
const nativeCoded503 = await capture(() => parseMobileJsonText(
  JSON.stringify({ code: "RECORDING_PART_BUSY", error: "private storage detail" }),
  503,
  "zh-Hans",
  { retryAfterSeconds: 23 },
));
const native422 = parseMobileJsonText(
  JSON.stringify({ ok: false, providerStatus: "rejected_format" }),
  422,
  "en",
);
const networkFailure = await capture(() => fetchMobileApi("https://example.invalid/api", {}, {
  language: "zh-Hant",
  fetchImpl: async () => { throw new TypeError("Network request failed"); },
}));
const timeoutFailure = await capture(() => fetchMobileApi("https://example.invalid/api", {}, {
  language: "en",
  timeoutMs: 5,
  fetchImpl: async (_input, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new Error("AbortError")), { once: true });
  }),
}));
const delayedBodyResponse = await fetchMobileApi("https://example.invalid/api", {}, {
  language: "en",
  timeoutMs: 10,
  fetchImpl: async (_input, init) => createDelayedJsonResponse(init?.signal, 50, { ok: true }),
});
const delayedBodyTimeoutFailure = await capture(() => parseMobileJsonResponse(delayedBodyResponse, "en"));

let successfulBodyInternalAborts = 0;
const successfulBodyResponse = await fetchMobileApi("https://example.invalid/api", {}, {
  language: "en",
  timeoutMs: 20,
  fetchImpl: async (_input, init) => {
    init?.signal?.addEventListener("abort", () => { successfulBodyInternalAborts += 1; }, { once: true });
    return createDelayedJsonResponse(init?.signal, 1, { ok: true });
  },
});
const successfulBodyPayload = await parseMobileJsonResponse(successfulBodyResponse, "en");
await delay(30);

const callerHeaderAbortController = new AbortController();
const callerHeaderAbortPromise = capture(() => fetchMobileApi("https://example.invalid/api", {
  signal: callerHeaderAbortController.signal,
}, {
  language: "en",
  timeoutMs: 50,
  fetchImpl: async (_input, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(abortError()), { once: true });
  }),
}));
setTimeout(() => callerHeaderAbortController.abort(), 2);
const callerHeaderAbortFailure = await callerHeaderAbortPromise;

const callerBodyAbortController = new AbortController();
const callerBodyAbortResponse = await fetchMobileApi("https://example.invalid/api", {
  signal: callerBodyAbortController.signal,
}, {
  language: "en",
  timeoutMs: 50,
  fetchImpl: async (_input, init) => createDelayedJsonResponse(init?.signal, 100, { ok: true }),
});
const callerBodyAbortPromise = capture(() => parseMobileJsonResponse(callerBodyAbortResponse, "en"));
setTimeout(() => callerBodyAbortController.abort(), 2);
const callerBodyAbortFailure = await callerBodyAbortPromise;

let authoritativeResponseInternalAborts = 0;
const timedAuthoritativeResponse = await fetchMobileApi("https://example.invalid/api", {}, {
  language: "en",
  timeoutMs: 20,
  fetchImpl: async (_input, init) => {
    init?.signal?.addEventListener("abort", () => { authoritativeResponseInternalAborts += 1; }, { once: true });
    return createDelayedJsonResponse(init?.signal, 1, { error: "session expired" }, 401);
  },
});
const timedAuthoritativeFailure = await capture(() => assertNoAuthoritativeSessionRejection(timedAuthoritativeResponse));
await delay(30);

const nativeCancellationEvents = [];
const nativeOperationTimeoutFailure = await capture(() => runMobileApiOperationWithTimeout(
  (signal) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => {
      nativeCancellationEvents.push("aborted");
      setTimeout(() => {
        nativeCancellationEvents.push("settled");
        reject(abortError());
      }, 3);
    }, { once: true });
  }),
  { language: "zh-Hans", timeoutMs: 5 },
));
nativeCancellationEvents.push("returned");
await delay(10);
const hardTimeoutStartedAt = Date.now();
const nonCancellableNativeOperationFailure = await capture(() => runMobileApiOperationWithTimeout(
  () => new Promise(() => undefined),
  { language: "en", timeoutMs: 5 },
));
const hardTimeoutElapsedMs = Date.now() - hardTimeoutStartedAt;
const nativeOperationNetworkFailure = await capture(() => runMobileApiOperationWithTimeout(
  async () => { throw new Error("native network detail"); },
  { language: "zh-Hant", timeoutMs: 50 },
));
const rejection401 = await capture(() => assertNoAuthoritativeSessionRejection(
  new Response("", { status: 401 }),
  { language: "zh-Hant" },
));
const ordinary403 = await assertNoAuthoritativeSessionRejection(
  new Response(JSON.stringify({ error: "forbidden" }), { status: 403 }),
  { language: "en" },
);
const authoritative403 = await capture(() => assertNoAuthoritativeSessionRejection(
  new Response(JSON.stringify({ error: "session revoked" }), { status: 403 }),
  { forbiddenIsAuthoritative: true, language: "en" },
));
const malformedBusiness403 = await capture(() => parseMobileJsonResponse(new Response("not-json", { status: 403 }), "en"));
const ordinaryResponseError403 = new MobileApiResponseError("forbidden", 403);
const explicitAuthoritativeResponseError403 = new MobileApiResponseError("session revoked", 403, { authoritative: true });

const surfacedMessages = [empty503, html502, truncated200, empty200, null200, array200, json500, coded503, nativeCoded503, networkFailure, timeoutFailure, rejection401, authoritative403, malformedBusiness403]
  .map((error) => error instanceof Error ? error.message : String(error));

const checks = {
  parsesValidJson: validPayload?.ok === true,
  empty503BecomesFriendlyRetryableError:
    isMobileApiError(empty503, "server-unavailable", 503) &&
    empty503.message.includes("本机录音不会丢失"),
  html502BecomesFriendlyServerError:
    isMobileApiError(html502, "server-unavailable", 502) &&
    html502.message.includes("temporarily unavailable"),
  truncatedSuccessBecomesFriendlyInvalidResponse:
    isMobileApiError(truncated200, "invalid-response", 200) &&
    truncated200.message.includes("不完整的回應"),
  emptySuccessBecomesFriendlyInvalidResponse:
    isMobileApiError(empty200, "invalid-response", 200) &&
    empty200.message.includes("incomplete response"),
  nonObjectJsonCannotCausePropertyAccessCrash:
    isMobileApiError(null200, "invalid-response", 200) &&
    isMobileApiError(array200, "invalid-response", 200),
  validJson500DoesNotLeakServerDetail:
    isMobileApiError(json500, "server-unavailable", 500) &&
    !json500.message.includes("internal trace"),
  serverFailureRetainsSafeRetryMetadata:
    isMobileApiError(coded503, "server-unavailable", 503) &&
    coded503.code === "RECORDING_UPLOAD_BUSY" &&
    coded503.retryAfterSeconds === 17 &&
    coded503.retryable === true &&
    !coded503.message.includes("internal queue details"),
  nativeUploadParserRetainsRetryMetadata:
    isMobileApiError(nativeCoded503, "server-unavailable", 503) &&
    nativeCoded503.code === "RECORDING_PART_BUSY" &&
    nativeCoded503.retryAfterSeconds === 23 &&
    !nativeCoded503.message.includes("private storage detail"),
  native422PayloadRemainsAvailable:
    native422.ok === false && native422.providerStatus === "rejected_format",
  networkFailureIsLocalized:
    isMobileApiError(networkFailure, "network", 0) &&
    networkFailure.message.includes("無法連線"),
  timeoutIsDistinctAndLocalized:
    isMobileApiError(timeoutFailure, "timeout", 0) &&
    timeoutFailure.message.includes("timed out"),
  responseBodyReadRemainsInsideTimeout:
    isMobileApiError(delayedBodyTimeoutFailure, "timeout", 200) &&
    delayedBodyTimeoutFailure.message.includes("timed out"),
  completedBodyCleansTimerAndAbortListener:
    successfulBodyPayload?.ok === true && successfulBodyInternalAborts === 0,
  callerAbortBeforeHeadersIsNotTimeout:
    callerHeaderAbortFailure instanceof Error &&
    callerHeaderAbortFailure.name === "AbortError" &&
    !(callerHeaderAbortFailure instanceof MobileApiError),
  callerAbortDuringBodyIsNotTimeout:
    callerBodyAbortFailure instanceof Error &&
    callerBodyAbortFailure.name === "AbortError" &&
    !(callerBodyAbortFailure instanceof MobileApiError),
  authoritativeResponseBodyCleansOriginalRequest:
    timedAuthoritativeFailure instanceof MobileApiResponseError &&
    authoritativeResponseInternalAborts === 0 &&
    !sessionSource.includes("response.clone()"),
  nativeOperationTimeoutIsLocalized:
    isMobileApiError(nativeOperationTimeoutFailure, "timeout", 0) &&
    nativeOperationTimeoutFailure.message.includes("请求超时") &&
    nativeCancellationEvents.join(",") === "aborted,returned,settled",
  nonCancellableNativeOperationHasHardDeadline:
    isMobileApiError(nonCancellableNativeOperationFailure, "timeout", 0) &&
    hardTimeoutElapsedMs < 100,
  nativeOperationNetworkFailureIsLocalized:
    isMobileApiError(nativeOperationNetworkFailure, "network", 0) &&
    nativeOperationNetworkFailure.message.includes("無法連線") &&
    !nativeOperationNetworkFailure.message.includes("native network detail"),
  languageNormalization:
    resolveMobileApiLocale("zh-CN") === "zh-Hans" &&
    resolveMobileApiLocale("zh-Hant-HK") === "zh-Hant" &&
    resolveMobileApiLocale("fr-FR") === "en",
  empty401RemainsAuthoritative:
    rejection401 instanceof MobileApiResponseError &&
    rejection401.status === 401 &&
    rejection401.message.includes("登入狀態已失效"),
  default403RemainsNonAuthoritative: ordinary403.status === 403,
  optedIn403RemainsAuthoritative:
    authoritative403 instanceof MobileApiResponseError &&
    authoritative403.status === 403 &&
    authoritative403.message === "session revoked",
  malformedBusiness403DoesNotInvalidateSession:
    malformedBusiness403 instanceof MobileApiError &&
    malformedBusiness403.status === 0 &&
    malformedBusiness403.httpStatus === 403 &&
    runtimeSessionFailureDisposition(malformedBusiness403, false) === "preserve",
  ordinaryResponseError403DoesNotInvalidateSession:
    runtimeSessionFailureDisposition(ordinaryResponseError403, false) === "preserve" &&
    runtimeSessionFailureDisposition(explicitAuthoritativeResponseError403, false) === "reauthenticate-now",
  noRawJsonParserErrorsSurface:
    surfacedMessages.every((message) => !/JSON Parse|Unexpected end|JSON\.parse|SyntaxError/i.test(message)),
  noDirectResponseJsonInMobileApi:
    !apiSource.includes("response.json()") &&
    !sessionSource.includes("response.clone().json()") &&
    !apiSource.includes("JSON.parse(result.body)"),
  realtimeUploadUsesHardenedParser:
    apiSource.includes("parseMobileJsonText<RealtimeAudioChunkAck & { error?: string }>") &&
    apiSource.includes("if (result.status === 401)") &&
    apiSource.includes('result.status === 422 && payload.providerStatus === "rejected_format"') &&
    apiSource.includes("retryAfterSeconds: error.retryAfterSeconds"),
  nativeUploadsUseBoundedLocalizedTransport:
    apiSource.includes("recordingUploadPartTimeoutMs = 120_000") &&
    apiSource.includes("realtimeChunkUploadTimeoutMs = 20_000") &&
    (apiSource.match(/uploadTemporaryNativeFileWithTimeout\(/g) || []).length >= 3 &&
    apiSource.includes("runMobileApiOperationWithTimeout") &&
    apiSource.includes("file.createUploadTask(url, { ...options, signal })") &&
    apiSource.includes("uploadTask.uploadAsync()") &&
    apiSource.includes("uploadTask.release();") &&
    apiSource.includes("safeDeleteTemporaryUploadFile(file);") &&
    apiSource.includes("part-${partIndex}-${Crypto.randomUUID()}.bin") &&
    mobileHttpSource.includes("controller.abort()") &&
    mobileHttpSource.includes("Promise.race([operationPromise, timeoutPromise])") &&
    apiSource.includes("if (result.status === 401)") &&
    apiSource.includes("new MobileApiResponseError(mobileSessionExpiredMessage(mobileApiLanguage), result.status)"),
  authMe403OptsIntoAuthoritativeHandling:
    apiSource.includes('}, { forbiddenIsAuthoritative: true });') &&
    apiSource.includes("{ ...sessionOptions, language: mobileApiLanguage }"),
  allApiFetchesUseTimeoutWrapper:
    apiSource.includes("return fetchMobileApi(input, { ...init, headers }, { language: mobileApiLanguage })"),
};

console.log(JSON.stringify(checks, null, 2));
if (Object.values(checks).some((value) => value !== true)) process.exitCode = 1;

async function capture(action) {
  try {
    await action();
    return null;
  } catch (error) {
    return error;
  }
}

function isMobileApiError(value, kind, status) {
  return value instanceof MobileApiError && value.kind === kind && value.httpStatus === status;
}

function createDelayedJsonResponse(signal, delayMs, payload, status = 200) {
  let timeout;
  let abort;
  const body = new ReadableStream({
    start(controller) {
      abort = () => {
        if (timeout) clearTimeout(timeout);
        controller.error(abortError());
      };
      if (signal?.aborted) {
        abort();
        return;
      }
      signal?.addEventListener("abort", abort, { once: true });
      timeout = setTimeout(() => {
        signal?.removeEventListener("abort", abort);
        controller.enqueue(new TextEncoder().encode(JSON.stringify(payload)));
        controller.close();
      }, delayMs);
    },
    cancel() {
      if (timeout) clearTimeout(timeout);
      if (abort) signal?.removeEventListener("abort", abort);
    },
  });
  return new Response(body, { status, headers: { "content-type": "application/json" } });
}

function abortError() {
  return Object.assign(new Error("aborted"), { name: "AbortError" });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
