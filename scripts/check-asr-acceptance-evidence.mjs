#!/usr/bin/env node

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { validateAsrMeetingBatchEvidence } from "./lib/asr-meeting-batch-evidence.mjs";

const evidencePath = process.env.OWNMINUTES_ASR_ACCEPTANCE_EVIDENCE_PATH || ".data/acceptance/asr-latest.md";
const evidenceDraftPath = process.env.OWNMINUTES_ASR_ACCEPTANCE_EVIDENCE_DRAFT_PATH?.trim() || "";
const evidence = existsSync(evidencePath) ? readFileSync(evidencePath, "utf8") : "";
const meetingBatchEvidencePath = process.env.OWNMINUTES_ASR_MEETING_BATCH_EVIDENCE_PATH || ".data/acceptance/asr-meeting-batch-latest.json";
const meetingBatchEvidence = readJsonFile(meetingBatchEvidencePath);
const meetingBatchValidation = validateAsrMeetingBatchEvidence(meetingBatchEvidence);

const requiredSections = [
  "## Decision",
  "## Provider",
  "## Small Audio Test",
  "## Meeting Test",
  "## Speaker Diarization",
  "## Quality Sampling",
  "## Structured Meeting Batch",
];

const requiredFields = [
  "Date:",
  "Tester:",
  "Environment:",
  "App URL:",
  "API URL:",
  "ASR provider:",
  "Credential type:",
  "Runtime source:",
  "Provider health: file_asr ready",
  "Result status: transcribed",
  "Verification level: transcript",
  "Expected phrase readable: yes",
  "Formal transcript fallback-only: no",
  "Realtime draft clearly labeled: yes",
  "Realtime draft not published as formal transcript: yes",
  "Post-meeting transcript reprocessed from full audio: yes",
  "Post-meeting transcript quality better than realtime draft: yes",
  "Final summary uses post-meeting transcript: yes",
  "Transcript quality: usable",
  "Speaker rename workflow verified: yes",
  "Speaker segment assignment correction verified: yes",
  "Summary quality: pass",
  "Decisions grounded in transcript: yes",
  "Action items grounded in transcript: yes",
  "Share link: pass",
  "Obsidian Markdown: pass",
  "Secrets leaked: no",
  "Multi-speaker sample used: yes",
  "Speaker labels present in formal transcript: yes",
  "Speaker label review completed: yes",
  "Speaker rename/edit workflow available: yes",
  "Incorrect transcript segment reassignment verified: yes",
  "Renamed speakers reflected in summary/share/Markdown: yes",
  "Renamed speakers reflected in action item owners: yes",
  "Known limitation notice shown to user: yes",
  "Owner assignment fallback when speaker is uncertain: pass",
];

const requiredScenarios = [
  "Mandarin near-field single speaker",
  "Mandarin two speakers alternating",
  "Meeting-room far-field speech",
  "Mild noise",
  "Accented speaker",
  "Meeting-room multi-speaker discussion",
  "Overlapping speech / interruption",
];

const forbiddenPhrases = [
  "AKL",
  "sk-proj",
  "Secret Access Key",
  "WVRCaE",
  "-----BEGIN PRIVATE KEY-----",
  "Bearer ",
  "session=",
  "BEGIN OPENSSH PRIVATE KEY",
];

const missingSections = requiredSections.filter((phrase) => !evidence.includes(phrase));
const missingFields = requiredFields.filter((phrase) => !evidence.includes(phrase));
const missingScenarios = requiredScenarios.filter((phrase) => !evidence.includes(phrase));
const leakedPhrases = forbiddenPhrases.filter((phrase) => evidence.includes(phrase));
const passDecisionCount = countMatches(evidence, /Decision:\s*pass/gi);
const failDecisionCount = countMatches(evidence, /Decision:\s*fail/gi);
const hasUsableSamplingRows =
  countMatches(evidence, /\|\s*[^|\n]+\s*\|\s*[^|\n]+\s*\|\s*usable\s*\|\s*pass\s*\|\s*pass\s*\|\s*pass\s*\|/gi) >= 5;
const hasSpeakerSamplingRows =
  countMatches(evidence, /\|\s*[^|\n]+\s*\|\s*yes\s*\|\s*yes\s*\|\s*pass\s*\|\s*yes\s*\|\s*pass\s*\|/gi) >= 3;
const hasRealtimeBoundaryRows =
  countMatches(evidence, /\|\s*[^|\n]+\s*\|\s*draft\s*\|\s*formal\s*\|\s*yes\s*\|\s*yes\s*\|\s*pass\s*\|/gi) >= 2;

const summary = {
  evidencePath,
  exists: Boolean(evidence),
  bytes: Buffer.byteLength(evidence),
  passDecisionCount,
  failDecisionCount,
  hasUsableSamplingRows,
  hasSpeakerSamplingRows,
  hasRealtimeBoundaryRows,
  meetingBatchEvidencePath,
  meetingBatchReady: meetingBatchValidation.ok,
  meetingBatchErrors: meetingBatchValidation.errors,
  meetingBatchSampleCount: meetingBatchValidation.sampleCount,
  meetingBatchCoveredScenarios: meetingBatchValidation.coveredScenarios,
  meetingBatchTotalDurationSeconds: meetingBatchValidation.totalDurationSeconds,
  missingSections,
  missingFields,
  missingScenarios,
  leakedPhrases,
  evidenceReady:
    Boolean(evidence) &&
    missingSections.length === 0 &&
    missingFields.length === 0 &&
    missingScenarios.length === 0 &&
    leakedPhrases.length === 0 &&
    passDecisionCount >= 3 &&
    failDecisionCount === 0 &&
    hasUsableSamplingRows &&
    hasSpeakerSamplingRows &&
    hasRealtimeBoundaryRows &&
    meetingBatchValidation.ok,
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
          "Draft files are intentionally incomplete and must fail asr:acceptance:evidence until every pending field is replaced and the structured real-meeting batch evidence passes.",
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

function countMatches(text, pattern) {
  return Array.from(text.matchAll(pattern)).length;
}

function readJsonFile(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function writeEvidenceDraft(path) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, buildEvidenceDraft());
}

