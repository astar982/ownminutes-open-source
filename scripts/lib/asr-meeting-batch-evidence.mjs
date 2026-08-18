import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

export const ASR_BATCH_SCHEMA_VERSION = 1;
export const ASR_BATCH_MIN_SAMPLES = 3;
export const ASR_BATCH_MIN_TOTAL_DURATION_SECONDS = 300;
export const ASR_BATCH_MIN_SAMPLE_DURATION_SECONDS = 60;
export const ASR_BATCH_MAX_SAMPLE_DURATION_SECONDS = 180;
export const ASR_BATCH_MAX_AGE_HOURS = 24 * 30;
export const ASR_BATCH_MIN_MEANING_ACCURACY_PCT = 80;
export const ASR_BATCH_MIN_SPEAKER_TURN_ACCURACY_PCT = 80;
export const ASR_BATCH_REQUIRED_SCENARIOS = [
  "near_field",
  "far_field",
  "mild_noise",
  "accented_speech",
  "overlap_or_interruption",
];

const forbiddenSecretFragments = [
  "AKL",
  "sk-proj",
  "Secret Access Key",
  "-----BEGIN PRIVATE KEY-----",
  "BEGIN OPENSSH PRIVATE KEY",
  "Bearer ",
  "session=",
];

const forbiddenContentKeys = new Set([
  "raw",
  "rawtranscript",
  "transcript",
  "transcripttext",
  "transcriptpreview",
  "audio",
  "audiobase64",
  "providerresponse",
]);

export function buildAsrMeetingBatchPlanDraft() {
  return {
    schemaVersion: ASR_BATCH_SCHEMA_VERSION,
    tester: "pending",
    environment: "local",
    provider: "volcano",
    privacyReview: {
      consentProcessDocumented: false,
      retentionPolicyApplied: false,
      rawTranscriptExcludedFromEvidence: true,
    },
    samples: [
      draftSample("meeting-near-noise", ["near_field", "mild_noise"]),
      draftSample("meeting-far-accent", ["far_field", "accented_speech"]),
      draftSample("meeting-overlap", ["overlap_or_interruption"]),
    ],
  };
}

