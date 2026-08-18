#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  ASR_BATCH_MAX_SAMPLE_DURATION_SECONDS,
  ASR_BATCH_MIN_SAMPLE_DURATION_SECONDS,
  buildAsrMeetingBatchPlanDraft,
  inspectAudioFile,
} from "./lib/asr-meeting-batch-evidence.mjs";

loadDotEnvLocal();

const options = parseArgs(process.argv.slice(2));
const planPath = path.resolve(options.plan || process.env.OWNMINUTES_ASR_MEETING_BATCH_PLAN_PATH || ".data/acceptance/asr-meeting-batch-plan.json");
const outputPath = path.resolve(options.output || process.env.OWNMINUTES_ASR_MEETING_BATCH_EVIDENCE_PATH || ".data/acceptance/asr-meeting-batch-latest.json");

if (!fs.existsSync(planPath)) {
  fs.mkdirSync(path.dirname(planPath), { recursive: true });
  fs.writeFileSync(planPath, `${JSON.stringify(buildAsrMeetingBatchPlanDraft(), null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(planPath, 0o600);
  console.log(JSON.stringify({
    ok: true,
    decision: "pending",
    draftWritten: true,
    planPath,
    outputPath: null,
    nextAction: "Replace the private plan placeholders with 3 real 2-4 person Mandarin meeting audio paths and consent metadata, then rerun this command.",
  }, null, 2));
  process.exit(0);
}

const plan = readJson(planPath);
const planErrors = validatePlan(plan);
if (planErrors.length > 0) fail("Meeting batch plan is incomplete.", { planPath, errors: planErrors });

const samples = [];
for (const sample of plan.samples) {
  const inspected = inspectAudioFile(sample.audioPath);
  if ((fs.statSync(inspected.absolutePath).mode & 0o077) !== 0) {
    fail(`Sample ${sample.id} must not be group/world accessible.`, { sampleId: sample.id, requiredMode: "0600" });
  }
  if (inspected.durationSeconds < ASR_BATCH_MIN_SAMPLE_DURATION_SECONDS || inspected.durationSeconds > ASR_BATCH_MAX_SAMPLE_DURATION_SECONDS) {
    fail(`Sample ${sample.id} duration must be ${ASR_BATCH_MIN_SAMPLE_DURATION_SECONDS}-${ASR_BATCH_MAX_SAMPLE_DURATION_SECONDS} seconds.`, {
      sampleId: sample.id,
      durationSeconds: inspected.durationSeconds,
    });
  }

  const providerEvidencePath = path.resolve(path.dirname(outputPath), "asr-meeting-batch-provider", `${safeId(sample.id)}.md`);
  const provider = runProvider(sample, inspected, providerEvidencePath);
  samples.push({
    id: sample.id,
    audioPath: inspected.absolutePath,
    sourceKind: sample.sourceKind,
    participantCount: sample.participantCount,
    consentConfirmed: sample.consentConfirmed,
    scenarioTags: sample.scenarioTags,
    automatic: {
      audioSha256: inspected.sha256,
      audioBytes: inspected.bytes,
      durationSeconds: inspected.durationSeconds,
      providerStatus: provider.status,
      providerRequestId: provider.requestId || "pending",
      providerEvidencePath,
      segmentCount: provider.segmentCount ?? 0,
      speakerCount: provider.speakerCount ?? 0,
    },
    manualReview: pendingManualReview(),
  });
}

const evidence = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  tester: plan.tester,
  environment: plan.environment,
  provider: "volcano",
  privacyReview: plan.privacyReview,
  samples,
  decision: "pending",
};

const serialized = `${JSON.stringify(evidence, null, 2)}\n`;
assertNoSecretLeak(serialized);
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, serialized, { mode: 0o600 });
fs.chmodSync(outputPath, 0o600);

console.log(JSON.stringify({
  ok: true,
  decision: "pending",
  outputPath,
  sampleCount: samples.length,
  transcribedCount: samples.filter((sample) => sample.automatic.providerStatus === "transcribed").length,
  qualifyingAutomaticCount: samples.filter((sample) => sample.automatic.providerStatus === "transcribed" && sample.automatic.speakerCount >= 2).length,
  rawTranscriptStoredInStructuredEvidence: false,
  nextAction: "Privately review each transcript, speaker turns, global rename, per-segment speaker correction, summary, share page, and Obsidian Markdown. Fill manualReview and set decision=pass only when every field is true, then run npm run asr:meeting-batch:check.",
}, null, 2));

function runProvider(sample, inspected, providerEvidencePath) {
  const args = [
    "--experimental-strip-types",
    "scripts/run-asr-sample-transcription.mjs",
    `--sample=${inspected.absolutePath}`,
    `--duration-ms=${Math.round(inspected.durationSeconds * 1000)}`,
    `--output=${providerEvidencePath}`,
  ];
  if (sample.expectedPhrase) args.push(`--expected=${sample.expectedPhrase}`);
  const run = spawnSync("node", args, {
    encoding: "utf8",
    env: {
      ...process.env,
      OWNMINUTES_ASR_SAMPLE_MAX_BYTES: String(Math.max(10_000_000, inspected.bytes + 1)),
    },
    maxBuffer: 2 * 1024 * 1024,
  });
  const payload = parseJsonOutput(run.stdout);
  if (run.status !== 0 || payload?.status !== "transcribed") {
    fail(`Provider transcription failed for sample ${sample.id}.`, {
      sampleId: sample.id,
      status: payload?.status || "failed",
      error: sanitizeError(payload?.error || run.stderr || "Unknown provider failure."),
    });
  }
  return payload;
}

function validatePlan(plan) {
  const errors = [];
  if (!plan || typeof plan !== "object" || Array.isArray(plan)) return ["Plan must be a JSON object."];
  if (plan.schemaVersion !== 1) errors.push("schemaVersion must be 1.");
  if (!nonPendingString(plan.tester)) errors.push("tester must identify the reviewer.");
  if (!nonPendingString(plan.environment)) errors.push("environment is required.");
  if (plan.provider !== "volcano") errors.push("provider must be volcano.");
  if (plan.privacyReview?.consentProcessDocumented !== true) errors.push("privacyReview.consentProcessDocumented must be true.");
  if (plan.privacyReview?.retentionPolicyApplied !== true) errors.push("privacyReview.retentionPolicyApplied must be true.");
  if (plan.privacyReview?.rawTranscriptExcludedFromEvidence !== true) errors.push("privacyReview.rawTranscriptExcludedFromEvidence must be true.");
  if (!Array.isArray(plan.samples) || plan.samples.length < 3) errors.push("At least 3 samples are required.");
  const ids = new Set();
  for (const [index, sample] of (plan.samples || []).entries()) {
    const prefix = `samples[${index}]`;
    if (!nonPendingString(sample?.id)) errors.push(`${prefix}.id is required.`);
    else if (ids.has(sample.id)) errors.push(`${prefix}.id must be unique.`);
    else ids.add(sample.id);
    if (!nonPendingString(sample?.audioPath) || sample.audioPath.includes("/absolute/private/path")) errors.push(`${prefix}.audioPath must point to a private real recording.`);
    if (sample?.sourceKind !== "real_meeting") errors.push(`${prefix}.sourceKind must be real_meeting.`);
    if (!Number.isInteger(sample?.participantCount) || sample.participantCount < 2 || sample.participantCount > 4) errors.push(`${prefix}.participantCount must be 2-4.`);
    if (sample?.consentConfirmed !== true) errors.push(`${prefix}.consentConfirmed must be true.`);
    if (!Array.isArray(sample?.scenarioTags) || sample.scenarioTags.length === 0) errors.push(`${prefix}.scenarioTags is required.`);
  }
  return errors;
}

function pendingManualReview() {
  return {
    completed: false,
    reviewer: "pending",
    transcriptQuality: "pending",
    meaningAccuracyPct: null,
    speakerTurnAccuracyPct: null,
    formalFromFullAudio: false,
    realtimeNotPublishedAsFormal: false,
    speakerLabelsDistinguishMajorTurns: false,
    speakerRenameVerified: false,
    speakerSegmentCorrectionVerified: false,
    renamedOutputsConsistent: false,
    summaryGrounded: false,
    actionItemsGrounded: false,
    shareVerified: false,
    obsidianMarkdownVerified: false,
    uncertainOwnerFallbackVerified: false,
    noSecretLeak: false,
  };
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    fail("Unable to read the meeting batch plan JSON.", { planPath: filePath, error: sanitizeError(error) });
  }
}

function parseJsonOutput(text = "") {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

function parseArgs(args) {
  const parsed = {};
  for (const arg of args) {
    if (!arg.startsWith("--")) continue;
    const [rawKey, ...rest] = arg.slice(2).split("=");
    const key = rawKey.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    parsed[key] = rest.join("=") || "1";
  }
  return parsed;
}

function safeId(value) {
  return String(value).replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 80);
}

function nonPendingString(value) {
  return typeof value === "string" && value.trim() && value.trim().toLowerCase() !== "pending";
}

function assertNoSecretLeak(text) {
  const fragments = [
    process.env.VOLCANO_ASR_API_KEY,
    process.env.VOLCANO_ASR_TOKEN,
    process.env.ARK_API_KEY,
    process.env.OPENAI_API_KEY,
    process.env.VOLCANO_ACCESS_KEY_ID,
    process.env.VOLCANO_SECRET_ACCESS_KEY,
    "AKL",
    "sk-proj",
    "Secret Access Key",
    "-----BEGIN PRIVATE KEY-----",
  ].filter((value) => typeof value === "string" && value.length >= 6);
  if (fragments.some((fragment) => text.includes(fragment))) fail("Structured evidence would contain secret-like material.");
}

function sanitizeError(error) {
  let message = error instanceof Error ? error.message : String(error);
  for (const secret of [process.env.VOLCANO_ASR_API_KEY, process.env.VOLCANO_ASR_TOKEN, process.env.ARK_API_KEY].filter(Boolean)) {
    message = message.split(secret).join("[redacted]");
  }
  return message.replace(/[\r\n]+/g, " ").slice(0, 300);
}

function fail(message, details = {}) {
  console.error(JSON.stringify({ ok: false, decision: "fail", error: message, ...details }, null, 2));
  process.exit(1);
}

function loadDotEnvLocal() {
  if (!fs.existsSync(".env.local")) return;
  for (const line of fs.readFileSync(".env.local", "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator < 0) continue;
    const key = trimmed.slice(0, separator);
    const value = stripQuotes(trimmed.slice(separator + 1));
    if (!process.env[key]) process.env[key] = value;
  }
}

function stripQuotes(value) {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) return value.slice(1, -1);
  return value;
}
