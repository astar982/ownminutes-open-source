#!/usr/bin/env node

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  calculateCharacterErrorRate,
  calculateSpeakerMetrics,
  clipReferenceIntervals,
  evaluateBenchmarkSample,
  extractVolcanoBenchmarkTranscript,
  parseAliMeetingTextGrid,
  sha256Buffer,
} from "./lib/alimeeting-public-benchmark.mjs";

loadDotEnvLocal();
const options = parseArgs(process.argv.slice(2));
const manifestPath = resolve(options.manifest || "scripts/fixtures/alimeeting-public-benchmark.json");
const preparedManifestPath = resolve(options.prepared || ".data/acceptance/datasets/alimeeting/prepared-manifest.json");
const outputPath = resolve(options.output || ".data/acceptance/alimeeting-public-benchmark-latest.json");
if (!existsSync(preparedManifestPath)) fail("Prepared AliMeeting manifest is missing. Run npm run asr:benchmark:prepare first.");

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const prepared = JSON.parse(readFileSync(preparedManifestPath, "utf8"));
const preparedById = new Map(prepared.samples.map((sample) => [sample.id, sample]));
const { transcribeWithVolcanoFileAsr } = await import(new URL("../src/lib/volcano-asr.ts", import.meta.url));
const results = [];

for (const sample of manifest.samples) {
  const privateSample = preparedById.get(sample.id);
  if (!privateSample || !existsSync(privateSample.samplePath) || !existsSync(privateSample.textGridPath)) {
    fail(`Prepared files are missing for ${sample.id}.`);
  }
  const audio = readFileSync(privateSample.samplePath);
  if (sha256Buffer(audio) !== privateSample.sampleSha256) fail(`Prepared audio hash changed for ${sample.id}.`);
  const references = clipReferenceIntervals(
    parseAliMeetingTextGrid(readFileSync(privateSample.textGridPath, "utf8")),
    sample.startSeconds,
    sample.durationSeconds,
  );
  const activeReferenceSpeakers = new Set(references.map((interval) => interval.speaker)).size;
  if (activeReferenceSpeakers !== sample.referenceSpeakerCount) {
    fail(`Reference speaker count changed for ${sample.id}: expected ${sample.referenceSpeakerCount}, received ${activeReferenceSpeakers}.`);
  }

  const provider = await transcribeWithVolcanoFileAsr({
    meetingId: `alimeeting-benchmark-${sample.id}-${Date.now()}`,
    buffer: audio,
    mimeType: "audio/wav",
    fileName: `${sample.id}.wav`,
    durationMs: sample.durationSeconds * 1000,
  });
  const providerData = extractVolcanoBenchmarkTranscript(provider.raw);
  const referenceText = references.map((interval) => interval.text).join("");
  const cer = calculateCharacterErrorRate(referenceText, providerData.transcriptText);
  const speaker = calculateSpeakerMetrics(references, providerData.utterances);
  const metrics = {
    ...cer,
    ...speaker,
    providerSpeakerInfoPresent: provider.providerSpeakerInfoPresent,
  };
  const assessment = evaluateBenchmarkSample(metrics, manifest.qualityTargets);
  results.push({
    id: sample.id,
    sourceKind: "public_benchmark",
    meetingId: sample.meetingId,
    selectedChannel: sample.selectedChannel,
    startSeconds: sample.startSeconds,
    durationSeconds: sample.durationSeconds,
    profile: sample.profile,
    overlapWallSeconds: sample.overlapWallSeconds,
    audioSha256: privateSample.sampleSha256,
    audioBytes: privateSample.sampleBytes,
    providerRequestId: provider.requestId,
    providerAttempts: provider.attempts,
    providerStatus: provider.noSpeech ? "completed_empty" : "transcribed",
    providerUtteranceCount: provider.providerUtteranceCount,
    ...metrics,
    ...assessment,
  });
}

