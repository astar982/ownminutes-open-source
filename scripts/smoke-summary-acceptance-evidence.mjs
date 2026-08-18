#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { spawnSync } from "node:child_process";

const passPath = ".data/smoke/summary-evidence-pass.md";
const failPath = ".data/smoke/summary-evidence-fail.md";
const partialPath = ".data/smoke/summary-evidence-partial.md";
const draftPath = ".data/smoke/summary-evidence-draft.md";

const passEvidence = evidenceBlock();
const failEvidence = evidenceBlock({
  overrides: {
    "Summary provider": "mock",
    "Transcript language": "English",
    "Transcript duration": "0 minutes",
    "Transcript quality": "fallback",
    "Transcript sample count": "0",
    "Grounding sample count": "0",
    Decision: "fail",
  },
  extraLines: ["ARK_API_KEY=ark-live-key-example"],
});
const partialEvidence = evidenceBlock({
  overrides: {
    "No unsupported claims": "fail",
  },
});

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
    fail.payload?.providerFailure === "provider-not-real-model" &&
    fail.payload?.languageFailure === "language-not-mandarin-or-chinese" &&
    fail.payload?.durationFailure === "duration-not-positive" &&
    fail.payload?.transcriptQualityFailure === "transcript-quality-not-usable" &&
    fail.payload?.transcriptSampleFailure === "transcript-sample-count-too-low" &&
    fail.payload?.groundingSampleFailure === "grounding-sample-count-too-low" &&
    fail.payload?.decisionFail === true &&
    fail.payload?.leakedPhrases?.includes("ARK_API_KEY="),
  partialFixtureRejected:
    partial.status !== 0 &&
    partial.payload?.evidenceReady === false &&
    partial.payload?.missingPassChecks?.includes("No unsupported claims:") &&
    partial.payload?.failedChecks?.includes("No unsupported claims:"),
  draftGenerated:
    draft.status === 0 &&
    draft.payload?.draftWritten === true &&
    draft.payload?.draftDecision === "pending" &&
    readDraft(draftPath).includes("This file is an automated draft from `npm run summary:acceptance:evidence:draft`.") &&
    readDraft(draftPath).includes("Summary provider: pending") &&
    readDraft(draftPath).includes("Grounding Samples") &&
    readDraft(draftPath).includes("Decision: pending"),
  draftRejectedUntilManualChecks:
    draftCheck.status !== 0 &&
    draftCheck.payload?.evidenceReady === false &&
    draftCheck.payload?.providerFailure === "provider-not-real-model" &&
    draftCheck.payload?.languageFailure === "language-not-mandarin-or-chinese" &&
    draftCheck.payload?.missingPassChecks?.includes("Production preflight:") &&
    draftCheck.payload?.decisionPass === false,
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

function evidenceBlock({ overrides = {}, extraLines = [] } = {}) {
  const values = {
    Date: "2026-07-05",
    Commit: "abc1234",
    "Summary provider": "volcano-ark",
    Model: "doubao-pro",
    "Transcript source": "verified file ASR transcript",
    "Transcript language": "中文普通话",
    "Transcript duration": "3 minutes",
    "Transcript quality": "usable",
    "Transcript sample count": "3",
    "Grounding sample count": "5",
    "JSON schema": "summary/topics/speaker_views/decisions/action_items/risks/open_questions/knowledge_points/obsidian_markdown",
    "Hallucination policy": "unsupported claims labelled uncertain or removed",
    "Low confidence policy": "low-confidence transcript spans are labelled uncertain and excluded from decisions",
    "Human reviewer": "reviewer id recorded privately",
    "Markdown output": "pass",
    "Share output": "pass",
    "Release readiness summaryModelBlocked": "no",
    "Release readiness nextAction": "Continue ASR and TestFlight evidence.",
    "Production preflight": "pass",
    "Summary structure smoke": "pass",
    "Transcript quality gate": "pass",
    "Real model generation": "pass",
    "JSON parse": "pass",
    "Schema validation": "pass",
    "Field coverage": "pass",
    "Summary grounded": "pass",
    "Topics grounded": "pass",
    "Speaker views grounded": "pass",
    "Decisions grounded": "pass",
    "Action items grounded": "pass",
    "Risks grounded": "pass",
    "Open questions grounded": "pass",
    "Knowledge points grounded": "pass",
    "Citation samples recorded": "pass",
    "Low confidence handled": "pass",
    "Uncertain claims labelled": "pass",
    "No unsupported claims": "pass",
    "No placeholder transcript used": "pass",
    "No fallback summary presented as verified": "pass",
    "Markdown generated": "pass",
    "Share page quality notice": "pass",
    "Human review completed": "pass",
    "Repeat generation stable": "pass",
    "Repeat generation delta within threshold": "pass",
    "Secrets leaked": "no",
    Decision: "pass",
    "Known issues": "other release blockers remain",
    ...overrides,
  };

  return [
    "# Summary Acceptance Evidence",
    "",
    ...Object.entries(values).map(([key, value]) => `${key}: ${value}`),
    ...extraLines,
    "",
  ].join("\n");
}

function runChecker(path) {
  const result = spawnSync("node", ["scripts/check-summary-acceptance-evidence.mjs"], {
    encoding: "utf8",
    env: {
      ...process.env,
      OWNMINUTES_SUMMARY_EVIDENCE_PATH: path,
    },
  });

  return {
    status: result.status,
    output: `${result.stdout || ""}${result.stderr || ""}`.trim(),
    payload: parseJson(result.stdout),
  };
}

function runDraft(path) {
  const result = spawnSync("node", ["scripts/check-summary-acceptance-evidence.mjs"], {
    encoding: "utf8",
    env: {
      ...process.env,
      OWNMINUTES_SUMMARY_EVIDENCE_DRAFT_PATH: path,
    },
  });

  return {
    status: result.status,
    output: `${result.stdout || ""}${result.stderr || ""}`.trim(),
    payload: parseJson(result.stdout),
  };
}

function readDraft(path) {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function runForbiddenSourceScan() {
  const forbidden = ["AKL", "sk-proj", "Secret Access Key", "WVRCaE", "ark-live-key"];
  const result = spawnSync("rg", ["-n", forbidden.join("|"), "docs/asr-runtime-runbook.md"], {
    encoding: "utf8",
  });
  const hits = result.status === 0 ? result.stdout.trim().split("\n").filter(Boolean) : [];
  return {
    ok: hits.length === 0,
    hits,
  };
}
