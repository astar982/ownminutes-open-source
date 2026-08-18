#!/usr/bin/env node

import crypto from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, extname } from "node:path";

loadDotEnvLocal();

const options = parseArgs(process.argv.slice(2));
const samplePath = options.sample || process.env.OWNMINUTES_ASR_SAMPLE_PATH;
const expectedPhrase = options.expected || process.env.OWNMINUTES_ASR_EXPECTED_PHRASE || "";
const outputPath = options.output || process.env.OWNMINUTES_ASR_SMALL_AUDIO_EVIDENCE_PATH || ".data/acceptance/asr-small-audio-latest.md";
const durationMs = Number(options.durationMs || process.env.OWNMINUTES_ASR_SAMPLE_DURATION_MS || 0);
const maxBytes = Number(process.env.OWNMINUTES_ASR_SAMPLE_MAX_BYTES || 10_000_000);

if (!samplePath) {
  fail("Missing ASR sample path. Set OWNMINUTES_ASR_SAMPLE_PATH or pass --sample=/path/to/mandarin-sample.wav.");
}

if (!existsSync(samplePath)) {
  fail(`ASR sample does not exist: ${samplePath}`);
}

const sample = readFileSync(samplePath);
if (sample.byteLength === 0) fail("ASR sample is empty.");
if (sample.byteLength > maxBytes) fail(`ASR sample is too large: ${sample.byteLength} bytes. Limit: ${maxBytes} bytes.`);

const { transcribeWithVolcanoFileAsr } = await import(new URL("../src/lib/volcano-asr.ts", import.meta.url));
const checkedAt = new Date().toISOString();
const fileName = basename(samplePath);
const mimeType = inferMimeType(samplePath);
const audioSha256 = crypto.createHash("sha256").update(sample).digest("hex");
let summary;

try {
  const result = await transcribeWithVolcanoFileAsr({
    meetingId: `asr-sample-${Date.now()}`,
    buffer: sample,
    mimeType,
    fileName,
    durationMs: Number.isFinite(durationMs) && durationMs > 0 ? durationMs : 10_000,
  });
  const transcriptPreview = result.text.trim().slice(0, 260);
  const hasReadableText = Boolean(transcriptPreview) && !/没有可解析|没有可读|placeholder|等待正式识别/i.test(transcriptPreview);
  const expectedReadable = expectedPhrase ? transcriptPreview.includes(expectedPhrase) || fuzzyIncludes(transcriptPreview, expectedPhrase) : null;
  const status = hasReadableText ? "transcribed" : "completed_empty";
  const decision = hasReadableText && expectedReadable !== false ? "pass" : "fail";
  const segmentCount = result.transcript.length;
  const speakerCount = new Set(result.transcript.map((segment) => segment.speaker).filter(Boolean)).size;

  const evidence = buildEvidence({
    checkedAt,
    decision,
    expectedPhrase,
    expectedReadable,
    fileName,
    mimeType,
    requestId: result.requestId,
    audioSha256,
    durationMs: Number.isFinite(durationMs) && durationMs > 0 ? durationMs : 10_000,
    sampleBytes: sample.byteLength,
    segmentCount,
    speakerCount,
    status,
    transcriptPreview,
  });
  const leaked = findSecretLeaks(evidence);

  if (leaked.length > 0) {
    summary = {
      ok: false,
      decision: "fail",
      evidencePath: null,
      leakedPhrases: leaked,
      requestId: result.requestId,
      audioSha256,
      sampleBytes: sample.byteLength,
      segmentCount,
      speakerCount,
      status,
      transcriptPreviewWritten: false,
    };
  } else {
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, evidence, { mode: 0o600 });
    chmodSync(outputPath, 0o600);
    summary = {
      ok: decision === "pass",
      decision,
      evidencePath: outputPath,
      expectedPhraseChecked: Boolean(expectedPhrase),
      expectedPhraseReadable: expectedReadable,
      requestId: result.requestId,
      audioSha256,
      durationMs: Number.isFinite(durationMs) && durationMs > 0 ? durationMs : 10_000,
      sampleBytes: sample.byteLength,
      segmentCount,
      speakerCount,
      status,
      transcriptPreviewWritten: true,
    };
  }
} catch (error) {
  summary = {
    ok: false,
    decision: "fail",
    evidencePath: null,
    error: sanitizeError(error),
    audioSha256,
    sampleBytes: sample.byteLength,
    status: "failed",
    transcriptPreviewWritten: false,
  };
}

