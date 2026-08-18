#!/usr/bin/env node

import { readFileSync } from "node:fs";

globalThis.__DEV__ = false;
const { assertSafeMobileApiUrl, inspectApiBaseUrl } = await import("../apps/mobile/src/config.ts");

const apiSource = readFileSync("apps/mobile/src/api.ts", "utf8");
const mobileHttpSource = readFileSync("apps/mobile/src/mobile-http.ts", "utf8");
const allowedCases = [
  "https://app.ownminutes.app",
  "https://app.ownminutes.app/api/health",
  "http://127.0.0.1:3003",
  "http://localhost:3003/api/health",
  "http://192.168.1.10:3003",
  "http://10.0.0.8:3003/api/meetings",
];
const rejectedCases = [
  { url: "", mode: "empty" },
  { url: "not-a-url", mode: "invalid" },
  { url: "ftp://app.ownminutes.app", mode: "invalid" },
  { url: "https://user:password@app.ownminutes.app", mode: "invalid" },
  { url: "http://app.ownminutes.app", mode: "public-http", message: "必须使用 HTTPS" },
  { url: "http://example.com/api/auth/login", mode: "public-http", message: "必须使用 HTTPS" },
];

const allowed = allowedCases.map((url) => {
  try {
    return { url, mode: inspectApiBaseUrl(url).mode, accepted: assertSafeMobileApiUrl(url) === url.replace(/\/$/, "") };
  } catch {
    return { url, mode: inspectApiBaseUrl(url).mode, accepted: false };
  }
});
const rejected = rejectedCases.map((testCase) => {
  try {
    assertSafeMobileApiUrl(testCase.url);
    return { ...testCase, rejected: false };
  } catch (error) {
    return {
      ...testCase,
      rejected: inspectApiBaseUrl(testCase.url).mode === testCase.mode && (!testCase.message || String(error).includes(testCase.message)),
    };
  }
});

const safeFetchIndex = apiSource.indexOf("function safeFetch");
const safeFetchGuardIndex = apiSource.indexOf("assertSafeMobileApiUrl(url)", safeFetchIndex);
const safeFetchNetworkIndex = apiSource.indexOf("return fetchMobileApi(input, { ...init, headers }", safeFetchIndex);
const uploadUrlIndex = apiSource.indexOf("const uploadUrl =");
const uploadGuardIndex = apiSource.indexOf("assertSafeMobileApiUrl(uploadUrl)", uploadUrlIndex);
const uploadNetworkIndex = apiSource.indexOf("fetchWithSession", uploadGuardIndex);
const checks = {
  acceptsHttpsAndDevelopmentHttp: allowed.every((item) => item.accepted),
  rejectsUnsafeTransports: rejected.every((item) => item.rejected),
  allFetchesUseSingleGuardedSink:
    (apiSource.match(/\bfetch\(/g) || []).length === 0 &&
    safeFetchIndex >= 0 &&
    safeFetchGuardIndex > safeFetchIndex &&
    safeFetchNetworkIndex > safeFetchGuardIndex &&
    apiSource.includes('headers.set("Accept-Language", mobileApiLanguage)') &&
    mobileHttpSource.includes("options.fetchImpl ?? fetch") &&
    mobileHttpSource.includes("controller.abort()"),
  nativeAudioUploadGuarded:
    !apiSource.includes("FileSystem.uploadAsync") &&
    uploadUrlIndex >= 0 &&
    uploadGuardIndex > uploadUrlIndex &&
    uploadNetworkIndex > uploadGuardIndex &&
    apiSource.includes("recordingUploadPartBytes = 4 * 1024 * 1024") &&
    apiSource.includes("X-OwnMinutes-Part-Sha256") &&
    apiSource.includes("uploadTemporaryNativeFileWithTimeout(") &&
    apiSource.includes("file.createUploadTask(url, { ...options, signal })") &&
    apiSource.includes("uploadTask.uploadAsync()") &&
    apiSource.includes("uploadTask.release();") &&
    apiSource.includes("safeDeleteTemporaryUploadFile(file);") &&
    apiSource.includes("part-${partIndex}-${Crypto.randomUUID()}.bin") &&
    apiSource.includes("recordingUploadPartTimeoutMs = 120_000") &&
    apiSource.includes("realtimeChunkUploadTimeoutMs = 20_000") &&
    apiSource.includes("runMobileApiOperationWithTimeout") &&
    apiSource.includes('sessionType: "background"') &&
    apiSource.includes("handle.readBytes(length)") &&
    apiSource.includes("sha256Hex(partBytes)") &&
    apiSource.includes("parseRetryAfterSeconds(result.headers)") &&
    !apiSource.includes("file.slice("),
  authUsesGuardedFetch:
    apiSource.includes("const response = await safeFetch(url") &&
    !apiSource.includes("const response = await fetch(url") &&
    apiSource.includes("async function fetchWithSession") &&
    apiSource.includes("const response = await safeFetch(input") &&
    apiSource.includes("return assertNoAuthoritativeSessionRejection(response, { ...sessionOptions, language: mobileApiLanguage })"),
  publicPagesUseSameTransportGuard:
    readFileSync("apps/mobile/App.tsx", "utf8").includes("openProviderUrl(assertSafeMobileApiUrl(`${origin}${localizedPathname}`))"),
};

console.log(JSON.stringify({ ...checks, allowed, rejected }, null, 2));

if (Object.values(checks).some((value) => !value)) process.exitCode = 1;
