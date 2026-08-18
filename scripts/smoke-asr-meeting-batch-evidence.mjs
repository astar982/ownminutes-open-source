#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { validateAsrMeetingBatchEvidence } from "./lib/asr-meeting-batch-evidence.mjs";

const root = path.resolve(".data/smoke/asr-meeting-batch");
fs.rmSync(root, { recursive: true, force: true });
fs.mkdirSync(root, { recursive: true });

const scenarioSets = [
  ["near_field", "mild_noise"],
  ["far_field", "accented_speech"],
  ["overlap_or_interruption"],
];
const samples = scenarioSets.map((scenarioTags, index) => makeSample(index + 1, scenarioTags));
const passEvidence = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  tester: "QA human reviewer",
  environment: "staging",
  provider: "volcano",
  privacyReview: {
    consentProcessDocumented: true,
    retentionPolicyApplied: true,
    rawTranscriptExcludedFromEvidence: true,
  },
  samples,
  decision: "pass",
};

const passPath = path.join(root, "pass.json");
fs.writeFileSync(passPath, `${JSON.stringify(passEvidence, null, 2)}\n`, { mode: 0o600 });
const cliPass = runChecker(passPath);
const synthetic = validateAsrMeetingBatchEvidence(mutate(passEvidence, (copy) => { copy.samples[0].sourceKind = "synthetic"; }));
const missingConsent = validateAsrMeetingBatchEvidence(mutate(passEvidence, (copy) => { copy.samples[0].consentConfirmed = false; }));
const missingCoverage = validateAsrMeetingBatchEvidence(mutate(passEvidence, (copy) => { copy.samples[1].scenarioTags = ["near_field"]; }));
const lowQuality = validateAsrMeetingBatchEvidence(mutate(passEvidence, (copy) => { copy.samples[0].manualReview.meaningAccuracyPct = 65; }));
const missingSegmentCorrection = validateAsrMeetingBatchEvidence(mutate(passEvidence, (copy) => { copy.samples[0].manualReview.speakerSegmentCorrectionVerified = false; }));
const rawTranscript = validateAsrMeetingBatchEvidence(mutate(passEvidence, (copy) => { copy.samples[0].rawTranscript = "private words"; }));
const hashMismatch = validateAsrMeetingBatchEvidence(mutate(passEvidence, (copy) => { copy.samples[0].automatic.audioSha256 = "0".repeat(64); }));
const stale = validateAsrMeetingBatchEvidence(mutate(passEvidence, (copy) => { copy.generatedAt = "2025-01-01T00:00:00.000Z"; }));

const draftPlanPath = path.join(root, "draft-plan.json");
const draftEvidencePath = path.join(root, "draft-evidence.json");
const draft = spawnSync("node", ["scripts/collect-asr-meeting-batch-evidence.mjs", `--plan=${draftPlanPath}`, `--output=${draftEvidencePath}`], {
  encoding: "utf8",
  env: cleanEnv(),
});
const draftPayload = parseJson(draft.stdout);
const incomplete = spawnSync("node", ["scripts/collect-asr-meeting-batch-evidence.mjs", `--plan=${draftPlanPath}`, `--output=${draftEvidencePath}`], {
  encoding: "utf8",
  env: cleanEnv(),
});
const incompletePayload = parseJson(incomplete.stderr);

const summary = {
  passFixtureAccepted: cliPass.status === 0 && cliPass.payload?.ok === true && cliPass.payload?.sampleCount === 3,
  passCoversAllScenarios: cliPass.payload?.coveredScenarios?.length === 5,
  passHasMinimumDuration: cliPass.payload?.totalDurationSeconds >= 300,
  syntheticRejected: !synthetic.ok && synthetic.errors.some((error) => error.includes("sourceKind")),
  missingConsentRejected: !missingConsent.ok && missingConsent.errors.some((error) => error.includes("consentConfirmed")),
  missingCoverageRejected: !missingCoverage.ok && missingCoverage.errors.some((error) => error.includes("missing required scenarios")),
  lowQualityRejected: !lowQuality.ok && lowQuality.errors.some((error) => error.includes("meaningAccuracyPct")),
  missingSegmentCorrectionRejected: !missingSegmentCorrection.ok && missingSegmentCorrection.errors.some((error) => error.includes("speakerSegmentCorrectionVerified")),
  rawTranscriptRejected: !rawTranscript.ok && rawTranscript.errors.some((error) => error.includes("forbidden raw-content keys")),
  hashMismatchRejected: !hashMismatch.ok && hashMismatch.errors.some((error) => error.includes("SHA-256 no longer matches")),
  staleEvidenceRejected: !stale.ok && stale.errors.some((error) => error.includes("older than")),
  collectorCreatesPrivateDraft:
    draft.status === 0 &&
    draftPayload?.draftWritten === true &&
    draftPayload?.decision === "pending" &&
    fs.existsSync(draftPlanPath) &&
    (fs.statSync(draftPlanPath).mode & 0o777) === 0o600 &&
    !fs.existsSync(draftEvidencePath),
  incompleteDraftFailsBeforeProvider:
    incomplete.status !== 0 &&
    incompletePayload?.decision === "fail" &&
    incompletePayload?.error === "Meeting batch plan is incomplete.",
  structuredEvidenceContainsNoTranscript: !JSON.stringify(passEvidence).toLowerCase().includes("transcriptpreview"),
};

