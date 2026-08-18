#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { spawnSync } from "node:child_process";

const passPath = ".data/smoke/apple-iap-evidence-pass.md";
const failPath = ".data/smoke/apple-iap-evidence-fail.md";
const partialPath = ".data/smoke/apple-iap-evidence-partial.md";
const draftPath = ".data/smoke/apple-iap-evidence-draft.md";

const scenarios = [
  ["Plus purchase", "ownminutes.plus.monthly"],
  ["Pro purchase", "ownminutes.pro.monthly"],
  ["Duplicate transaction idempotency", ""],
  ["DID_RENEW notification", ""],
  ["REFUND notification", ""],
  ["EXPIRED or REVOKE notification", ""],
  ["Database ledger", ""],
  ["Account plan rollback", ""],
];

const passEvidence = evidenceBlock();
const failEvidence = evidenceBlock({ environment: "local", notificationUrl: "http://127.0.0.1:3002/api/payments/apple/notifications", finalDecision: "fail" });
const partialEvidence = evidenceBlock({ omitScenarioField: "REFUND notification", omitField: "Entitlement ledger:" });

mkdirSync(dirname(passPath), { recursive: true });
writeFileSync(passPath, passEvidence);
writeFileSync(failPath, failEvidence);
writeFileSync(partialPath, partialEvidence);

const pass = runChecker(passPath);
const fail = runChecker(failPath);
const partial = runChecker(partialPath);
const draft = runDraft(draftPath);
const draftCheck = runChecker(draftPath);
const sourceScan = runForbiddenSourceScan();

const summary = {
  passFixtureAccepted: pass.status === 0 && pass.payload?.evidenceReady === true,
  failFixtureRejected:
    fail.status !== 0 &&
    fail.payload?.evidenceReady === false &&
    fail.payload?.environmentReady === false &&
    fail.payload?.notificationUrlReady === false &&
    fail.payload?.decisionFail === true,
  partialFixtureRejected:
    partial.status !== 0 &&
    partial.payload?.evidenceReady === false &&
    partial.payload?.missingFieldsByScenario?.some((item) => item.scenario === "REFUND notification" && item.missing.includes("Entitlement ledger:")),
  draftGenerated:
    draft.status === 0 &&
    draft.payload?.draftWritten === true &&
    draft.payload?.draftDecision === "pending" &&
    existsSync(draftPath) &&
    readFileSync(draftPath, "utf8").includes("This file is an automated draft from `npm run iap:acceptance:evidence:draft`.") &&
    readFileSync(draftPath, "utf8").includes("Environment: pending") &&
    readFileSync(draftPath, "utf8").includes("Public notification URL: pending") &&
    readFileSync(draftPath, "utf8").includes("Decision: pending"),
  draftRejectedUntilManualChecks:
    draftCheck.status !== 0 &&
    draftCheck.payload?.evidenceReady === false &&
    draftCheck.payload?.environmentReady === false &&
    draftCheck.payload?.notificationUrlReady === false &&
    draftCheck.payload?.decisionPass === false,
  requiredScenarioCount: pass.payload?.requiredScenarioCount,
  noForbiddenSourcePhrases: sourceScan.ok,
  forbiddenSourceHits: sourceScan.hits,
};

console.log(JSON.stringify(summary, null, 2));

if (
  !summary.passFixtureAccepted ||
  !summary.failFixtureRejected ||
  !summary.partialFixtureRejected ||
  !summary.draftGenerated ||
  !summary.draftRejectedUntilManualChecks ||
  !summary.noForbiddenSourcePhrases
) {
  process.exitCode = 1;
}

function evidenceBlock({ environment = "sandbox", notificationUrl = "https://app.example.com/api/payments/apple/notifications", finalDecision = "pass", omitScenarioField = "", omitField = "" } = {}) {
  return [
    "# Apple IAP Acceptance Evidence",
    "",
    "Date: 2026-07-05",
    "Tester: QA Smoke",
    "Commit: abc1234",
    "Build source: TestFlight",
    "Bundle ID: app.ownminutes.mobile",
    `Environment: ${environment}`,
    `Public notification URL: ${notificationUrl}`,
    "Sandbox account: redacted tester account",
    "",
    ...scenarios.map(([scenario, product]) => scenarioBlock({ scenario, product, omitField: scenario === omitScenarioField ? omitField : "" })).flat(),
    `Decision: ${finalDecision}`,
    "Known issues: other release blockers remain",
    "",
  ].join("\n");
}

function scenarioBlock({ scenario, product, omitField }) {
  return [
    `## ${scenario}`,
    "",
    `Scenario: ${scenario}`,
    product ? `Apple product: ${product}` : "",
    "Transaction verification: pass",
    "Notification verification: pass",
    "Order ledger: pass",
    "Entitlement ledger: pass",
    "Duplicate handling: pass",
    "Plan result: pass",
    "Secrets leaked: no",
    "Decision: pass",
    "",
  ].filter((line) => line && (!omitField || !line.startsWith(omitField)));
}

function runChecker(path) {
  const result = spawnSync("node", ["scripts/check-apple-iap-acceptance-evidence.mjs"], {
    encoding: "utf8",
    env: {
      ...process.env,
      OWNMINUTES_IAP_ACCEPTANCE_EVIDENCE_PATH: path,
    },
  });

  return {
    status: result.status,
    payload: parseJson(result.stdout),
    output: `${result.stdout || ""}${result.stderr || ""}`,
  };
}

function runDraft(path) {
  const result = spawnSync("node", ["scripts/check-apple-iap-acceptance-evidence.mjs"], {
    encoding: "utf8",
    env: {
      ...process.env,
      OWNMINUTES_IAP_ACCEPTANCE_EVIDENCE_DRAFT_PATH: path,
    },
  });

  return {
    status: result.status,
    payload: parseJson(result.stdout),
    output: `${result.stdout || ""}${result.stderr || ""}`,
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
  const forbidden = ["-----BEGIN PRIVATE KEY-----", "signedPayload=", "real-signed-payload", "sandbox password", "App Store Connect cookie"];
  const result = spawnSync("rg", ["-n", forbidden.join("|"), "docs/apple-iap-sandbox-runbook.md"], { encoding: "utf8" });
  const hits = result.status === 0 ? result.stdout.trim().split("\n").filter(Boolean) : [];
  return { ok: hits.length === 0, hits };
}
