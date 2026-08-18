#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const baseUrl = (process.env.OWNMINUTES_REALTIME_ACCEPTANCE_BASE_URL || "http://127.0.0.1:3003").replace(/\/$/, "");
const samplePath = process.env.OWNMINUTES_REALTIME_SAMPLE_PATH?.trim();
const expectedPhrase = process.env.OWNMINUTES_REALTIME_EXPECTED_PHRASE?.trim() || "";
const expectedSegmentCount = Number(process.env.OWNMINUTES_REALTIME_EXPECTED_SEGMENT_COUNT || 0);
const evidencePath = resolve(
  process.env.OWNMINUTES_REALTIME_EVIDENCE_PATH || ".data/acceptance/realtime-asr-live-latest.json",
);

if (!samplePath) fail("Set OWNMINUTES_REALTIME_SAMPLE_PATH to an explicit 5-180 second speech sample.");

const workingDirectory = mkdtempSync(join(tmpdir(), "ownminutes-realtime-live-"));
const pcmPath = join(workingDirectory, "sample.pcm");
const meetingId = `rt-live-${Date.now()}-${randomUUID().slice(0, 8)}`;
const email = `${meetingId}@ownminutes.local`;
const password = `OwnMinutes-${randomUUID()}`;
let cookie = "";

try {
  convertToPcm(resolve(samplePath), pcmPath);
  const audio = readFileSync(pcmPath);
  const durationMs = Math.round((audio.byteLength / 2 / 16_000) * 1_000);
  if (durationMs < 5_000 || durationMs > 180_000) {
    fail(`Realtime acceptance sample must be 5-180 seconds; received ${durationMs} ms.`);
  }

  const register = await postJson(
    "/api/auth/register",
    { name: "Realtime Live Acceptance", email, password },
    { "x-forwarded-for": `198.51.100.${Math.floor(Math.random() * 200) + 1}` },
  );
  if (!register.response.ok || register.payload.ok !== true) fail("Could not create the isolated realtime acceptance account.");
  cookie = register.response.headers.get("set-cookie")?.split(";")[0] || "";
  if (!cookie) fail("Realtime acceptance registration did not return a session cookie.");

  const chunkBytes = 96_000;
  const statuses = [];
  const segments = new Map();
  for (let offset = 0, sequence = 1; offset < audio.byteLength; offset += chunkBytes, sequence += 1) {
    const actual = audio.subarray(offset, Math.min(audio.byteLength, offset + chunkBytes));
    const pcm = actual.byteLength === chunkBytes ? actual : Buffer.concat([actual, Buffer.alloc(chunkBytes - actual.byteLength)]);
    const formData = new FormData();
    formData.append("sequence", String(sequence));
    formData.append("mimeType", "audio/pcm;encoding=signed-integer;bits=16");
    formData.append("recordedAt", String(Date.now()));
    formData.append("durationMs", "3000");
    formData.append("sampleRate", "16000");
    formData.append("channels", "1");
    formData.append("chunk", new Blob([pcm], { type: "audio/pcm" }), `realtime-${sequence}.pcm`);

    const response = await fetch(`${baseUrl}/api/meetings/${meetingId}/realtime-chunks`, {
      method: "POST",
      headers: { Cookie: cookie },
      body: formData,
    });
    const payload = await readJson(response, "realtime chunk");
    statuses.push(payload.providerStatus || `http-${response.status}`);
    if (!response.ok || payload.providerStatus === "provider_error" || payload.providerStatus === "rejected_format") {
      fail(`Realtime chunk ${sequence} failed with ${payload.providerStatus || response.status}.`);
    }
    if (payload.transcriptSegment?.id && payload.transcriptSegment?.text) {
      segments.set(payload.transcriptSegment.id, payload.transcriptSegment);
    }
  }

  const finishResponse = await fetch(`${baseUrl}/api/meetings/${meetingId}/realtime-chunks`, {
    method: "DELETE",
    headers: { Cookie: cookie },
  });
  const finishPayload = await readJson(finishResponse, "finish realtime session");
  if (finishPayload.transcriptSegment?.id && finishPayload.transcriptSegment?.text) {
    segments.set(finishPayload.transcriptSegment.id, finishPayload.transcriptSegment);
  }

  const sessionResponse = await fetch(`${baseUrl}/api/meetings/${meetingId}/realtime-chunks`, {
    headers: { Cookie: cookie },
  });
  const sessionPayload = await readJson(sessionResponse, "realtime session status");
  const transcript = [...segments.values()].map((segment) => segment.text.trim()).filter(Boolean).join("\n");
  const expectedPhraseMatched = expectedPhrase ? transcript.includes(expectedPhrase) : null;
  const summary = {
    ok:
      finishResponse.ok &&
      finishPayload.providerStatus === "completed" &&
      transcript.length > 0 &&
      !statuses.includes("provider_error") &&
      !statuses.includes("rejected_format") &&
      expectedPhraseMatched !== false &&
      (expectedSegmentCount <= 0 || segments.size === expectedSegmentCount),
    checkedAt: new Date().toISOString(),
    baseUrlHost: new URL(baseUrl).host,
    durationMs,
    inputBytes: audio.byteLength,
    chunkCount: statuses.length,
    draftCount: statuses.filter((status) => status === "draft").length,
    acceptedCount: statuses.filter((status) => status === "accepted").length,
    providerErrorCount: statuses.filter((status) => status === "provider_error").length,
    rejectedFormatCount: statuses.filter((status) => status === "rejected_format").length,
    finalProviderStatus: finishPayload.providerStatus || null,
    transcriptCharacters: transcript.length,
    uniqueTranscriptSegments: segments.size,
    expectedPhraseConfigured: Boolean(expectedPhrase),
    expectedPhraseMatched,
    expectedSegmentCount: expectedSegmentCount > 0 ? expectedSegmentCount : null,
    sessionChunkCount: sessionPayload.realtimeSession?.chunkCount ?? null,
    sessionLastProviderStatus: sessionPayload.realtimeSession?.lastProviderStatus ?? null,
    transcriptStoredInEvidence: false,
    secretsPrinted: false,
    temporaryAccountDeleted: false,
  };

  const deleteResult = await deleteTemporaryAccount();
  summary.temporaryAccountDeleted = deleteResult;
  if (!deleteResult) summary.ok = false;
  writeEvidence(summary);
  console.log(JSON.stringify(summary, null, 2));
  if (!summary.ok) process.exitCode = 1;
} finally {
  if (cookie) await deleteTemporaryAccount();
  rmSync(workingDirectory, { force: true, recursive: true });
}

function convertToPcm(inputPath, outputPath) {
  const result = spawnSync(
    "ffmpeg",
    ["-hide_banner", "-loglevel", "error", "-y", "-i", inputPath, "-f", "s16le", "-acodec", "pcm_s16le", "-ac", "1", "-ar", "16000", outputPath],
    { encoding: "utf8" },
  );
  if (result.error) fail(`Could not run ffmpeg: ${result.error.message}`);
  if (result.status !== 0) fail(`ffmpeg could not normalize the sample: ${String(result.stderr || "unknown error").slice(0, 300)}`);
}

async function deleteTemporaryAccount() {
  if (!cookie) return true;
  const response = await fetch(`${baseUrl}/api/auth/delete`, { method: "DELETE", headers: { Cookie: cookie } });
  if (response.ok) cookie = "";
  return response.ok;
}

async function postJson(path, body, headers = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return { response, payload: await readJson(response, path) };
}

async function readJson(response, label) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    fail(`${label} returned invalid JSON (HTTP ${response.status}).`);
  }
}

function writeEvidence(summary) {
  mkdirSync(dirname(evidencePath), { recursive: true });
  writeFileSync(evidencePath, `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
}

function fail(message) {
  throw new Error(message);
}
