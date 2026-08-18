#!/usr/bin/env node

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { sha256File } from "./lib/alimeeting-public-benchmark.mjs";

const options = parseArgs(process.argv.slice(2));
const manifestPath = resolve(options.manifest || "scripts/fixtures/alimeeting-public-benchmark.json");
const datasetRoot = resolve(options.datasetRoot || ".data/acceptance/datasets/alimeeting");
const archivePath = resolve(options.archive || join(datasetRoot, "Eval_Ali.tar.gz"));
const extractedRoot = resolve(options.extractedRoot || join(datasetRoot, "extracted"));
const sampleRoot = resolve(options.sampleRoot || join(datasetRoot, "samples"));
const preparedManifestPath = resolve(options.output || join(datasetRoot, "prepared-manifest.json"));
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));

if (!existsSync(archivePath)) {
  if (!options.download) fail(`AliMeeting archive is missing at ${archivePath}. Re-run with --download or pass --archive.`);
  mkdirSync(dirname(archivePath), { recursive: true });
  run("curl", ["--fail", "--location", "--continue-at", "-", "--output", archivePath, manifest.archive.url], "AliMeeting download failed");
}

const archiveSha256 = await sha256File(archivePath);
if (archiveSha256 !== manifest.archive.sha256) fail("AliMeeting archive SHA-256 does not match the pinned manifest.");
chmodSync(archivePath, 0o600);
mkdirSync(extractedRoot, { recursive: true });
mkdirSync(sampleRoot, { recursive: true });

const preparedSamples = [];
for (const sample of manifest.samples) {
  const audioPath = join(extractedRoot, sample.audioArchivePath);
  const textGridPath = join(extractedRoot, sample.textGridArchivePath);
  if (!existsSync(audioPath) || !existsSync(textGridPath)) {
    run(
      "tar",
      ["-xzf", archivePath, "-C", extractedRoot, sample.audioArchivePath, sample.textGridArchivePath],
      `Unable to extract ${sample.id}`,
    );
  }
  chmodSync(audioPath, 0o600);
  chmodSync(textGridPath, 0o600);

  const samplePath = join(sampleRoot, `${sample.id}.wav`);
  if (!existsSync(samplePath) || options.force) {
    run(
      "ffmpeg",
      [
        "-v",
        "error",
        "-y",
        "-ss",
        String(sample.startSeconds),
        "-t",
        String(sample.durationSeconds),
        "-i",
        audioPath,
        "-map",
        "0:a:0",
        "-af",
        `pan=mono|c0=c${sample.selectedChannel}`,
        "-ar",
        "16000",
        "-c:a",
        "pcm_s16le",
        samplePath,
      ],
      `Unable to prepare ${sample.id}`,
    );
  }
  chmodSync(samplePath, 0o600);
  const audioProbe = probeAudio(samplePath);
  if (audioProbe.channels !== 1 || audioProbe.sampleRate !== 16000 || Math.abs(audioProbe.durationSeconds - sample.durationSeconds) > 0.05) {
    fail(`Prepared sample ${sample.id} does not match mono/16 kHz/${sample.durationSeconds}s requirements.`);
  }
  preparedSamples.push({
    id: sample.id,
    samplePath,
    textGridPath,
    sampleSha256: await sha256File(samplePath),
    sampleBytes: Number(audioProbe.bytes),
    durationSeconds: audioProbe.durationSeconds,
    channels: audioProbe.channels,
    sampleRate: audioProbe.sampleRate,
  });
}

const output = {
  schemaVersion: 1,
  preparedAt: new Date().toISOString(),
  source: manifest.source,
  archive: { path: archivePath, sha256: archiveSha256 },
  samples: preparedSamples,
  releaseGateQualified: false,
  releaseGateReason: "Public benchmark data cannot replace consented real-user meeting acceptance evidence.",
};
mkdirSync(dirname(preparedManifestPath), { recursive: true });
writeFileSync(preparedManifestPath, `${JSON.stringify(output, null, 2)}\n`, { mode: 0o600 });
chmodSync(preparedManifestPath, 0o600);
console.log(JSON.stringify({ ok: true, preparedManifestPath, sampleCount: preparedSamples.length, archiveSha256, releaseGateQualified: false }, null, 2));

function probeAudio(filePath) {
  const result = run(
    "ffprobe",
    ["-v", "error", "-select_streams", "a:0", "-show_entries", "stream=sample_rate,channels,duration:format=size,duration", "-of", "json", filePath],
    "ffprobe failed",
  );
  const parsed = JSON.parse(result.stdout);
  const stream = parsed.streams?.[0] ?? {};
  return {
    sampleRate: Number(stream.sample_rate),
    channels: Number(stream.channels),
    durationSeconds: Number(stream.duration || parsed.format?.duration),
    bytes: Number(parsed.format?.size),
  };
}

function run(command, args, errorMessage) {
  const result = spawnSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 10 * 1024 * 1024 });
  if (result.error || result.status !== 0) fail(`${errorMessage}: ${sanitize(result.stderr || result.error?.message)}`);
  return result;
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

function sanitize(value) {
  return String(value || "").replace(/[\r\n]+/g, " ").slice(0, 240);
}

function fail(message) {
  console.error(JSON.stringify({ ok: false, error: sanitize(message) }, null, 2));
  process.exit(1);
}
