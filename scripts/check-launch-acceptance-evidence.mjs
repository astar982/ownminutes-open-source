#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const evidencePath = process.env.OWNMINUTES_LAUNCH_ACCEPTANCE_EVIDENCE_PATH || ".data/acceptance/launch-latest.md";
const evidenceDraftPath = process.env.OWNMINUTES_LAUNCH_ACCEPTANCE_EVIDENCE_DRAFT_PATH?.trim() || "";
const evidence = existsSync(evidencePath) ? readFileSync(evidencePath, "utf8") : "";

const packs = [
  {
    id: "public-url",
    title: "Public HTTPS Deployment",
    expectedEvidence: ".data/acceptance/public-deployment-latest.md",
    expectedCommand: "OWNMINUTES_PUBLIC_DEPLOYMENT_EVIDENCE_PATH=.data/acceptance/public-deployment-latest.md npm run deployment:acceptance:evidence",
  },
  {
    id: "ios-testflight",
    title: "iOS TestFlight Recording",
    expectedEvidence: ".data/acceptance/ios-testflight-latest.md",
    expectedCommand: "OWNMINUTES_IOS_TESTFLIGHT_EVIDENCE_PATH=.data/acceptance/ios-testflight-latest.md npm run ios:testflight:evidence",
  },
  {
    id: "file-asr",
    title: "Post Meeting ASR",
    expectedEvidence: ".data/acceptance/asr-latest.md",
    expectedCommand: "OWNMINUTES_ASR_ACCEPTANCE_EVIDENCE_PATH=.data/acceptance/asr-latest.md npm run asr:acceptance:evidence",
  },
  {
    id: "realtime-asr",
    title: "Realtime ASR Boundary",
    expectedEvidence: ".data/acceptance/asr-latest.md",
    expectedCommand: "npm run smoke:mobile-realtime && OWNMINUTES_ASR_ACCEPTANCE_EVIDENCE_PATH=.data/acceptance/asr-latest.md npm run asr:acceptance:evidence",
  },
  {
    id: "speaker-diarization",
    title: "Speaker Diarization",
    expectedEvidence: ".data/acceptance/asr-latest.md",
    expectedCommand: "OWNMINUTES_ASR_ACCEPTANCE_EVIDENCE_PATH=.data/acceptance/asr-latest.md npm run asr:acceptance:evidence",
  },
  {
    id: "summary-model",
    title: "Summary Model",
    expectedEvidence: ".data/acceptance/summary-latest.md",
    expectedCommand: "OWNMINUTES_SUMMARY_EVIDENCE_PATH=.data/acceptance/summary-latest.md npm run summary:acceptance:evidence",
  },
  {
    id: "database",
    title: "Production PostgreSQL",
    expectedEvidence: ".data/acceptance/postgres-latest.md",
    expectedCommand: "OWNMINUTES_POSTGRES_EVIDENCE_PATH=.data/acceptance/postgres-latest.md npm run database:acceptance:evidence",
  },
  {
    id: "object-storage",
    title: "Private Object Storage",
    expectedEvidence: ".data/acceptance/object-storage-latest.md",
    expectedCommand: "OWNMINUTES_OBJECT_STORAGE_EVIDENCE_PATH=.data/acceptance/object-storage-latest.md npm run storage:acceptance:evidence",
  },
  {
    id: "secret-management",
    title: "Vault Secret Management",
    expectedEvidence: ".data/acceptance/secret-management-latest.md",
    expectedCommand:
      "OWNMINUTES_SECRET_EVIDENCE_PATH=.data/acceptance/secret-management-latest.md OWNMINUTES_VAULT_LIVE_EVIDENCE_PATH=.data/acceptance/vault-transit-live-latest.json npm run secret:acceptance:evidence",
  },
  {
    id: "payments",
    title: "Apple IAP Payments",
    expectedEvidence: ".data/acceptance/apple-iap-latest.md",
    expectedCommand: "OWNMINUTES_IAP_ACCEPTANCE_EVIDENCE_PATH=.data/acceptance/apple-iap-latest.md npm run iap:acceptance:evidence",
  },
];

const requiredTopLevelFields = [
  "Launch decision:",
  "Release commit:",
  "Reviewer:",
  "Evidence date:",
  "Secrets leaked:",
];

const forbiddenPhrases = [
  "AKL",
  "sk-proj",
  "Secret Access Key",
  "WVRCaE",
  "DATABASE_URL=",
  "OWNMINUTES_APP_SECRET=",
  "-----BEGIN PRIVATE KEY-----",
  "-----BEGIN EC PRIVATE KEY-----",
  "BEGIN OPENSSH PRIVATE KEY",
  "Bearer ",
  "session=",
];

