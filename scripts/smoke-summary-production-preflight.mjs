#!/usr/bin/env node

import { spawnSync } from "node:child_process";

const completeEnv = {
  ARK_API_KEY: "redacted-ark-api-key",
  ARK_CHAT_MODEL: "ep-summary-smoke",
  ARK_BASE_URL: "https://ark.cn-beijing.volces.com/api/v3",
  OWNMINUTES_SUMMARY_JSON_ONLY: "1",
  OWNMINUTES_SUMMARY_HALLUCINATION_POLICY: "transcript-only facts; missing owner/date/fact must be marked 不确定",
  OWNMINUTES_SUMMARY_RETRY_POLICY: "retry once on invalid JSON, then fall back to deterministic local summary",
  OWNMINUTES_SUMMARY_HUMAN_REVIEW_POLICY: "user reviews summary before publishing share link or Obsidian export",
};

const cases = [
  {
    name: "missing-env",
    expectOk: false,
    env: {},
  },
  {
    name: "ark-only",
    expectOk: false,
    env: {
      ARK_API_KEY: "redacted-ark-api-key",
      ARK_CHAT_MODEL: "ep-summary-smoke",
    },
  },
  {
    name: "http-base-url",
    expectOk: false,
    env: {
      ...completeEnv,
      ARK_BASE_URL: "http://ark.local/api/v3",
    },
  },
  {
    name: "complete-ark",
    expectOk: true,
    env: completeEnv,
  },
];

const results = cases.map((testCase) => {
  const output = runCase(testCase.env);
  const payload = parseJson(output.stdout);
  return {
    name: testCase.name,
    expected: testCase.expectOk,
    status: output.status,
    ok: payload?.ok,
    productionCandidate: payload?.productionCandidate,
    provider: payload?.provider,
    missing: payload?.missing ?? [],
    hasChecks: Array.isArray(payload?.checks) && payload.checks.length >= 11,
    hasRequiredEnv: Array.isArray(payload?.requiredEnv) && payload.requiredEnv.length >= 7,
    hasPromptGate: payload?.checks?.some((check) => check.id === "prompt-requires-json"),
    hasTranscriptQualityGate: payload?.checks?.some((check) => check.id === "transcript-quality-gate"),
    hasNormalizerGate: payload?.checks?.some((check) => check.id === "normalizer-runtime"),
    hasFallbackGate: payload?.checks?.some((check) => check.id === "local-fallback"),
    hasArkRetryTimeoutGate: payload?.checks?.some((check) => check.id === "ark-retry-timeout"),
    hasArkCostControlGate: payload?.checks?.some((check) => check.id === "ark-cost-controls"),
    hasHumanReviewGate: payload?.checks?.some((check) => check.id === "human-review-policy"),
    noSecretLeaks:
      !output.combined.includes("redacted-ark-api-key") &&
      !output.combined.includes("AKL") &&
      !output.combined.includes("sk-proj") &&
      !output.combined.includes("Secret Access Key") &&
      !output.combined.includes("WVRCaE"),
  };
});

const summary = {
  allExpected: results.every((result) => result.ok === result.expected),
  strictFailsWhenMissing: results.find((result) => result.name === "missing-env")?.status === 1,
  strictFailsWithArkOnly: results.find((result) => result.name === "ark-only")?.status === 1,
  strictFailsWithHttpBaseUrl: results.find((result) => result.name === "http-base-url")?.status === 1,
  strictPassesWithCompleteArk: results.find((result) => result.name === "complete-ark")?.status === 0,
  completeUsesArk: results.find((result) => result.name === "complete-ark")?.provider === "volcano-ark",
  allHaveChecks: results.every((result) => result.hasChecks),
  allHaveRequiredEnv: results.every((result) => result.hasRequiredEnv),
  allHaveProductionGates: results.every(
    (result) =>
      result.hasPromptGate &&
      result.hasTranscriptQualityGate &&
      result.hasNormalizerGate &&
      result.hasFallbackGate &&
      result.hasArkRetryTimeoutGate &&
      result.hasArkCostControlGate &&
      result.hasHumanReviewGate,
  ),
  noSecretLeaks: results.every((result) => result.noSecretLeaks),
  results,
};

console.log(JSON.stringify(summary, null, 2));

if (
  !summary.allExpected ||
  !summary.strictFailsWhenMissing ||
  !summary.strictFailsWithArkOnly ||
  !summary.strictFailsWithHttpBaseUrl ||
  !summary.strictPassesWithCompleteArk ||
  !summary.completeUsesArk ||
  !summary.allHaveChecks ||
  !summary.allHaveRequiredEnv ||
  !summary.allHaveProductionGates ||
  !summary.noSecretLeaks
) {
  process.exitCode = 1;
}

function runCase(env) {
  const result = spawnSync(process.execPath, ["scripts/check-summary-production-env.mjs", "--strict"], {
    cwd: process.cwd(),
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      NODE_ENV: "test",
      OWNMINUTES_SKIP_LOCAL_ENV: "1",
      ...env,
    },
    encoding: "utf8",
  });

  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    combined: `${result.stdout}\n${result.stderr}`,
  };
}

function parseJson(stdout) {
  try {
    return JSON.parse(stdout);
  } catch (error) {
    throw new Error(`Invalid summary preflight JSON: ${error.message}\n${stdout}`);
  }
}