console.log(JSON.stringify(summary, null, 2));
if (!summary.ok) process.exitCode = 1;

function buildEvidence(input) {
  const credentialType = process.env.VOLCANO_ASR_API_KEY
    ? "ASR API Key"
    : process.env.VOLCANO_ASR_APP_ID && process.env.VOLCANO_ASR_TOKEN
      ? "ASR AppID + Token"
      : "not configured";

  return `# ASR Small Audio Evidence

## Decision

- Date: ${input.checkedAt}
- Tester: CLI
- Environment: ${process.env.NODE_ENV || "local"}
- Decision: ${input.decision}
- Reason: ${input.status === "transcribed" ? "Provider returned readable transcript text." : "Provider did not return readable transcript text."}

## Provider

- ASR provider: Volcano
- Credential type: ${credentialType}
- Runtime source: server env
- Provider health: file_asr ${input.status === "transcribed" ? "ready" : "not ready"}

## Small Audio Test

- Test path: CLI
- Mode: transcribe
- Result status: ${input.status}
- Verification level: ${input.status === "transcribed" ? "transcript" : "none"}
- Provider request id: ${input.requestId}
- Sample type: ${input.mimeType}
- Sample file: ${input.fileName}
- Sample bytes: ${input.sampleBytes}
- Sample duration ms: ${input.durationMs}
- Audio SHA-256: ${input.audioSha256}
- Segment count: ${input.segmentCount}
- Speaker count: ${input.speakerCount}
- Transcript preview: ${input.transcriptPreview || "not available"}
- Expected phrase: ${input.expectedPhrase || "not provided"}
- Expected phrase readable: ${input.expectedPhrase ? (input.expectedReadable ? "yes" : "no") : "not checked"}
- Secrets leaked: no
- Decision: ${input.decision}

## Next Step

- If this passes, record a 1-3 minute Mandarin meeting in /app and complete docs/asr-acceptance-evidence-template.md.
- Then run OWNMINUTES_ASR_ACCEPTANCE_EVIDENCE_PATH=.data/acceptance/asr-latest.md npm run asr:acceptance:evidence.
`;
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

function fail(message) {
  console.error(JSON.stringify({ ok: false, status: "failed", error: message }, null, 2));
  process.exit(1);
}

function inferMimeType(filePath) {
  const extension = extname(filePath).toLowerCase();
  if (extension === ".wav") return "audio/wav";
  if (extension === ".mp3") return "audio/mpeg";
  if (extension === ".m4a") return "audio/mp4";
  if (extension === ".mp4") return "audio/mp4";
  if (extension === ".aac") return "audio/aac";
  if (extension === ".webm") return "audio/webm";
  if (extension === ".ogg") return "audio/ogg";
  return "application/octet-stream";
}

function fuzzyIncludes(text, phrase) {
  const compactText = text.replace(/\s+/g, "");
  const compactPhrase = phrase.replace(/\s+/g, "");
  if (!compactPhrase) return false;
  return compactText.includes(compactPhrase);
}

function sanitizeError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return redactSecrets(message).slice(0, 500);
}

function findSecretLeaks(text) {
  return secretFragments().filter((fragment) => fragment && text.includes(fragment));
}

function secretFragments() {
  return [
    process.env.VOLCANO_ASR_API_KEY,
    process.env.VOLCANO_ASR_TOKEN,
    process.env.ARK_API_KEY,
    process.env.OPENAI_API_KEY,
    process.env.VOLCANO_ACCESS_KEY_ID,
    process.env.VOLCANO_SECRET_ACCESS_KEY,
    "AKL",
    "sk-proj",
    "Secret Access Key",
    "WVRCaE",
    "-----BEGIN PRIVATE KEY-----",
    "BEGIN OPENSSH PRIVATE KEY",
  ].filter((value) => typeof value === "string" && value.length >= 6);
}

function redactSecrets(value) {
  let output = value;
  for (const fragment of secretFragments()) {
    output = output.split(fragment).join("[redacted]");
  }
  return output;
}

function loadDotEnvLocal() {
  if (!existsSync(".env.local")) return;

  const contents = readFileSync(".env.local", "utf8");
  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex < 0) continue;
    const key = trimmed.slice(0, separatorIndex);
    const value = trimmed.slice(separatorIndex + 1);
    if (!process.env[key]) process.env[key] = stripQuotes(value);
  }
}

function stripQuotes(value) {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}