function buildEvidenceDraft() {
  return [
    "# ASR Acceptance Evidence",
    "",
    "This file is an automated draft from `npm run asr:acceptance:evidence:draft`.",
    "Replace every `pending` value with real ASR, speaker diarization, realtime boundary, share, and Markdown evidence before running `npm run asr:acceptance:evidence` as a release gate.",
    "",
    "## Decision",
    "",
    `- Date: ${new Date().toISOString().slice(0, 10)}`,
    "- Tester: pending",
    "- Environment: pending",
    "- App URL: pending",
    "- API URL: pending",
    "- Decision: pending",
    "- Reason: pending",
    "",
    "## Provider",
    "",
    "- ASR provider: pending",
    "- Credential type: pending",
    "- Summary provider: pending",
    "- Runtime source: pending",
    "- Provider health: pending",
    "- Release readiness before test: pending",
    "- Release readiness after test: pending",
    "",
    "## Small Audio Test",
    "",
    "- Test path: pending",
    "- Mode: pending",
    "- Result status: pending",
    "- Verification level: pending",
    "- Provider request id: pending",
    "- Sample type: pending",
    "- Sample duration: pending",
    "- Sample language: pending",
    "- Transcript preview: pending",
    "- Expected phrase: pending",
    "- Expected phrase readable: pending",
    "- Secrets leaked: pending",
    "- Decision: pending",
    "",
    "## Meeting Test",
    "",
    "- Meeting ID: pending",
    "- Duration: pending",
    "- Scenario: pending",
    "- Formal transcript fallback-only: pending",
    "- Realtime draft clearly labeled: pending",
    "- Realtime draft not published as formal transcript: pending",
    "- Post-meeting transcript reprocessed from full audio: pending",
    "- Post-meeting transcript quality better than realtime draft: pending",
    "- Final summary uses post-meeting transcript: pending",
    "- Transcript quality: pending",
    "- Speaker diarization: pending",
    "- Speaker labels distinguish major turns: pending",
    "- Speaker rename workflow verified: pending",
    "- Speaker segment assignment correction verified: pending",
    "- Action item speaker assignment: pending",
    "- Summary quality: pending",
    "- Decisions grounded in transcript: pending",
    "- Action items grounded in transcript: pending",
    "- Share link: pending",
    "- Obsidian Markdown: pending",
    "- Secrets leaked: pending",
    "- Decision: pending",
    "",
    "## Speaker Diarization",
    "",
    "- Multi-speaker sample used: pending",
    "- Speaker labels present in formal transcript: pending",
    "- Speaker label review completed: pending",
    "- Speaker rename/edit workflow available: pending",
    "- Incorrect transcript segment reassignment verified: pending",
    "- Renamed speakers reflected in summary/share/Markdown: pending",
    "- Renamed speakers reflected in action item owners: pending",
    "- Known limitation notice shown to user: pending",
    "- Owner assignment fallback when speaker is uncertain: pending",
    "- Decision: pending",
    "",
    "## Quality Sampling",
    "",
    "| Scenario | Duration | Transcript quality | Summary quality | Action item quality | Decision |",
    "|---|---:|---|---|---|---|",
    "| Mandarin near-field single speaker | pending | pending | pending | pending | pending |",
    "| Mandarin two speakers alternating | pending | pending | pending | pending | pending |",
    "| Meeting-room far-field speech | pending | pending | pending | pending | pending |",
    "| Mild noise | pending | pending | pending | pending | pending |",
    "| Accented speaker | pending | pending | pending | pending | pending |",
    "",
    "Speaker diarization sampling:",
    "",
    "| Scenario | Speaker labels distinguishable | Rename workflow | Owner assignment | Limitation notice | Decision |",
    "|---|---|---|---|---|---|",
    "| Mandarin two speakers alternating | pending | pending | pending | pending | pending |",
    "| Meeting-room multi-speaker discussion | pending | pending | pending | pending | pending |",
    "| Overlapping speech / interruption | pending | pending | pending | pending | pending |",
    "",
    "Realtime vs post-meeting boundary:",
    "",
    "| Scenario | Realtime result | Final result | Final reprocessed full audio | Realtime not published as formal | Decision |",
    "|---|---|---|---|---|---|",
    "| Mandarin two speakers alternating | pending | pending | pending | pending | pending |",
    "| Meeting-room multi-speaker discussion | pending | pending | pending | pending | pending |",
    "",
    "## Structured Meeting Batch",
    "",
    `- Evidence path: ${meetingBatchEvidencePath}`,
    "- Real 2-4 person samples: pending",
    "- Total qualifying duration: pending",
    "- Required scenario coverage: pending",
    "- Audio hashes verified: pending",
    "- Consent and privacy review: pending",
    "- Manual quality review: pending",
    "- Decision: pending",
    "",
  ].join("\n");
}
