#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": path.join(process.cwd(), "src") },
});
const { getOfficialProcessingStatus } = jiti("../src/lib/server/official-processing-status.ts");

const keys = [
  "NODE_ENV",
  "TRANSCRIPTION_PROVIDER",
  "VOLCANO_ASR_API_KEY",
  "ARK_API_KEY",
  "ARK_CHAT_MODEL",
  "ARK_BASE_URL",
  "OWNMINUTES_SUMMARY_JSON_ONLY",
  "OWNMINUTES_SUMMARY_HALLUCINATION_POLICY",
  "OWNMINUTES_SUMMARY_RETRY_POLICY",
  "OWNMINUTES_SUMMARY_HUMAN_REVIEW_POLICY",
];
const original = Object.fromEntries(keys.map((key) => [key, process.env[key]]));

try {
  setEnvironment({
    NODE_ENV: "production",
    TRANSCRIPTION_PROVIDER: "mock",
  });
  assert.equal(getOfficialProcessingStatus(), "unavailable");

  setEnvironment({
    NODE_ENV: "test",
    TRANSCRIPTION_PROVIDER: "mock",
  });
  assert.equal(getOfficialProcessingStatus(), "ready");

  setEnvironment({
    NODE_ENV: "production",
    TRANSCRIPTION_PROVIDER: "volcano",
    VOLCANO_ASR_API_KEY: "test-only-asr-key",
  });
  assert.equal(getOfficialProcessingStatus(), "unavailable");

  setEnvironment({
    NODE_ENV: "production",
    TRANSCRIPTION_PROVIDER: "volcano",
    VOLCANO_ASR_API_KEY: "test-only-asr-key",
    ARK_API_KEY: "test-only-ark-key",
    ARK_CHAT_MODEL: "test-only-model",
    ARK_BASE_URL: "https://ark.cn-beijing.volces.com/api/v3",
    OWNMINUTES_SUMMARY_JSON_ONLY: "1",
    OWNMINUTES_SUMMARY_HALLUCINATION_POLICY: "reject-unsupported",
    OWNMINUTES_SUMMARY_RETRY_POLICY: "bounded",
    OWNMINUTES_SUMMARY_HUMAN_REVIEW_POLICY: "required-before-publish",
  });
  assert.equal(getOfficialProcessingStatus(), "ready");
} finally {
  for (const key of keys) {
    const value = original[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

const usageRoute = readFileSync("src/app/api/account/usage/route.ts", "utf8");
const meRoute = readFileSync("src/app/api/auth/me/route.ts", "utf8");
const adminDiagnosticsRoute = readFileSync("src/app/api/providers/diagnostics/route.ts", "utf8");
assert.ok(usageRoute.includes("getOfficialProcessingStatus()"));
assert.ok(meRoute.includes("getOfficialProcessingStatus()"));
assert.ok(usageRoute.includes("officialProcessing"));
assert.ok(meRoute.includes("officialProcessing"));
assert.ok(adminDiagnosticsRoute.includes("authorizeAdminApi()"));

console.log(JSON.stringify({
  authenticatedContractIsCoarse: true,
  incompleteProviderIsUnavailable: true,
  productionMockIsUnavailable: true,
  readyRequiresFileAsrAndSummary: true,
}, null, 2));

function setEnvironment(values) {
  for (const key of keys) delete process.env[key];
  Object.assign(process.env, values);
}