export function validateAsrMeetingBatchEvidence(evidence, options = {}) {
  const now = options.now instanceof Date ? options.now : new Date();
  const verifyFiles = options.verifyFiles !== false;
  const errors = [];
  const warnings = [];

  if (!isPlainObject(evidence)) {
    return result(false, ["Evidence must be a JSON object."], warnings, [], 0, null, 0);
  }

  if (evidence.schemaVersion !== ASR_BATCH_SCHEMA_VERSION) errors.push(`schemaVersion must be ${ASR_BATCH_SCHEMA_VERSION}.`);
  if (!nonPendingString(evidence.tester)) errors.push("tester must identify the human reviewer.");
  if (!nonPendingString(evidence.environment)) errors.push("environment is required.");
  if (evidence.provider !== "volcano") errors.push("provider must be volcano for this acceptance batch.");

  const generatedAt = parseDate(evidence.generatedAt);
  if (!generatedAt) {
    errors.push("generatedAt must be a valid ISO timestamp.");
  } else {
    const ageHours = (now.getTime() - generatedAt.getTime()) / 3_600_000;
    if (ageHours < -1) errors.push("generatedAt cannot be in the future.");
    if (ageHours > ASR_BATCH_MAX_AGE_HOURS) errors.push(`evidence is older than ${ASR_BATCH_MAX_AGE_HOURS} hours.`);
  }

  if (evidence.privacyReview?.consentProcessDocumented !== true) errors.push("privacyReview.consentProcessDocumented must be true.");
  if (evidence.privacyReview?.retentionPolicyApplied !== true) errors.push("privacyReview.retentionPolicyApplied must be true.");
  if (evidence.privacyReview?.rawTranscriptExcludedFromEvidence !== true) errors.push("privacyReview.rawTranscriptExcludedFromEvidence must be true.");

  const contentKeyHits = findForbiddenContentKeys(evidence);
  if (contentKeyHits.length > 0) errors.push(`structured evidence contains forbidden raw-content keys: ${contentKeyHits.join(", ")}.`);

  const serialized = JSON.stringify(evidence);
  const leakedFragments = forbiddenSecretFragments.filter((fragment) => serialized.includes(fragment));
  if (leakedFragments.length > 0) errors.push(`structured evidence contains secret-like material: ${leakedFragments.join(", ")}.`);

  const samples = Array.isArray(evidence.samples) ? evidence.samples : [];
  if (samples.length < ASR_BATCH_MIN_SAMPLES) errors.push(`at least ${ASR_BATCH_MIN_SAMPLES} real meeting samples are required.`);
  const ids = new Set();
  const coveredScenarios = new Set();
  let totalDurationSeconds = 0;

  for (const [index, sample] of samples.entries()) {
    const prefix = `samples[${index}]`;
    if (!isPlainObject(sample)) {
      errors.push(`${prefix} must be an object.`);
      continue;
    }

    if (!nonPendingString(sample.id)) errors.push(`${prefix}.id is required.`);
    else if (ids.has(sample.id)) errors.push(`${prefix}.id must be unique.`);
    else ids.add(sample.id);

    if (sample.sourceKind !== "real_meeting") errors.push(`${prefix}.sourceKind must be real_meeting; synthetic and single-speaker samples are non-qualifying.`);
    if (!Number.isInteger(sample.participantCount) || sample.participantCount < 2 || sample.participantCount > 4) {
      errors.push(`${prefix}.participantCount must be an integer from 2 to 4.`);
    }
    if (sample.consentConfirmed !== true) errors.push(`${prefix}.consentConfirmed must be true.`);

    const durationSeconds = finiteNumber(sample.automatic?.durationSeconds);
    if (durationSeconds === null || durationSeconds < ASR_BATCH_MIN_SAMPLE_DURATION_SECONDS || durationSeconds > ASR_BATCH_MAX_SAMPLE_DURATION_SECONDS) {
      errors.push(`${prefix}.automatic.durationSeconds must be between ${ASR_BATCH_MIN_SAMPLE_DURATION_SECONDS} and ${ASR_BATCH_MAX_SAMPLE_DURATION_SECONDS}.`);
    } else {
      totalDurationSeconds += durationSeconds;
    }

    if (!Array.isArray(sample.scenarioTags) || sample.scenarioTags.length === 0) {
      errors.push(`${prefix}.scenarioTags must contain at least one scenario.`);
    } else {
      for (const tag of sample.scenarioTags) {
        if (!ASR_BATCH_REQUIRED_SCENARIOS.includes(tag)) warnings.push(`${prefix}.scenarioTags contains unrecognized tag ${String(tag)}.`);
        else coveredScenarios.add(tag);
      }
    }

    validateAutomatic(sample, prefix, errors, verifyFiles);
    validateManualReview(sample.manualReview, prefix, errors);
  }

  if (totalDurationSeconds < ASR_BATCH_MIN_TOTAL_DURATION_SECONDS) {
    errors.push(`total qualifying duration must be at least ${ASR_BATCH_MIN_TOTAL_DURATION_SECONDS} seconds.`);
  }

  const missingScenarios = ASR_BATCH_REQUIRED_SCENARIOS.filter((scenario) => !coveredScenarios.has(scenario));
  if (missingScenarios.length > 0) errors.push(`missing required scenarios: ${missingScenarios.join(", ")}.`);

  if (evidence.decision !== "pass") errors.push("decision must be pass after all automatic and human reviews complete.");

  return result(errors.length === 0, errors, warnings, [...coveredScenarios], totalDurationSeconds, generatedAt?.toISOString() ?? null, samples.length);
}

export function inspectAudioFile(audioPath) {
  const absolutePath = path.resolve(audioPath);
  const stat = fs.statSync(absolutePath);
  if (!stat.isFile() || stat.size <= 0) throw new Error("Audio sample must be a non-empty file.");

  return {
    absolutePath,
    bytes: stat.size,
    sha256: crypto.createHash("sha256").update(fs.readFileSync(absolutePath)).digest("hex"),
    durationSeconds: probeAudioDurationSeconds(absolutePath),
  };
}

