#!/usr/bin/env node

import { spawnSync } from "node:child_process";

const script = "scripts/check-public-deployment-env.mjs";

const cases = [
  {
    expectPass: false,
    name: "missing-env",
    env: {},
  },
  {
    expectPass: false,
    name: "local-preview-env",
    env: {
      EXPO_PUBLIC_API_BASE_URL: "http://127.0.0.1:3002",
      OWNMINUTES_APP_URL: "http://127.0.0.1:3002",
      OWNMINUTES_HEALTH_CHECK_URL: "http://127.0.0.1:3002/api/health",
      OWNMINUTES_PRIVACY_URL: "http://127.0.0.1:3002/privacy",
      OWNMINUTES_SUPPORT_URL: "http://127.0.0.1:3002/support",
      OWNMINUTES_TERMS_URL: "http://127.0.0.1:3002/terms",
    },
  },
  {
    expectPass: false,
    name: "public-http-env",
    env: buildEnv("http://app.example.com"),
  },
  {
    expectPass: false,
    name: "wrong-legal-origin",
    env: {
      ...buildEnv("https://app.example.com"),
      OWNMINUTES_PRIVACY_URL: "https://legal.example.com/privacy",
    },
  },
  {
    expectPass: false,
    name: "wrong-health-path",
    env: {
      ...buildEnv("https://app.example.com"),
      OWNMINUTES_HEALTH_CHECK_URL: "https://app.example.com/health",
    },
  },
  {
    expectPass: false,
    name: "missing-support-email",
    env: {
      ...buildEnv("https://app.example.com"),
      OWNMINUTES_SUPPORT_EMAIL: "",
    },
  },
  {
    expectPass: false,
    name: "placeholder-support-email",
    env: buildEnv("https://app.example.com", "support@example.com"),
  },
  {
    expectPass: false,
    name: "wrong-sample-share-origin",
    env: {
      ...buildEnv("https://app.example.com"),
      OWNMINUTES_SAMPLE_SHARE_URL: "https://share.example.com/share/demo",
    },
  },
  {
    expectPass: true,
    name: "public-https-with-sample-share",
    env: {
      ...buildEnv("https://app.example.com"),
      OWNMINUTES_SAMPLE_SHARE_URL: "https://app.example.com/share/demo",
    },
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
    leaksSecrets: leaksSecrets(output),
    outputIncludesSummary: output.includes("productionDeploymentReady"),
  };
});
const summary = {
  allCasesCovered: results.length === 10,
  allExpected: results.every((result) => result.ok),
  noSecretLeaks: results.every((result) => !result.leaksSecrets),
  summariesPrinted: results.every((result) => result.outputIncludesSummary),
  results,
};

console.log(JSON.stringify(summary, null, 2));

if (!summary.allCasesCovered || !summary.allExpected || !summary.noSecretLeaks || !summary.summariesPrinted) {
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
