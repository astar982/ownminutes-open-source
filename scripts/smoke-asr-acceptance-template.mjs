#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const templatePath = path.join(process.cwd(), "docs", "asr-acceptance-evidence-template.md");
const text = fs.existsSync(templatePath) ? fs.readFileSync(templatePath, "utf8") : "";

const requiredSections = [
  "## Decision",
  "## Provider",
  "## Small Audio Test",
  "## Meeting Test",
  "## Speaker Diarization",
  "## Quality Sampling",
  "## Required Commands",
  "## Failure Notes",
];

const requiredPhrases = [
  "Do not commit real audio",
  "Do not commit real audio, raw customer transcripts, provider secrets",
  ".data/acceptance/asr-latest.md",
  "OWNMINUTES_ASR_ACCEPTANCE_EVIDENCE_PATH=.data/acceptance/asr-latest.md npm run asr:acceptance:evidence",
  "Result status: not_configured / preflight_pass / submitted / transcribed / completed_empty / failed",
  "Verification level: none / preflight / submit / transcript",
  "Passing rule: ASR recognition quality is accepted only when result status is `transcribed`",
  "Formal transcript fallback-only: no / yes",
  "Transcript quality: usable / low_confidence / empty",
  "Speaker diarization: pass / fail / not_applicable",
  "Speaker labels distinguish major turns: yes / no / not_applicable",
  "Speaker rename workflow verified: yes / no",
  "Speaker segment assignment correction verified: yes / no",
  "Action item speaker assignment: pass / fail / not_applicable",
  "Passing rule: meeting acceptance requires non-fallback formal transcript",
  "speaker diarization evidence for any multi-speaker scenario",
  "Speaker labels present in formal transcript: yes / no",
  "Speaker rename/edit workflow available: yes / no",
  "Incorrect transcript segment reassignment verified: yes / no",
  "Renamed speakers reflected in summary/share/Markdown: yes / no",
  "Known limitation notice shown to user: yes / no",
  "Owner assignment fallback when speaker is uncertain: pass / fail",
  "the product does not claim 100% single-device speaker accuracy",
  "Mandarin near-field single speaker",
  "Mandarin two speakers alternating",
  "Speaker diarization sampling",
  "Meeting-room multi-speaker discussion",
  "Overlapping speech / interruption",
  "Meeting-room far-field speech",
  "Mild noise",
  "Accented speaker",
  "npm run smoke:settings",
  "npm run smoke:asr",
  "npm run smoke:transcript-quality",
  "npm run smoke:meetings",
  "npm run smoke:release",
  "npm run smoke:asr-acceptance-evidence",
  "Secrets leaked: no / yes",
];

const forbiddenPhrases = [
  "AKL",
  "WVRCaE",
  "sk-proj",
  "Secret Access Key",
  "-----BEGIN PRIVATE KEY-----",
  "-----BEGIN EC PRIVATE KEY-----",
];

const missingSections = requiredSections.filter((section) => !text.includes(section));
const missingPhrases = requiredPhrases.filter((phrase) => !text.includes(phrase));
const leakedPhrases = forbiddenPhrases.filter((phrase) => text.includes(phrase));

const summary = {
  exists: fs.existsSync(templatePath),
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
