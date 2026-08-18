#!/usr/bin/env node

import { spawnSync } from "node:child_process";

const completeEnv = {
  RESEND_API_KEY: "redacted-resend-api-key",
  OWNMINUTES_EMAIL_FROM: "OwnMinutes <no-reply@ownminutes.example>",
  OWNMINUTES_APP_URL: "https://app.ownminutes.example",
  OWNMINUTES_EMAIL_DOMAIN_VERIFIED: "1",
  OWNMINUTES_EMAIL_BOUNCE_POLICY: "suppress bounced recipients and review provider dashboard weekly",
  OWNMINUTES_EMAIL_COMPLAINT_POLICY: "suppress complaints and provide support opt-out path for transactional issues",
  OWNMINUTES_REQUIRE_EMAIL_VERIFICATION: "1",
};

const cases = [
  {
    name: "missing-env",
    expectOk: false,
    env: {},
  },
  {
    name: "localhost-url",
    expectOk: false,
    env: {
      ...completeEnv,
      OWNMINUTES_APP_URL: "http://127.0.0.1:3002",
    },
  },
  {
    name: "dev-token-response-enabled",
    expectOk: false,
    env: {
      ...completeEnv,
      OWNMINUTES_ALLOW_PASSWORD_RESET_TOKEN_RESPONSE: "1",
    },
  },
  {
    name: "local-auth-token-response-enabled",
    expectOk: false,
    env: {
      ...completeEnv,
      OWNMINUTES_ALLOW_LOCAL_AUTH_TOKEN_RESPONSE: "1",
    },
  },
  {
    name: "complete-resend",
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
    hasChecks: Array.isArray(payload?.checks) && payload.checks.length >= 10,
    hasRequiredEnv: Array.isArray(payload?.requiredEnv) && payload.requiredEnv.length >= 6,
    hasPublicUrlGate: payload?.checks?.some((check) => check.id === "public-app-url"),
    hasDomainGate: payload?.checks?.some((check) => check.id === "domain-verified"),
    hasBounceGate: payload?.checks?.some((check) => check.id === "bounce-policy"),
    hasComplaintGate: payload?.checks?.some((check) => check.id === "complaint-policy"),
    hasDevTokenGate: payload?.checks?.some((check) => check.id === "no-dev-token-response"),
    hasVerificationGate: payload?.checks?.some((check) => check.id === "email-verification-required"),
    noSecretLeaks:
      !output.combined.includes("redacted-resend-api-key") &&
      !output.combined.includes("AKL") &&
      !output.combined.includes("sk-proj") &&
      !output.combined.includes("Secret Access Key") &&
      !output.combined.includes("WVRCaE"),
  };
});

const summary = {
  allExpected: results.every((result) => result.ok === result.expected),
  strictFailsWhenMissing: results.find((result) => result.name === "missing-env")?.status === 1,
  strictFailsWithLocalhost: results.find((result) => result.name === "localhost-url")?.status === 1,
  strictFailsWithDevTokenResponse: results.find((result) => result.name === "dev-token-response-enabled")?.status === 1,
  strictFailsWithLocalAuthTokenResponse: results.find((result) => result.name === "local-auth-token-response-enabled")?.status === 1,
  strictPassesWithCompleteResend: results.find((result) => result.name === "complete-resend")?.status === 0,
  completeUsesResend: results.find((result) => result.name === "complete-resend")?.provider === "resend",
  allHaveChecks: results.every((result) => result.hasChecks),
  allHaveRequiredEnv: results.every((result) => result.hasRequiredEnv),
  allHaveProductionGates: results.every(
    (result) =>
      result.hasPublicUrlGate &&
      result.hasDomainGate &&
      result.hasBounceGate &&
      result.hasComplaintGate &&
      result.hasDevTokenGate &&
      result.hasVerificationGate,
  ),
  noSecretLeaks: results.every((result) => result.noSecretLeaks),
  results,
};

console.log(JSON.stringify(summary, null, 2));

if (
  !summary.allExpected ||
  !summary.strictFailsWhenMissing ||
  !summary.strictFailsWithLocalhost ||
  !summary.strictFailsWithDevTokenResponse ||
  !summary.strictFailsWithLocalAuthTokenResponse ||
  !summary.strictPassesWithCompleteResend ||
  !summary.completeUsesResend ||
  !summary.allHaveChecks ||
  !summary.allHaveRequiredEnv ||
  !summary.allHaveProductionGates ||
  !summary.noSecretLeaks
) {
  process.exitCode = 1;
}

function runCase(env) {
  const result = spawnSync(process.execPath, ["scripts/check-email-production-env.mjs", "--strict"], {
    cwd: process.cwd(),
    env: {
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      NODE_ENV: "test",
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
    throw new Error(`Invalid email preflight JSON: ${error.message}\n${stdout}`);
  }
}
