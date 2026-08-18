#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const runbookPath = path.join(process.cwd(), "docs", "recording-long-test-runbook.md");
const runbook = fs.existsSync(runbookPath) ? fs.readFileSync(runbookPath, "utf8") : "";

const requiredSections = [
  "## Current Boundary",
  "## Required Environment",
  "## Preflight",
  "## Test Matrix",
  "## Acceptance Metrics",
  "## Failure Criteria",
  "## Evidence Template",
  "## Commands",
  "## Rollback",
  "## Production Verification",
];

const requiredPhrases = [
  "npm run preview:screen",
  "npm run smoke:app",
  "npm run smoke:meetings",
  "npm run smoke:release",
  "npm run smoke:recording-runbook",
  "npm run smoke:recording-evidence",
  "npm run recording:acceptance:evidence",
  ".data/acceptance/recording-latest.md",
  "OWNMINUTES_RECORDING_ACCEPTANCE_EVIDENCE_PATH",
  "录音自检",
  "5 minutes",
  "30 minutes",
  "90 minutes",
  "Weak network",
  "Offline recovery",
  "Device interruption",
  "Background risk",
  "pending=0",
  "stats.chunks",
  "Chunks increasing",
  "Finalize result",
  "Obsidian Markdown",
  "Share link",
  "Retry/export state",
  "No secrets leaked",
  "No raw secret",
  "Public HTTPS app URL",
  "iPhone TestFlight build",
];

const forbiddenPhrases = ["AKL", "sk-proj", "Secret Access Key", "WVRCaE", "-----BEGIN PRIVATE KEY-----"];

const missingSections = requiredSections.filter((section) => !runbook.includes(section));
const missingPhrases = requiredPhrases.filter((phrase) => !runbook.includes(phrase));
const leakedPhrases = forbiddenPhrases.filter((phrase) => runbook.includes(phrase));

const summary = {
  exists: Boolean(runbook),
  sectionCount: requiredSections.length - missingSections.length,
  phraseCount: requiredPhrases.length - missingPhrases.length,
  missingSections,
  missingPhrases,
  leakedPhrases,
};

console.log(JSON.stringify(summary, null, 2));

if (!summary.exists || missingSections.length > 0 || missingPhrases.length > 0 || leakedPhrases.length > 0) {
  process.exitCode = 1;
}