if (evidenceDraftPath) {
  writeEvidenceDraft(evidenceDraftPath);
  console.log(
    JSON.stringify(
      {
        evidencePath,
        evidenceDraftPath,
        draftWritten: true,
        draftDecision: "pending",
        requiredPackCount: packs.length,
        draftNote:
          "Draft files are intentionally incomplete and must fail launch:acceptance:evidence until every pack references real private evidence and is manually marked pass.",
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

const missingTopLevelFields = requiredTopLevelFields.filter((field) => !evidence.includes(field));
const leakedPhrases = forbiddenPhrases.filter((phrase) => evidence.includes(phrase));
const launchDecision = readLineValue(evidence, "Launch decision:");
const topLevelSecrets = readLineValue(evidence, "Secrets leaked:");
const packResults = packs.map((pack) => inspectPack(pack, evidence));
const missingPacks = packResults.filter((pack) => !pack.present).map((pack) => pack.id);
const incompletePacks = packResults.filter((pack) => pack.present && !pack.ready).map((pack) => ({
  id: pack.id,
  missingFields: pack.missingFields,
  invalidFields: pack.invalidFields,
}));
const pendingMentions = collectPendingMentions(evidence);

const summary = {
  evidencePath,
  exists: Boolean(evidence),
  bytes: Buffer.byteLength(evidence),
  requiredPackCount: packs.length,
  readyPackCount: packResults.filter((pack) => pack.ready).length,
  missingTopLevelFields,
  missingPacks,
  incompletePacks,
  launchDecision,
  topLevelSecrets,
  pendingMentions,
  leakedPhrases,
  packResults,
  evidenceReady:
    Boolean(evidence) &&
    missingTopLevelFields.length === 0 &&
    launchDecision.toLowerCase() === "pass" &&
    topLevelSecrets.toLowerCase() === "no" &&
    missingPacks.length === 0 &&
    incompletePacks.length === 0 &&
    pendingMentions.length === 0 &&
    leakedPhrases.length === 0,
};

console.log(JSON.stringify(summary, null, 2));

if (!summary.evidenceReady) {
  process.exitCode = 1;
}

function inspectPack(pack, text) {
  const section = readSection(text, pack.title);
  if (!section) {
    return {
      id: pack.id,
      title: pack.title,
      present: false,
      ready: false,
      missingFields: ["section"],
      invalidFields: [],
    };
  }

  const values = {
    blockerId: readLineValue(section, "Blocker ID:"),
    evidenceFile: readLineValue(section, "Evidence file:"),
    verificationCommand: readLineValue(section, "Verification command:"),
    evidenceDate: readLineValue(section, "Evidence date:"),
    reviewer: readLineValue(section, "Reviewer:"),
    decision: readLineValue(section, "Decision:"),
    secretsLeaked: readLineValue(section, "Secrets leaked:"),
  };
  const missingFields = Object.entries(values)
    .filter(([, value]) => !value)
    .map(([key]) => key);
  const invalidFields = [
    values.blockerId === pack.id ? "" : "blockerId",
    values.evidenceFile === pack.expectedEvidence ? "" : "evidenceFile",
    values.verificationCommand.includes(pack.expectedCommand) ? "" : "verificationCommand",
    isConcreteDate(values.evidenceDate) ? "" : "evidenceDate",
    isConcreteValue(values.reviewer) ? "" : "reviewer",
    values.decision.toLowerCase() === "pass" ? "" : "decision",
    values.secretsLeaked.toLowerCase() === "no" ? "" : "secretsLeaked",
    hasLocalhostForLaunchPack(pack.id, section) ? "local-or-lan-url" : "",
  ].filter(Boolean);

  return {
    id: pack.id,
    title: pack.title,
    present: true,
    ready: missingFields.length === 0 && invalidFields.length === 0,
    evidenceFile: values.evidenceFile,
    missingFields,
    invalidFields,
  };
}

function readSection(text, title) {
  const escaped = title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = text.match(new RegExp(`(?:^|\\n)##\\s+${escaped}\\s*\\n([\\s\\S]*?)(?=\\n##\\s+|$)`, "i"));
  return match?.[1]?.trim() ?? "";
}

function readLineValue(text, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = text.match(new RegExp(`^[-*]?\\s*${escaped}\\s*(.*)$`, "im"));
  return match?.[1]?.trim() ?? "";
}

function isConcreteDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !value.includes("0000");
}

function isConcreteValue(value) {
  return Boolean(value) && !/pending|todo|tbd|待定|待补/i.test(value);
}

function collectPendingMentions(text) {
  return text
    .split(/\r?\n/)
    .map((line, index) => ({ line: index + 1, text: line.trim() }))
    .filter((item) => /\bpending\b|todo|tbd|待定|待补/i.test(item.text))
    .slice(0, 30);
}

function hasLocalhostForLaunchPack(id, section) {
  if (!["public-url", "ios-testflight"].includes(id)) return false;
  return /(localhost|127\.0\.0\.1|0\.0\.0\.0|192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/i.test(section);
}

function writeEvidenceDraft(path) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, buildEvidenceDraft());
}

function buildEvidenceDraft() {
  return [
    "# OwnMinutes Launch Acceptance Evidence",
    "",
    "This file is an automated draft from `npm run launch:acceptance:evidence:draft`.",
    "Replace every `pending` value with real private evidence before running `npm run launch:acceptance:evidence` as the final launch gate.",
    "",
    "Launch decision: pending",
    "Release commit: pending",
    "Reviewer: pending",
    `Evidence date: ${new Date().toISOString().slice(0, 10)}`,
    "Secrets leaked: pending",
    "",
    ...packs.flatMap((pack) => [
      `## ${pack.title}`,
      "",
      `Blocker ID: ${pack.id}`,
      `Evidence file: ${pack.expectedEvidence}`,
      `Verification command: ${pack.expectedCommand}`,
      "Evidence date: pending",
      "Reviewer: pending",
      "Decision: pending",
      "Secrets leaked: pending",
      "Notes: pending",
      "",
    ]),
  ].join("\n");
}
