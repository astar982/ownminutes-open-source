#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  asrSpeechFilter,
  defaultAsrSpeechFilter,
  mildAsrSpeechFilter,
  normalizeAudioFileForVolcanoAsr,
  normalizeAudioForVolcanoAsr,
} from "../src/lib/audio-normalization.ts";

const wav = buildSilentWav(16_000, 1);
const quietTone = buildToneWav(16_000, 3, 1_000, 0.01);
assert.equal(asrSpeechFilter(), defaultAsrSpeechFilter);
assert.equal(asrSpeechFilter("off"), defaultAsrSpeechFilter);
assert.equal(asrSpeechFilter("unexpected"), defaultAsrSpeechFilter);
assert.equal(asrSpeechFilter("mild"), mildAsrSpeechFilter);
assert.match(mildAsrSpeechFilter, /highpass=f=80/);
assert.match(mildAsrSpeechFilter, /lowpass=f=7600/);
assert.match(mildAsrSpeechFilter, /afftdn=nr=6:nf=-35:tn=1:gs=5/);
const direct = await normalizeAudioForVolcanoAsr({
  buffer: wav,
  fileName: "meeting.wav",
  mimeType: "audio/wav",
});
assert.equal(direct.transcoded, true);
assert.equal(direct.fileName, "meeting.ogg");
assert.equal(direct.mimeType, "audio/ogg");
assert.equal(direct.buffer.subarray(0, 4).toString("ascii"), "OggS");

const webm = spawnSync("ffmpeg", [
  "-hide_banner",
  "-loglevel",
  "error",
  "-f",
  "wav",
  "-i",
  "pipe:0",
  "-codec:a",
  "libopus",
  "-f",
  "webm",
  "pipe:1",
], { input: wav, maxBuffer: 4_000_000 });
if (webm.error) throw new Error(`Fixture encoding could not start ffmpeg: ${webm.error.message}`);
if (webm.status !== 0) throw new Error(`Fixture encoding failed: ${webm.stderr?.toString("utf8") || `exit ${webm.status}`}`);

const normalized = await normalizeAudioForVolcanoAsr({
  buffer: webm.stdout,
  fileName: "meeting.webm",
  mimeType: "audio/webm;codecs=opus",
});
assert.equal(normalized.transcoded, true);
assert.equal(normalized.fileName, "meeting.ogg");
assert.equal(normalized.mimeType, "audio/ogg");
assert.ok(normalized.buffer.byteLength > 100);
assert.equal(normalized.buffer.subarray(0, 4).toString("ascii"), "OggS");

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ownminutes-audio-normalization-"));
let fileNormalized;
let toneMetrics;
try {
  const webmPath = path.join(directory, "meeting.webm");
  fs.writeFileSync(webmPath, webm.stdout, { mode: 0o600 });
  fileNormalized = await normalizeAudioFileForVolcanoAsr({
    filePath: webmPath,
    fileName: "meeting.webm",
    mimeType: "audio/webm;codecs=opus",
  });
  assert.equal(fileNormalized.transcoded, true);
  assert.equal(fileNormalized.fileName, "meeting.ogg");
  assert.equal(fileNormalized.mimeType, "audio/ogg");
  assert.equal(fs.readFileSync(fileNormalized.filePath).subarray(0, 4).toString("ascii"), "OggS");
  assert.equal(fs.statSync(fileNormalized.filePath).mode & 0o777, 0o600);

  const toneNormalized = await normalizeAudioForVolcanoAsr({
    buffer: quietTone,
    fileName: "quiet-tone.wav",
    mimeType: "audio/wav",
  });
  const tonePath = path.join(directory, "quiet-tone.ogg");
  fs.writeFileSync(tonePath, toneNormalized.buffer, { mode: 0o600 });
  const probe = spawnSync("ffprobe", [
    "-v",
    "error",
    "-select_streams",
    "a:0",
    "-show_entries",
    "stream=codec_name,channels",
    "-of",
    "json",
    tonePath,
  ], { encoding: "utf8" });
  assert.equal(probe.status, 0);
  const stream = JSON.parse(probe.stdout).streams?.[0];
  assert.equal(stream?.codec_name, "opus");
  assert.equal(stream?.channels, 1);
  const volume = spawnSync("ffmpeg", [
    "-hide_banner",
    "-nostats",
    "-i",
    tonePath,
    "-af",
    "volumedetect",
    "-f",
    "null",
    "-",
  ], { encoding: "utf8" });
  const meanVolume = Number(`${volume.stderr}`.match(/mean_volume:\s*(-?[\d.]+) dB/)?.[1]);
  assert.ok(Number.isFinite(meanVolume) && meanVolume >= -21.5 && meanVolume <= -18.5);
  toneMetrics = { codec: stream.codec_name, channels: stream.channels, meanVolumeDb: meanVolume };
} finally {
  fs.rmSync(directory, { force: true, recursive: true });
}

console.log(JSON.stringify({
  directWavBytes: direct.buffer.byteLength,
  denoiseProfile: asrSpeechFilter("mild"),
  normalizedOggBytes: normalized.buffer.byteLength,
  toneMetrics,
  fileNormalization: fileNormalized?.transcoded === true,
  webmBytes: webm.stdout.byteLength,
}, null, 2));

function buildSilentWav(sampleRate, seconds) {
  const dataBytes = sampleRate * seconds * 2;
  const output = Buffer.alloc(44 + dataBytes);
  output.write("RIFF", 0);
  output.writeUInt32LE(36 + dataBytes, 4);
  output.write("WAVEfmt ", 8);
  output.writeUInt32LE(16, 16);
  output.writeUInt16LE(1, 20);
  output.writeUInt16LE(1, 22);
  output.writeUInt32LE(sampleRate, 24);
  output.writeUInt32LE(sampleRate * 2, 28);
  output.writeUInt16LE(2, 32);
  output.writeUInt16LE(16, 34);
  output.write("data", 36);
  output.writeUInt32LE(dataBytes, 40);
  return output;
}

function buildToneWav(sampleRate, seconds, frequency, amplitude) {
  const output = buildSilentWav(sampleRate, seconds);
  const samples = sampleRate * seconds;
  for (let index = 0; index < samples; index += 1) {
    const value = Math.round(Math.sin((2 * Math.PI * frequency * index) / sampleRate) * 32767 * amplitude);
    output.writeInt16LE(value, 44 + index * 2);
  }
  return output;
}
