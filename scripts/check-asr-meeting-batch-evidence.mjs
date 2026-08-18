#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { validateAsrMeetingBatchEvidence } from "./lib/asr-meeting-batch-evidence.mjs";

const evidencePath = path.resolve(process.env.OWNMINUTES_ASR_MEETING_BATCH_EVIDENCE_PATH || ".data/acceptance/asr-meeting-batch-latest.json");

if (!fs.existsSync(evidencePath)) {
  console.log(JSON.stringify({
    ok: false,
    decision: "fail",
    evidencePath,
    errors: ["Structured real-meeting ASR batch evidence does not exist."],
    nextAction: "Run npm run asr:meeting-batch:collect with a private real-meeting plan.",
  }, null, 2));
  process.exit(1);
}

let evidence;
try {
  evidence = JSON.parse(fs.readFileSync(evidencePath, "utf8"));
} catch {
  console.log(JSON.stringify({ ok: false, decision: "fail", evidencePath, errors: ["Evidence is not valid JSON."] }, null, 2));
  process.exit(1);
}

const validation = validateAsrMeetingBatchEvidence(evidence);
if ((fs.statSync(evidencePath).mode & 0o077) !== 0) {
  validation.ok = false;
  validation.decision = "fail";
  validation.errors.push("Structured evidence must not be group/world accessible.");
}
const summary = {
  ...validation,
  evidencePath,
  sampleCount: Array.isArray(evidence.samples) ? evidence.samples.length : 0,
  rawTranscriptStoredInStructuredEvidence: false,
};

console.log(JSON.stringify(summary, null, 2));
if (!summary.ok) process.exitCode = 1;