export function providerEvidenceMatches(providerEvidencePath, automatic) {
  if (!providerEvidencePath || !fs.existsSync(providerEvidencePath)) return false;
  const text = fs.readFileSync(providerEvidencePath, "utf8");
  return (
    text.includes("- Result status: transcribed") &&
    text.includes(`- Provider request id: ${automatic.providerRequestId}`) &&
    text.includes(`- Audio SHA-256: ${automatic.audioSha256}`) &&
    text.includes(`- Segment count: ${automatic.segmentCount}`) &&
    text.includes(`- Speaker count: ${automatic.speakerCount}`)
  );
}

function validateAutomatic(sample, prefix, errors, verifyFiles) {
  const automatic = sample.automatic;
  if (!isPlainObject(automatic)) {
    errors.push(`${prefix}.automatic is required.`);
    return;
  }
  if (automatic.providerStatus !== "transcribed") errors.push(`${prefix}.automatic.providerStatus must be transcribed.`);
  if (!nonPendingString(automatic.providerRequestId)) errors.push(`${prefix}.automatic.providerRequestId is required.`);
  if (!Number.isInteger(automatic.segmentCount) || automatic.segmentCount < 2) errors.push(`${prefix}.automatic.segmentCount must be at least 2.`);
  if (!Number.isInteger(automatic.speakerCount) || automatic.speakerCount < 2 || automatic.speakerCount > 4) {
    errors.push(`${prefix}.automatic.speakerCount must be from 2 to 4.`);
  }
  if (!/^[a-f0-9]{64}$/.test(automatic.audioSha256 ?? "")) errors.push(`${prefix}.automatic.audioSha256 must be a SHA-256 hex digest.`);
  if (!Number.isInteger(automatic.audioBytes) || automatic.audioBytes <= 0) errors.push(`${prefix}.automatic.audioBytes must be positive.`);
  if (!nonPendingString(automatic.providerEvidencePath)) errors.push(`${prefix}.automatic.providerEvidencePath is required.`);

  if (!verifyFiles) return;
  if (!nonPendingString(sample.audioPath) || !fs.existsSync(sample.audioPath)) {
    errors.push(`${prefix}.audioPath must point to the retained private acceptance audio.`);
    return;
  }

  try {
    const inspected = inspectAudioFile(sample.audioPath);
    if ((fs.statSync(sample.audioPath).mode & 0o077) !== 0) errors.push(`${prefix} private audio must not be group/world accessible.`);
    if (inspected.sha256 !== automatic.audioSha256) errors.push(`${prefix} audio SHA-256 no longer matches the evidence.`);
    if (inspected.bytes !== automatic.audioBytes) errors.push(`${prefix} audio byte size no longer matches the evidence.`);
    if (Math.abs(inspected.durationSeconds - automatic.durationSeconds) > 0.5) errors.push(`${prefix} audio duration no longer matches the evidence.`);
  } catch (error) {
    errors.push(`${prefix} audio inspection failed: ${sanitizeError(error)}.`);
  }

  if (!providerEvidenceMatches(automatic.providerEvidencePath, automatic)) {
    errors.push(`${prefix}.automatic.providerEvidencePath does not match the audio hash and provider result.`);
  } else if ((fs.statSync(automatic.providerEvidencePath).mode & 0o077) !== 0) {
    errors.push(`${prefix}.automatic.providerEvidencePath must not be group/world accessible.`);
  }
}

