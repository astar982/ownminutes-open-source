#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const evidenceDraftPath = process.env.OWNMINUTES_IAP_ACCEPTANCE_EVIDENCE_DRAFT_PATH || "";
const evidencePath = evidenceDraftPath || process.env.OWNMINUTES_IAP_ACCEPTANCE_EVIDENCE_PATH || ".data/acceptance/apple-iap-latest.md";

const requiredMetadata = [
  "Date:",
  "Tester:",
  "Commit:",
  "Build source:",
  "Bundle ID:",
  "Environment:",
  "Public notification URL:",
  "Sandbox account:",
];

const scenarioRequirements = [
  { name: "Plus purchase", product: "ownminutes.plus.monthly" },
  { name: "Pro purchase", product: "ownminutes.pro.monthly" },
  { name: "Duplicate transaction idempotency" },
  { name: "DID_RENEW notification" },
  { name: "REFUND notification" },
  { name: "EXPIRED or REVOKE notification" },
  { name: "Database ledger" },
  { name: "Account plan rollback" },
];

const requiredFields = [
  "Scenario:",
  "Apple product:",
  "Transaction verification:",
  "Notification verification:",
  "Order ledger:",
  "Entitlement ledger:",
  "Duplicate handling:",
  "Plan result:",
  "Secrets leaked: no",
  "Decision: pass",
];

const forbiddenPhrases = [
  "-----BEGIN PRIVATE KEY-----",
  "signedPayload=",
  "real-signed-payload",
  "sandbox password",
  "App Store Connect cookie",
  "APPLE_PRIVATE_KEY=",
  "Bearer ",
  "session=",
  "AKL",
  "sk-proj",
  "Secret Access Key",
  "WVRCaE",
];

if (evidenceDraftPath) {
  mkdirSync(dirname(evidenceDraftPath), { recursive: true });
  writeFileSync(evidenceDraftPath, buildDraftEvidence());
}

const evidence = existsSync(evidencePath) ? readFileSync(evidencePath, "utf8") : "";

const missingMetadata = requiredMetadata.filter((phrase) => !evidence.includes(phrase));
const scenarioSections = getScenarioSections(evidence);
const scenarioChecks = scenarioRequirements.map((requirement) => {
  const section = scenarioSections.get(requirement.name) ?? "";
  const fields = requirement.product ? requiredFields : requiredFields.filter((field) => field !== "Apple product:");
  return {
    scenario: requirement.name,
    exists: Boolean(section),
    missingFields: fields.filter((field) => !section.includes(field)),
    productMatches: !requirement.product || section.includes(`Apple product: ${requirement.product}`),
    hasFailDecision: /Decision:\s*fail/i.test(section),
  };
});
const missingScenarios = scenarioChecks.filter((item) => !item.exists).map((item) => item.scenario);
const missingFieldsByScenario = scenarioChecks
  .filter((item) => item.exists && item.missingFields.length > 0)
  .map((item) => ({ scenario: item.scenario, missing: item.missingFields }));
const productMismatches = scenarioChecks.filter((item) => item.exists && !item.productMatches).map((item) => item.scenario);
const scenarioFailDecisions = scenarioChecks.filter((item) => item.hasFailDecision).map((item) => item.scenario);
const leakedPhrases = forbiddenPhrases.filter((phrase) => evidence.includes(phrase));
const environment = readLineValue("Environment:");
const notificationUrl = readLineValue("Public notification URL:");
const decisionPass = /Decision:\s*pass/i.test(evidence);
const decisionFail = /Decision:\s*fail/i.test(evidence);

const summary = {
  evidencePath,
  exists: Boolean(evidence),
  bytes: Buffer.byteLength(evidence),
  requiredScenarioCount: scenarioRequirements.length,
  missingMetadata,
  missingScenarios,
  missingFieldsByScenario,
  productMismatches,
  scenarioFailDecisions,
  environmentReady: ["sandbox", "testflight"].includes(environment.toLowerCase()),
  notificationUrlReady: isPublicHttpsUrl(notificationUrl),
  decisionPass,
  decisionFail,
  leakedPhrases,
  evidenceReady:
    Boolean(evidence) &&
    missingMetadata.length === 0 &&
    missingScenarios.length === 0 &&
    missingFieldsByScenario.length === 0 &&
    productMismatches.length === 0 &&
    scenarioFailDecisions.length === 0 &&
    ["sandbox", "testflight"].includes(environment.toLowerCase()) &&
    isPublicHttpsUrl(notificationUrl) &&
    decisionPass &&
    !decisionFail &&
    leakedPhrases.length === 0,
};

if (evidenceDraftPath) {
  console.log(
    JSON.stringify(
      {
        ...summary,
        evidenceDraftPath,
        draftWritten: true,
        draftDecision: "pending",
        draftNote:
          "Draft files are intentionally incomplete and must fail iap:acceptance:evidence until every pending field is replaced with real Apple sandbox/TestFlight purchase, notification, ledger, rollback, and public HTTPS evidence.",
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

console.log(JSON.stringify(summary, null, 2));

if (!summary.evidenceReady) {
  process.exitCode = 1;
}

function readLineValue(label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = evidence.match(new RegExp(`^${escaped}\\s*(.*)$`, "im"));
  return match?.[1]?.trim() ?? "";
}

function getScenarioSections(text) {
  const sections = new Map();
  const headingPattern = /^##\s+(.+)$/gm;
  const headings = Array.from(text.matchAll(headingPattern));

  headings.forEach((match, index) => {
    const name = match[1].trim();
    const start = match.index ?? 0;
    const next = headings[index + 1]?.index ?? text.length;
    sections.set(name, text.slice(start, next));
  });

  return sections;
}

function isPublicHttpsUrl(value) {
  if (!value) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && !["localhost", "127.0.0.1", "0.0.0.0", "::1"].includes(parsed.hostname);
  } catch {
    return false;
  }
}

function buildDraftEvidence() {
  return [
    "# Apple IAP Acceptance Evidence",
    "",
    "This file is an automated draft from `npm run iap:acceptance:evidence:draft`.",
    "Replace every `pending` value with real Apple sandbox/TestFlight evidence before running `npm run iap:acceptance:evidence` as a release gate.",
    "",
    "Date: pending",
    "Tester: pending",
    "Commit: pending",
    "Build source: pending",
    "Bundle ID: pending",
    "Environment: pending",
    "Public notification URL: pending",
    "Sandbox account: redacted pending",
    "",
    ...scenarioRequirements.map((requirement) => buildDraftScenario(requirement)).flat(),
    "Decision: pending",
    "Known issues: pending",
    "",
  ].join("\n");
}

function buildDraftScenario(requirement) {
  return [
    `## ${requirement.name}`,
    "",
    `Scenario: ${requirement.name}`,
    requirement.product ? `Apple product: ${requirement.product}` : "",
    "Transaction verification: pending",
    "Notification verification: pending",
    "Order ledger: pending",
    "Entitlement ledger: pending",
    "Duplicate handling: pending",
    "Plan result: pending",
    "Secrets leaked: pending",
    "Decision: pending",
    "",
  ].filter(Boolean);
}
