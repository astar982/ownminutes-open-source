#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const evidencePath = process.env.OWNMINUTES_SUMMARY_EVIDENCE_PATH || ".data/acceptance/summary-latest.md";
const evidenceDraftPath = process.env.OWNMINUTES_SUMMARY_EVIDENCE_DRAFT_PATH?.trim() || "";
const evidence = existsSync(evidencePath) ? readFileSync(evidencePath, "utf8") : "";

const requiredMetadata = [
  "Date:",
  "Commit:",
  "Summary provider:",
  "Model:",
  "Transcript source:",
  "Transcript language:",
  "Transcript duration:",
  "Transcript quality:",
  "Transcript sample count:",
  "Grounding sample count:",
  "JSON schema:",
  "Hallucination policy:",
  "Low confidence policy:",
  "Human reviewer:",
  "Markdown output:",
  "Share output:",
  "Release readiness summaryModelBlocked:",
  "Release readiness nextAction:",
];

const requiredPassChecks = [
  "Production preflight:",
  "Summary structure smoke:",
  "Transcript quality gate:",
  "Real model generation:",
  "JSON parse:",
  "Schema validation:",
  "Field coverage:",
  "Summary grounded:",
  "Topics grounded:",
  "Speaker views grounded:",
  "Decisions grounded:",
  "Action items grounded:",
  "Risks grounded:",
  "Open questions grounded:",
  "Knowledge points grounded:",
  "Citation samples recorded:",
  "Low confidence handled:",
  "Uncertain claims labelled:",
  "No unsupported claims:",
  "No placeholder transcript used:",
  "No fallback summary presented as verified:",
  "Markdown generated:",
  "Share page quality notice:",
  "Human review completed:",
  "Repeat generation stable:",
  "Repeat generation delta within threshold:",
];

const forbiddenPhrases = [
  "AKL",
  "sk-proj",
  "Secret Access Key",
  "WVRCaE",
  "ARK_API_KEY=",
  "OPENAI_API_KEY=",
  "Bearer ",
  "session=",
  "-----BEGIN PRIVATE KEY-----",
  "-----BEGIN EC PRIVATE KEY-----",
];

const missingMetadata = requiredMetadata.filter((phrase) => !evidence.includes(phrase));
const missingPassChecks = requiredPassChecks.filter((phrase) => !lineHasValue(phrase, "pass"));
const failedChecks = requiredPassChecks.filter((phrase) => lineHasValue(phrase, "fail"));
const leakedPhrases = forbiddenPhrases.filter((phrase) => evidence.includes(phrase));

const provider = readLineValue("Summary provider:");
const language = readLineValue("Transcript language:");
const duration = readLineValue("Transcript duration:");
const transcriptQuality = readLineValue("Transcript quality:");
const transcriptSampleCount = readLineValue("Transcript sample count:");
const groundingSampleCount = readLineValue("Grounding sample count:");
const releaseSummaryBlocked = readLineValue("Release readiness summaryModelBlocked:");
const releaseNextAction = readLineValue("Release readiness nextAction:");

const providerFailure = ["volcano-ark", "openai", "managed"].includes(provider.toLowerCase()) ? "" : "provider-not-real-model";
const languageFailure = language.includes("中文") || language.toLowerCase().includes("mandarin") ? "" : "language-not-mandarin-or-chinese";
const durationFailure = hasPositiveDuration(duration) ? "" : "duration-not-positive";
const transcriptQualityFailure = ["usable", "pass", "verified"].includes(transcriptQuality.toLowerCase()) ? "" : "transcript-quality-not-usable";
const transcriptSampleFailure = hasMinimumCount(transcriptSampleCount, 3) ? "" : "transcript-sample-count-too-low";
const groundingSampleFailure = hasMinimumCount(groundingSampleCount, 5) ? "" : "grounding-sample-count-too-low";
const releaseFailures = [
  ["no", "false"].includes(releaseSummaryBlocked.toLowerCase()) ? "" : "summaryModelBlocked-not-cleared",
  releaseNextAction.length > 0 ? "" : "nextAction-missing",
].filter(Boolean);

const decisionPass = lineHasValue("Decision:", "pass");
const decisionFail = lineHasValue("Decision:", "fail");
const secretsLeakedNo = lineHasValue("Secrets leaked:", "no");
const secretsLeakedYes = lineHasValue("Secrets leaked:", "yes");

