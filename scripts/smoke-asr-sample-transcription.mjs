#!/usr/bin/env node

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { spawnSync } from "node:child_process";

const source = readFileSync("scripts/run-asr-sample-transcription.mjs", "utf8");
const packageJson = JSON.parse(readFileSync("package.json", "utf8"));
const runbook = readFileSync("docs/asr-runtime-runbook.md", "utf8");
const samplePath = ".data/smoke/asr-empty.wav";

mkdirSync(dirname(samplePath), { recursive: true });
writeFileSync(samplePath, Buffer.alloc(0));

const missingSample = spawnSync("node", ["scripts/run-asr-sample-transcription.mjs"], {
  encoding: "utf8",
  env: { ...process.env, OWNMINUTES_ASR_SAMPLE_PATH: "" },
});
const emptySample = spawnSync("node", ["scripts/run-asr-sample-transcription.mjs", `--sample=${samplePath}`], {
  encoding: "utf8",
  env: { ...process.env, VOLCANO_ASR_API_KEY: "", VOLCANO_ASR_TOKEN: "", VOLCANO_ASR_APP_ID: "" },
});

const summary = {
  packageScriptExists:
    packageJson.scripts["asr:sample"]?.includes("scripts/run-asr-sample-transcription.mjs") &&
    packageJson.scripts["asr:sample"]?.includes("--experimental-strip-types"),
  smokeScriptExists: packageJson.scripts["smoke:asr-sample"] === "node scripts/smoke-asr-sample-transcription.mjs",
  importsRealAdapter: source.includes("transcribeWithVolcanoFileAsr"),
  writesPrivateEvidence:
    source.includes(".data/acceptance/asr-small-audio-latest.md") &&
    source.includes("mkdirSync(dirname(outputPath)") &&
    source.includes("chmodSync(outputPath, 0o600)"),
  keepsTerminalTranscriptPrivate:
    source.includes("transcriptPreviewWritten") &&
    !source.includes("console.log(transcriptPreview") &&
    !source.includes("transcriptPreview: transcriptPreview"),
  checksSamplePath: source.includes("OWNMINUTES_ASR_SAMPLE_PATH") && source.includes("--sample=/path/to/mandarin-sample.wav"),
  checksSizeLimit: source.includes("OWNMINUTES_ASR_SAMPLE_MAX_BYTES") && source.includes("10_000_000"),
  bindsProviderResultToAudio:
    source.includes("Audio SHA-256:") &&
    source.includes("Segment count:") &&
    source.includes("Speaker count:") &&
    source.includes("Sample duration ms:"),
  redactsSecrets: source.includes("redactSecrets") && source.includes("secretFragments") && source.includes("[redacted]"),
  runbookMentionsCommand: runbook.includes("npm run asr:sample") && runbook.includes("OWNMINUTES_ASR_SAMPLE_PATH"),
  missingSampleRejected: missingSample.status !== 0 && parseJson(missingSample.stderr || missingSample.stdout)?.error?.includes("Missing ASR sample path"),
  emptySampleRejected: emptySample.status !== 0 && parseJson(emptySample.stderr || emptySample.stdout)?.error?.includes("ASR sample is empty"),
  leaksSecrets:
    source.includes("asr-runtime-api-key") ||
    source.includes("runtime-token"),
};

console.log(JSON.stringify(summary, null, 2));

if (
  !summary.packageScriptExists ||
  !summary.smokeScriptExists ||
  !summary.importsRealAdapter ||
  !summary.writesPrivateEvidence ||
  !summary.keepsTerminalTranscriptPrivate ||
  !summary.checksSamplePath ||
  !summary.checksSizeLimit ||
  !summary.bindsProviderResultToAudio ||
  !summary.redactsSecrets ||
  !summary.runbookMentionsCommand ||
  !summary.missingSampleRejected ||
  !summary.emptySampleRejected ||
  summary.leaksSecrets
) {
  process.exitCode = 1;
}

function parseJson(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}
