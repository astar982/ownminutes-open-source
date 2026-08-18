#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const runbookPath = path.join(process.cwd(), "docs", "asr-runtime-runbook.md");
const text = fs.existsSync(runbookPath) ? fs.readFileSync(runbookPath, "utf8") : "";

const requiredSections = [
  "## Current Boundary",
  "## Required Environment",
  "## Preflight",
  "## Configure ASR",
  "## Small Audio Verification",
  "## Meeting Verification",
  "## Quality Sampling",
  "## Realtime Boundary",
  "## Evidence Template",
  "## Failure Criteria",
  "## Rollback",
  "## Production Verification",
];

const requiredPhrases = [
  "VOLCANO_ASR_API_KEY",
  "VOLCANO_ASR_APP_ID",
  "VOLCANO_ASR_TOKEN",
  "ARK_API_KEY",
  "ARK_CHAT_MODEL",
  "ASR 小音频真实测试",
  "OWNMINUTES_ASR_SAMPLE_PATH",
  "npm run asr:sample",
  ".data/acceptance/asr-small-audio-latest.md",
  "npm run smoke:settings",
  "npm run smoke:asr",
  "npm run smoke:asr-acceptance",
  "npm run smoke:asr-acceptance-evidence",
  "OWNMINUTES_ASR_ACCEPTANCE_EVIDENCE_PATH=.data/acceptance/asr-latest.md",
  "OWNMINUTES_ASR_MEETING_BATCH_EVIDENCE_PATH=.data/acceptance/asr-meeting-batch-latest.json",
  "npm run asr:meeting-batch:collect",
  "npm run asr:meeting-batch:check",
  "npm run smoke:asr-meeting-batch",
  ".data/acceptance/asr-latest.md",
  "npm run smoke:meetings",
  "npm run smoke:release",
  "docs/asr-acceptance-evidence-template.md",
  "/api/release/readiness",
  "/api/account/provider-health",
  "file-asr",
  "summary-model",
  "object-storage",
  "secret-management",
  "public-url",
  "not_configured",
  "1-3 minute",
  "WebSocket protocol implemented",
  "No raw secret",
  "Secrets leaked: no/yes",
];

const forbiddenPhrases = [
  "AKL",
  "sk-proj",
  "Secret Access Key",
  "WVRCaE",
  "-----BEGIN PRIVATE KEY-----",
  "-----BEGIN EC PRIVATE KEY-----",
];

const missingSections = requiredSections.filter((section) => !text.includes(section));
const missingPhrases = requiredPhrases.filter((phrase) => !text.includes(phrase));
const leakedPhrases = forbiddenPhrases.filter((phrase) => text.includes(phrase));

const summary = {
  exists: fs.existsSync(runbookPath),
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