const totals = aggregate(results);
const report = {
  schemaVersion: 2,
  generatedAt: new Date().toISOString(),
  provider: "volcano",
  providerMode: process.env.VOLCANO_ASR_MODE === "standard" ? "standard" : "flash",
  source: manifest.source,
  archiveSha256: prepared.archive.sha256,
  qualityTargets: manifest.qualityTargets,
  sampleCount: results.length,
  totalDurationSeconds: results.reduce((sum, sample) => sum + sample.durationSeconds, 0),
  results,
  totals,
  meetsBenchmarkTargets: results.every((sample) => sample.meetsBenchmarkTargets),
  releaseGateQualified: false,
  releaseGateReason: "AliMeeting is a public diagnostic benchmark and does not replace consented real-user meeting, device, share, or Obsidian acceptance evidence.",
  rawTranscriptIncluded: false,
};
mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
chmodSync(outputPath, 0o600);
console.log(
  JSON.stringify(
    {
      ok: true,
      outputPath,
      sampleCount: report.sampleCount,
      totalDurationSeconds: report.totalDurationSeconds,
      totals,
      sampleResults: results.map((sample) => ({
        id: sample.id,
        referenceSpeakerCount: sample.referenceSpeakerCount,
        providerSpeakerCount: sample.providerSpeakerCount,
        providerUtteranceCount: sample.providerUtteranceCount,
        cerPct: sample.cerPct,
        majorReferenceTurnAttributionPct: sample.majorReferenceTurnAttributionPct,
        speakerClusterPurityPct: sample.speakerClusterPurityPct,
        meetsBenchmarkTargets: sample.meetsBenchmarkTargets,
      })),
      meetsBenchmarkTargets: report.meetsBenchmarkTargets,
      releaseGateQualified: false,
      rawTranscriptIncluded: false,
    },
    null,
    2,
  ),
);

function aggregate(samples) {
  const referenceCharacters = samples.reduce((sum, sample) => sum + sample.referenceCharacterCount, 0);
  const editDistance = samples.reduce((sum, sample) => sum + sample.editDistance, 0);
  const referenceTurns = samples.reduce((sum, sample) => sum + sample.referenceTurnCount, 0);
  const correctTurns = samples.reduce((sum, sample) => sum + sample.correctlyAttributedReferenceTurnCount, 0);
  const majorReferenceTurns = samples.reduce((sum, sample) => sum + sample.majorReferenceTurnCount, 0);
  const correctMajorTurns = samples.reduce((sum, sample) => sum + sample.correctlyAttributedMajorReferenceTurnCount, 0);
  const referenceSpeechMs = samples.reduce((sum, sample) => sum + sample.referenceSpeechMs, 0);
  const correctOverlapMs = samples.reduce((sum, sample) => sum + sample.correctlyAttributedOverlapMs, 0);
  return {
    referenceCharacterCount: referenceCharacters,
    editDistance,
    cerPct: referenceCharacters === 0 ? null : round3((editDistance / referenceCharacters) * 100),
    referenceTurnCount: referenceTurns,
    correctlyAttributedReferenceTurnCount: correctTurns,
    referenceTurnAttributionPct: referenceTurns === 0 ? null : round3((correctTurns / referenceTurns) * 100),
    majorReferenceTurnCount: majorReferenceTurns,
    correctlyAttributedMajorReferenceTurnCount: correctMajorTurns,
    majorReferenceTurnAttributionPct:
      majorReferenceTurns === 0 ? null : round3((correctMajorTurns / majorReferenceTurns) * 100),
    referenceSpeechMs: round3(referenceSpeechMs),
    correctlyAttributedOverlapMs: round3(correctOverlapMs),
    speakerAttributedReferenceCoveragePct:
      referenceSpeechMs === 0 ? null : round3((correctOverlapMs / referenceSpeechMs) * 100),
  };
}

function loadDotEnvLocal() {
  if (!existsSync(".env.local")) return;
  for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator < 1) continue;
    const key = trimmed.slice(0, separator);
    const rawValue = trimmed.slice(separator + 1);
    if (!process.env[key]) process.env[key] = stripQuotes(rawValue);
  }
}

function stripQuotes(value) {
  return (value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")) ? value.slice(1, -1) : value;
}

function parseArgs(args) {
  return Object.fromEntries(
    args
      .filter((arg) => arg.startsWith("--"))
      .map((arg) => {
        const [key, ...value] = arg.slice(2).split("=");
        return [key.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()), value.join("=") || true];
      }),
  );
}

function round3(value) {
  return Math.round(value * 1000) / 1000;
}

function fail(message) {
  console.error(JSON.stringify({ ok: false, error: String(message).replace(/[\r\n]+/g, " ").slice(0, 240) }, null, 2));
  process.exit(1);
}