function validateManualReview(review, prefix, errors) {
  if (!isPlainObject(review)) {
    errors.push(`${prefix}.manualReview is required.`);
    return;
  }
  if (review.completed !== true) errors.push(`${prefix}.manualReview.completed must be true.`);
  if (!nonPendingString(review.reviewer)) errors.push(`${prefix}.manualReview.reviewer is required.`);
  if (review.transcriptQuality !== "usable") errors.push(`${prefix}.manualReview.transcriptQuality must be usable.`);
  const meaningAccuracy = finiteNumber(review.meaningAccuracyPct);
  if (meaningAccuracy === null || meaningAccuracy < ASR_BATCH_MIN_MEANING_ACCURACY_PCT || meaningAccuracy > 100) {
    errors.push(`${prefix}.manualReview.meaningAccuracyPct must be ${ASR_BATCH_MIN_MEANING_ACCURACY_PCT}-100.`);
  }
  const speakerAccuracy = finiteNumber(review.speakerTurnAccuracyPct);
  if (speakerAccuracy === null || speakerAccuracy < ASR_BATCH_MIN_SPEAKER_TURN_ACCURACY_PCT || speakerAccuracy > 100) {
    errors.push(`${prefix}.manualReview.speakerTurnAccuracyPct must be ${ASR_BATCH_MIN_SPEAKER_TURN_ACCURACY_PCT}-100.`);
  }
  for (const field of [
    "formalFromFullAudio",
    "realtimeNotPublishedAsFormal",
    "speakerLabelsDistinguishMajorTurns",
    "speakerRenameVerified",
    "speakerSegmentCorrectionVerified",
    "renamedOutputsConsistent",
    "summaryGrounded",
    "actionItemsGrounded",
    "shareVerified",
    "obsidianMarkdownVerified",
    "uncertainOwnerFallbackVerified",
    "noSecretLeak",
  ]) {
    if (review[field] !== true) errors.push(`${prefix}.manualReview.${field} must be true.`);
  }
}

function probeAudioDurationSeconds(audioPath) {
  const wavDuration = readWavDurationSeconds(audioPath);
  if (wavDuration !== null) return round3(wavDuration);

  const probe = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", audioPath], {
    encoding: "utf8",
    timeout: 15_000,
  });
  const duration = Number(probe.stdout?.trim());
  if (probe.status !== 0 || !Number.isFinite(duration) || duration <= 0) throw new Error("Unable to determine audio duration with ffprobe.");
  return round3(duration);
}

function readWavDurationSeconds(audioPath) {
  if (path.extname(audioPath).toLowerCase() !== ".wav") return null;
  const buffer = fs.readFileSync(audioPath);
  if (buffer.length < 44 || buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") return null;

  let offset = 12;
  let byteRate = 0;
  let dataBytes = 0;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === "fmt " && size >= 16 && body + 12 <= buffer.length) byteRate = buffer.readUInt32LE(body + 8);
    if (id === "data") {
      dataBytes = Math.min(size, Math.max(0, buffer.length - body));
      break;
    }
    offset = body + size + (size % 2);
  }
  if (!byteRate || !dataBytes) return null;
  return dataBytes / byteRate;
}

function draftSample(id, scenarioTags) {
  return {
    id,
    audioPath: "/absolute/private/path/to/real-meeting.wav",
    sourceKind: "real_meeting",
    participantCount: 2,
    consentConfirmed: false,
    scenarioTags,
  };
}

function findForbiddenContentKeys(value, currentPath = "", hits = []) {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => findForbiddenContentKeys(entry, `${currentPath}[${index}]`, hits));
    return hits;
  }
  if (!isPlainObject(value)) return hits;
  for (const [key, child] of Object.entries(value)) {
    const normalized = key.toLowerCase().replace(/[^a-z]/g, "");
    const nextPath = currentPath ? `${currentPath}.${key}` : key;
    if (forbiddenContentKeys.has(normalized)) hits.push(nextPath);
    findForbiddenContentKeys(child, nextPath, hits);
  }
  return hits;
}

function result(ok, errors, warnings, coveredScenarios, totalDurationSeconds, generatedAt, sampleCount) {
  return {
    ok,
    decision: ok ? "pass" : "fail",
    errors,
    warnings,
    sampleCount,
    coveredScenarios,
    totalDurationSeconds: round3(totalDurationSeconds),
    generatedAt,
  };
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonPendingString(value) {
  return typeof value === "string" && value.trim().length > 0 && value.trim().toLowerCase() !== "pending";
}

function finiteNumber(value) {
  const number = typeof value === "number" ? value : Number.NaN;
  return Number.isFinite(number) ? number : null;
}

function parseDate(value) {
  if (typeof value !== "string") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function round3(value) {
  return Math.round(value * 1000) / 1000;
}

function sanitizeError(error) {
  return (error instanceof Error ? error.message : String(error)).replace(/[\r\n]+/g, " ").slice(0, 240);
}
