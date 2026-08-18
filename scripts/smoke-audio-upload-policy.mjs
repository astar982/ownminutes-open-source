#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  acquireFullRecordingAdmission,
  AudioUploadPolicyError,
  getAudioUploadPolicy,
  requestClaimsFullRecording,
  shouldAcquireFullRecordingAdmission,
  validateAudioRequestContentLength,
  validateFullRecordingDuration,
  validateUploadedAudio,
} from "../src/lib/server/audio-upload-policy.ts";

const mebibyte = 1024 * 1024;
const environmentKeys = [
  "OWNMINUTES_FULL_AUDIO_MAX_BYTES",
  "OWNMINUTES_FULL_AUDIO_MAX_DURATION_MS",
  "OWNMINUTES_FULL_AUDIO_MAX_PARALLEL",
  "OWNMINUTES_AUDIO_CHUNK_MAX_BYTES",
];
const savedEnvironment = Object.fromEntries(environmentKeys.map((key) => [key, process.env[key]]));

try {
  for (const key of environmentKeys) delete process.env[key];
  const policy = getAudioUploadPolicy();
  assert.deepEqual(policy, {
    fullRecordingMaxBytes: 256 * mebibyte,
    fullRecordingMaxDurationMs: 2 * 60 * 60_000,
    fullRecordingMaxParallel: 2,
    regularChunkMaxBytes: 16 * mebibyte,
  });

  const claimedRequest = new Request("http://127.0.0.1/api/meetings/test/chunks?fullRecording=1", {
    headers: { "content-length": String(40 * mebibyte), "x-ownminutes-full-recording": "1" },
    method: "POST",
  });
  assert.equal(requestClaimsFullRecording(claimedRequest), true);
  const contentLength = validateAudioRequestContentLength(claimedRequest, policy);
  assert.equal(contentLength, 40 * mebibyte);
  assert.equal(shouldAcquireFullRecordingAdmission({ claimedFullRecording: true, contentLength, policy }), true);
  assert.equal(
    shouldAcquireFullRecordingAdmission({
      claimedFullRecording: false,
      contentLength: null,
      policy,
    }),
    true,
  );

  validateUploadedAudio({ fullRecording: true, mimeType: "audio/mp4", size: 45 * mebibyte, policy });
  validateUploadedAudio({ fullRecording: false, mimeType: "audio/webm;codecs=opus", size: mebibyte, policy });
  validateFullRecordingDuration(90 * 60_000, policy);

  assertPolicyError(
    () => validateAudioRequestContentLength(new Request("http://127.0.0.1/upload", { headers: { "content-length": String(258 * mebibyte) } }), policy),
    "AUDIO_UPLOAD_TOO_LARGE",
    413,
  );
  assertPolicyError(
    () => validateUploadedAudio({ fullRecording: false, mimeType: "audio/wav", size: 17 * mebibyte, policy }),
    "AUDIO_UPLOAD_TOO_LARGE",
    413,
  );
  assertPolicyError(
    () => validateUploadedAudio({ fullRecording: true, mimeType: "application/octet-stream", size: mebibyte, policy }),
    "UNSUPPORTED_AUDIO_TYPE",
    415,
  );
  assertPolicyError(() => validateFullRecordingDuration(2 * 60 * 60_000 + 1, policy), "AUDIO_DURATION_TOO_LONG", 413);

  const releaseFirst = acquireFullRecordingAdmission(policy);
  const releaseSecond = acquireFullRecordingAdmission(policy);
  assertPolicyError(() => acquireFullRecordingAdmission(policy), "AUDIO_UPLOAD_BUSY", 429);
  releaseFirst();
  const releaseReplacement = acquireFullRecordingAdmission(policy);
  releaseReplacement();
  releaseSecond();

  const appSource = readFileSync("apps/mobile/App.tsx", "utf8");
  const apiSource = readFileSync("apps/mobile/src/api.ts", "utf8");
  const routeSource = readFileSync("src/app/api/meetings/[id]/chunks/route.ts", "utf8");
  const resumableRouteSource = readFileSync("src/app/api/meetings/[id]/recording-upload/route.ts", "utf8");
  const resumableProtocolSource = readFileSync("src/lib/server/recording-upload-protocol.ts", "utf8");
  assert.match(appSource, /extension: "\.m4a"[\s\S]*bitRate: 64000/);
  assert.match(appSource, /ios: \{[\s\S]*extension: "\.caf"[\s\S]*sampleRate: 16000[\s\S]*outputFormat: IOSOutputFormat\.LINEARPCM/);
  assert.match(appSource, /linearPCMBitDepth: 16/);
  assert.match(appSource, /linearPCMIsBigEndian: false/);
  assert.match(appSource, /linearPCMIsFloat: false/);
  assert.match(apiSource, /recording-upload/);
  assert.match(apiSource, /recordingUploadPartBytes = 4 \* 1024 \* 1024/);
  assert.match(apiSource, /X-OwnMinutes-Part-Sha256/);
  assert.match(resumableRouteSource, /acquireFullRecordingAdmission\(\)/);
  assert.match(resumableProtocolSource, /validateUploadedAudio\(\{ fullRecording: true/);
  assert.match(resumableProtocolSource, /readBoundedBody\(request, expectedBytes\)/);
  assert.match(routeSource, /validateAudioRequestContentLength\(request, policy\)/);
  assert.match(routeSource, /readBoundedFormData\(request, getAudioUploadRequestMaxBytes\(policy\)\)/);
  assert.match(routeSource, /validateUploadedAudio\(\{ fullRecording, mimeType, size: chunk\.size, policy \}\)/);
  assert.match(routeSource, /validateFullRecordingDuration\(durationMs, policy\)/);

  console.log(JSON.stringify({
    defaultFullRecordingMaxMb: policy.fullRecordingMaxBytes / mebibyte,
    defaultFullRecordingMaxMinutes: policy.fullRecordingMaxDurationMs / 60_000,
    defaultFullRecordingMaxParallel: policy.fullRecordingMaxParallel,
    estimatedNinetyMinutePcmMib: Math.round((16_000 * 2 * 90 * 60) / mebibyte),
    iosDurableFormat: "16kHz mono 16-bit PCM/CAF",
    localRecordingRetainedOnUploadFailure: true,
    ok: true,
  }, null, 2));
} finally {
  for (const key of environmentKeys) {
    const value = savedEnvironment[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function assertPolicyError(callback, code, status) {
  assert.throws(callback, (error) => {
    assert.equal(error instanceof AudioUploadPolicyError, true);
    assert.equal(error.code, code);
    assert.equal(error.status, status);
    return true;
  });
}