const summary = {
  evidencePath,
  exists: Boolean(evidence),
  bytes: Buffer.byteLength(evidence),
  missingMetadata,
  missingPassChecks,
  failedChecks,
  providerFailure,
  languageFailure,
  durationFailure,
  transcriptQualityFailure,
  transcriptSampleFailure,
  groundingSampleFailure,
  releaseFailures,
  decisionPass,
  decisionFail,
  secretsLeakedNo,
  secretsLeakedYes,
  leakedPhrases,
  evidenceReady:
    Boolean(evidence) &&
    missingMetadata.length === 0 &&
    missingPassChecks.length === 0 &&
    failedChecks.length === 0 &&
    !providerFailure &&
    !languageFailure &&
    !durationFailure &&
    !transcriptQualityFailure &&
    !transcriptSampleFailure &&
    !groundingSampleFailure &&
    releaseFailures.length === 0 &&
    decisionPass &&
    !decisionFail &&
    secretsLeakedNo &&
    !secretsLeakedYes &&
    leakedPhrases.length === 0,
};

if (evidenceDraftPath) {
  writeEvidenceDraft(evidenceDraftPath);
  console.log(
    JSON.stringify(
      {
        ...summary,
        evidenceDraftPath,
        draftWritten: true,
        draftDecision: "pending",
        draftNote:
          "Draft files are intentionally incomplete and must fail summary:acceptance:evidence until every pending field is replaced with real model, transcript quality, grounding, repeatability, share, and Markdown evidence.",
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

function lineHasValue(label, value) {
  return readLineValue(label).toLowerCase() === value.toLowerCase();
}

function hasPositiveDuration(value) {
  const match = value.match(/(\d+(?:\.\d+)?)/);
  return Boolean(match && Number(match[1]) > 0);
}

function hasMinimumCount(value, minimum) {
  const match = value.match(/(\d+)/);
  return Boolean(match && Number(match[1]) >= minimum);
}

function writeEvidenceDraft(path) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, buildEvidenceDraft());
}

function buildEvidenceDraft() {
  const values = {
    Date: new Date().toISOString().slice(0, 10),
    Commit: "pending",
    "Summary provider": "pending",
    Model: "pending",
    "Transcript source": "pending",
    "Transcript language": "pending",
    "Transcript duration": "pending",
    "Transcript quality": "pending",
    "Transcript sample count": "pending",
    "Grounding sample count": "pending",
    "JSON schema": "pending",
    "Hallucination policy": "pending",
    "Low confidence policy": "pending",
    "Human reviewer": "pending",
    "Markdown output": "pending",
    "Share output": "pending",
    "Release readiness summaryModelBlocked": "pending",
    "Release readiness nextAction": "pending",
    "Production preflight": "pending",
    "Summary structure smoke": "pending",
    "Transcript quality gate": "pending",
    "Real model generation": "pending",
    "JSON parse": "pending",
    "Schema validation": "pending",
    "Field coverage": "pending",
    "Summary grounded": "pending",
    "Topics grounded": "pending",
    "Speaker views grounded": "pending",
    "Decisions grounded": "pending",
    "Action items grounded": "pending",
    "Risks grounded": "pending",
    "Open questions grounded": "pending",
    "Knowledge points grounded": "pending",
    "Citation samples recorded": "pending",
    "Low confidence handled": "pending",
    "Uncertain claims labelled": "pending",
    "No unsupported claims": "pending",
    "No placeholder transcript used": "pending",
    "No fallback summary presented as verified": "pending",
    "Markdown generated": "pending",
    "Share page quality notice": "pending",
    "Human review completed": "pending",
    "Repeat generation stable": "pending",
    "Repeat generation delta within threshold": "pending",
    "Secrets leaked": "pending",
    Decision: "pending",
    "Known issues": "pending",
  };

  return [
    "# Summary Acceptance Evidence",
    "",
    "This file is an automated draft from `npm run summary:acceptance:evidence:draft`.",
    "Replace every `pending` value with real model, transcript quality, grounding, repeatability, share, and Markdown evidence before running `npm run summary:acceptance:evidence` as a release gate.",
    "",
    ...Object.entries(values).map(([key, value]) => `${key}: ${value}`),
    "",
    "## Grounding Samples",
    "",
    "| Field | Transcript evidence reference | Model output reference | Decision |",
    "|---|---|---|---|",
    "| Summary | pending | pending | pending |",
    "| Topics | pending | pending | pending |",
    "| Speaker views | pending | pending | pending |",
    "| Decisions | pending | pending | pending |",
    "| Action items | pending | pending | pending |",
    "",
    "## Repeat Generation",
    "",
    "Run 1 output id: pending",
    "Run 2 output id: pending",
    "Delta threshold: pending",
    "Observed delta: pending",
    "",
  ].join("\n");
}
