#!/usr/bin/env node

import { spawnSync } from "node:child_process";

const script = "scripts/check-mobile-testflight-env.mjs";

const cases = [
  {
    expectPass: false,
    name: "missing-env",
    env: {},
  },
  {
    expectPass: false,
    name: "api-only-env",
    env: {
      EXPO_PUBLIC_API_BASE_URL: "https://app.example.com",
    },
  },
  {
    expectPass: false,
    name: "local-preview-env",
    env: buildEnv("http://127.0.0.1:3002"),
  },
  {
    expectPass: false,
    name: "public-http-env",
    env: buildEnv("http://app.example.com"),
  },
  {
    expectPass: false,
    name: "wrong-legal-paths",
    env: {
      ...buildEnv("https://app.example.com"),
      OWNMINUTES_PRIVACY_URL: "https://app.example.com/legal/privacy-policy",
      OWNMINUTES_TERMS_URL: "https://app.example.com/legal/tos",
      OWNMINUTES_SUPPORT_URL: "https://app.example.com/help",
      OWNMINUTES_HEALTH_CHECK_URL: "https://app.example.com/healthz",
    },
  },
  {
    expectPass: false,
    name: "invalid-support-email",
    env: {
      ...buildEnv("https://app.example.com"),
      OWNMINUTES_SUPPORT_EMAIL: "not-an-email",
    },
  },
  {
    expectPass: false,
    name: "placeholder-support-email",
    env: buildEnv("https://app.example.com", "support@example.com"),
  },
  {
    expectPass: true,
    name: "public-https-env",
    env: buildEnv("https://app.example.com"),
  },
];

const results = cases.map((testCase) => {
  const result = spawnSync("node", [script], {
    encoding: "utf8",
    env: {
      PATH: process.env.PATH,
      ...testCase.env,
    },
  });
  const output = `${result.stdout || ""}${result.stderr || ""}`;

  return {
    name: testCase.name,
    expected: testCase.expectPass ? "pass" : "fail",
    status: result.status,
    ok: testCase.expectPass ? result.status === 0 : result.status !== 0,
    blocksMissingLegalUrls: testCase.name !== "api-only-env" || output.includes("privacyUrl") || output.includes("legal URLs"),
    outputIncludesSummary: output.includes("testflightReady"),
    leaksSecrets: leaksSecrets(output),
  };
});

const summary = {
  allCasesCovered: results.length === 8,
  allExpected: results.every((result) => result.ok),
  legalUrlGateCovered: results.every((result) => result.blocksMissingLegalUrls),
  summariesPrinted: results.every((result) => result.outputIncludesSummary),
  noSecretLeaks: results.every((result) => !result.leaksSecrets),
  results,
};

console.log(JSON.stringify(summary, null, 2));

if (!summary.allCasesCovered || !summary.allExpected || !summary.legalUrlGateCovered || !summary.summariesPrinted || !summary.noSecretLeaks) {
  process.exitCode = 1;
}

function buildEnv(origin, supportEmail = "support@ownminutes.app") {
  return {
    EXPO_PUBLIC_API_BASE_URL: origin,
    OWNMINUTES_APP_URL: origin,
    OWNMINUTES_HEALTH_CHECK_URL: `${origin}/api/health`,
    OWNMINUTES_PRIVACY_URL: `${origin}/privacy`,
    OWNMINUTES_SUPPORT_URL: `${origin}/support`,
    OWNMINUTES_TERMS_URL: `${origin}/terms`,
    OWNMINUTES_SUPPORT_EMAIL: supportEmail,
  };
}

function leaksSecrets(text) {
  return (
    text.includes("AKL") ||
    text.includes("sk-proj") ||
    text.includes("Secret Access Key") ||
    text.includes("DATABASE_URL=") ||
    text.includes("-----BEGIN PRIVATE KEY-----")
  );
}
