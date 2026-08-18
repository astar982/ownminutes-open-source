#!/usr/bin/env node

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { spawnSync } from "node:child_process";

const passPath = ".data/smoke/public-deployment-evidence-pass.md";
const failPath = ".data/smoke/public-deployment-evidence-fail.md";
const partialPath = ".data/smoke/public-deployment-evidence-partial.md";

const passEvidence = evidenceBlock();
const failEvidence = evidenceBlock({
  overrides: {
    "Public app URL": "http://127.0.0.1:3002",
    Decision: "fail",
  },
});
const partialEvidence = evidenceBlock({
  overrides: {
    "Share link": "fail",
  },
});

mkdirSync(dirname(passPath), { recursive: true });
writeFileSync(passPath, passEvidence);
writeFileSync(failPath, failEvidence);
writeFileSync(partialPath, partialEvidence);

const pass = runChecker(passPath);
const fail = runChecker(failPath);
const partial = runChecker(partialPath);
const sourceScan = runForbiddenSourceScan();

const summary = {
  passFixtureAccepted: pass.status === 0 && pass.payload?.evidenceReady === true,
  failFixtureRejected:
    fail.status !== 0 &&
    fail.payload?.evidenceReady === false &&
    fail.payload?.urlFailures?.some((item) => item === "app:not-https") &&
    fail.payload?.decisionFail === true,
  partialFixtureRejected:
    partial.status !== 0 &&
    partial.payload?.evidenceReady === false &&
    partial.payload?.missingPassChecks?.includes("Share link:") &&
    partial.payload?.failedChecks?.includes("Share link:"),
  noForbiddenSourcePhrases: sourceScan.ok,
  forbiddenSourceHits: sourceScan.hits,
};

console.log(JSON.stringify(summary, null, 2));

if (!summary.passFixtureAccepted || !summary.failFixtureRejected || !summary.partialFixtureRejected || !summary.noForbiddenSourcePhrases) {
  process.exitCode = 1;
}

function evidenceBlock({ overrides = {} } = {}) {
  const values = {
    Date: "2026-07-05",
    Commit: "abc1234",
    "Deployment provider": "Vercel production",
    "Public app URL": "https://app.example.com",
    "Mobile API base URL": "https://app.example.com",
    "Privacy URL": "https://app.example.com/privacy",
    "Terms URL": "https://app.example.com/terms",
    "Support URL": "https://app.example.com/support",
    "Health check URL": "https://app.example.com/api/health",
    "Sample share URL": "https://app.example.com/share/example-meeting-id",
    "/api/health": "pass",
    "/api/readyz": "pass",
    "/api/deployment/diagnostics": "pass",
    "/api/release/readiness top-level summary": "pass",
    "Readiness mvpReady": "true",
    "Readiness testflightReady": "false",
    "Readiness commercialReady": "false",
    "Readiness criticalBlocked": "8",
    "Readiness blockerCount": "8",
    "Readiness publicUrlBlocked": "no",
    "Readiness nextAction": "Finish ASR and TestFlight evidence.",
    "Mobile login": "pass",
    "Short meeting": "pass",
    "Share link": "pass",
    "Password reset URL": "pass",
    "Apple notification URL configured": "pass",
    "Secrets leaked": "no",
    Decision: "pass",
    "Known issues": "other release blockers remain",
    ...overrides,
  };

  return [
    "# Public Deployment Acceptance Evidence",
    "",
    ...Object.entries(values).map(([key, value]) => `${key}: ${value}`),
    "",
  ].join("\n");
}

function runChecker(path) {
  const result = spawnSync("node", ["scripts/check-public-deployment-acceptance-evidence.mjs"], {
    encoding: "utf8",
    env: {
      ...process.env,
      OWNMINUTES_PUBLIC_DEPLOYMENT_EVIDENCE_PATH: path,
    },
  });

  return {
    status: result.status,
    output: `${result.stdout || ""}${result.stderr || ""}`.trim(),
    payload: parseJson(result.stdout),
  };
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function runForbiddenSourceScan() {
  const forbidden = ["AKL", "sk-proj", "Secret Access Key", "WVRCaE", "-----BEGIN PRIVATE KEY-----"];
  const result = spawnSync("rg", ["-n", forbidden.join("|"), "docs/public-deployment-runbook.md"], {
    encoding: "utf8",
  });
  const hits = result.status === 0 ? result.stdout.trim().split("\n").filter(Boolean) : [];
  return {
    ok: hits.length === 0,
    hits,
  };
}