console.log(JSON.stringify(summary, null, 2));
if (Object.values(summary).some((value) => value !== true)) process.exitCode = 1;

function makeSample(index, scenarioTags) {
  const audioPath = path.join(root, `meeting-${index}.wav`);
  writeSilentWav(audioPath, 100);
  const audio = fs.readFileSync(audioPath);
  const audioSha256 = crypto.createHash("sha256").update(audio).digest("hex");
  const providerEvidencePath = path.join(root, `provider-${index}.md`);
  const requestId = `request-${index}-redacted`;
  fs.writeFileSync(providerEvidencePath, [
    "# ASR Small Audio Evidence",
    "",
    "- Result status: transcribed",
    `- Provider request id: ${requestId}`,
    `- Audio SHA-256: ${audioSha256}`,
    "- Segment count: 12",
    "- Speaker count: 2",
    "",
  ].join("\n"), { mode: 0o600 });
  return {
    id: `real-meeting-${index}`,
    audioPath,
    sourceKind: "real_meeting",
    participantCount: 2,
    consentConfirmed: true,
    scenarioTags,
    automatic: {
      audioSha256,
      audioBytes: audio.byteLength,
      durationSeconds: 100,
      providerStatus: "transcribed",
      providerRequestId: requestId,
      providerEvidencePath,
      segmentCount: 12,
      speakerCount: 2,
    },
    manualReview: {
      completed: true,
      reviewer: "QA human reviewer",
      transcriptQuality: "usable",
      meaningAccuracyPct: 90,
      speakerTurnAccuracyPct: 88,
      formalFromFullAudio: true,
      realtimeNotPublishedAsFormal: true,
      speakerLabelsDistinguishMajorTurns: true,
      speakerRenameVerified: true,
      speakerSegmentCorrectionVerified: true,
      renamedOutputsConsistent: true,
      summaryGrounded: true,
      actionItemsGrounded: true,
      shareVerified: true,
      obsidianMarkdownVerified: true,
      uncertainOwnerFallbackVerified: true,
      noSecretLeak: true,
    },
  };
}

function writeSilentWav(filePath, durationSeconds) {
  const sampleRate = 8_000;
  const channels = 1;
  const bitsPerSample = 8;
  const dataSize = sampleRate * channels * (bitsPerSample / 8) * durationSeconds;
  const buffer = Buffer.alloc(44 + dataSize, 128);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * channels * (bitsPerSample / 8), 28);
  buffer.writeUInt16LE(channels * (bitsPerSample / 8), 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataSize, 40);
  fs.writeFileSync(filePath, buffer, { mode: 0o600 });
}

function runChecker(evidencePath) {
  const run = spawnSync("node", ["scripts/check-asr-meeting-batch-evidence.mjs"], {
    encoding: "utf8",
    env: { ...cleanEnv(), OWNMINUTES_ASR_MEETING_BATCH_EVIDENCE_PATH: evidencePath },
  });
  return { status: run.status, payload: parseJson(run.stdout) };
}

function mutate(value, mutation) {
  const copy = structuredClone(value);
  mutation(copy);
  return copy;
}

function cleanEnv() {
  const env = { ...process.env };
  delete env.OWNMINUTES_ASR_MEETING_BATCH_PLAN_PATH;
  delete env.OWNMINUTES_ASR_MEETING_BATCH_EVIDENCE_PATH;
  delete env.VOLCANO_ASR_API_KEY;
  delete env.VOLCANO_ASR_APP_ID;
  delete env.VOLCANO_ASR_TOKEN;
  delete env.ARK_API_KEY;
  return env;
}

function parseJson(text = "") {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}
