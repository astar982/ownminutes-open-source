#!/usr/bin/env node

import { readFileSync } from "node:fs";

const {
  maxRealtimeChunkBytes,
  readRealtimeChunkRequest,
  RealtimeChunkRequestError,
} = await import("../src/lib/server/realtime-chunk-request.ts");

const pcmBytes = new Uint8Array(96_000);
for (let index = 0; index < pcmBytes.length; index += 1) pcmBytes[index] = index % 251;

const binaryPayload = await readRealtimeChunkRequest(
  new Request("https://app.example.com/api/meetings/native/realtime-chunks", {
    method: "POST",
    headers: {
      "Content-Type": "audio/pcm",
      "X-OwnMinutes-Channels": "1",
      "X-OwnMinutes-Duration-Ms": "3000",
      "X-OwnMinutes-Mime-Type": "audio/pcm;encoding=signed-integer;bits=16",
      "X-OwnMinutes-Recorded-At": "1783983000000",
      "X-OwnMinutes-Sample-Rate": "16000",
      "X-OwnMinutes-Sequence": "7",
    },
    body: pcmBytes,
  }),
);

const multipart = new FormData();
multipart.append("sequence", "8");
multipart.append("durationMs", "3000");
multipart.append("recordedAt", "1783983003000");
multipart.append("mimeType", "audio/pcm;encoding=signed-integer;bits=16");
multipart.append("sampleRate", "16000");
multipart.append("channels", "1");
multipart.append("chunk", new Blob([pcmBytes], { type: "audio/pcm" }), "browser-realtime.pcm");
const multipartPayload = await readRealtimeChunkRequest(
  new Request("https://app.example.com/api/meetings/browser/realtime-chunks", {
    method: "POST",
    body: multipart,
  }),
);

const invalidType = await captureRequestError(
  new Request("https://app.example.com/api/meetings/native/realtime-chunks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  }),
);
const oversized = await captureRequestError(
  new Request("https://app.example.com/api/meetings/native/realtime-chunks", {
    method: "POST",
    headers: { "Content-Type": "audio/pcm" },
    body: new Uint8Array(maxRealtimeChunkBytes + 1),
  }),
);

const apiSource = readFileSync("apps/mobile/src/api.ts", "utf8");
const routeSource = readFileSync("src/app/api/meetings/[id]/realtime-chunks/route.ts", "utf8");
const recordingUploadSource = sourceBetween(apiSource, "export async function uploadMeetingAudio", "export function createRecordingUploadId");
const realtimeUploadSource = sourceBetween(apiSource, "export async function uploadRealtimePcmChunk", "export class RealtimeChunkUploadError");
const realtimeFinishSource = sourceBetween(apiSource, "export async function finishRealtimePcmSession", "export async function fetchProviderDiagnostic");
const checks = {
  acceptsNativeBinaryPcm:
    binaryPayload.buffer.byteLength === 96_000 &&
    binaryPayload.sequence === 7 &&
    binaryPayload.durationMs === 3000 &&
    binaryPayload.sampleRate === 16000 &&
    binaryPayload.channels === 1,
  keepsBrowserMultipartCompatibility:
    multipartPayload.buffer.byteLength === 96_000 && multipartPayload.sequence === 8 && multipartPayload.sampleRate === 16000,
  rejectsUnsupportedContentType: invalidType instanceof RealtimeChunkRequestError && invalidType.status === 415,
  rejectsOversizedBinaryBeforeProvider: oversized instanceof RealtimeChunkRequestError && oversized.status === 413,
  nativeClientDoesNotBuildBlobFromArrayBuffer:
    !realtimeUploadSource.includes('new Blob([params.bytes]') && !realtimeUploadSource.includes('formData.append("chunk"'),
  nativeClientUsesTemporaryBinaryFile:
    realtimeUploadSource.includes("ownminutes-realtime-${Crypto.randomUUID()}.pcm") &&
    realtimeUploadSource.includes("UploadType.BINARY_CONTENT") &&
    realtimeUploadSource.includes('sessionType: "foreground"') &&
    realtimeUploadSource.includes("uploadTemporaryNativeFileWithTimeout(") &&
    apiSource.includes("file.createUploadTask(url, { ...options, signal })") &&
    apiSource.includes("uploadTask.uploadAsync()") &&
    apiSource.includes("uploadTask.release();") &&
    apiSource.includes("safeDeleteTemporaryUploadFile(file);") &&
    realtimeUploadSource.includes("realtimeChunkUploadTimeoutMs") &&
    realtimeUploadSource.includes("safeDeleteTemporaryUploadFile(chunkFile)"),
  durableRecordingKeepsBackgroundUpload:
    recordingUploadSource.includes("UploadType.BINARY_CONTENT") &&
    recordingUploadSource.includes('sessionType: "background"') &&
    apiSource.includes("file.createUploadTask(url, { ...options, signal })") &&
    apiSource.includes("uploadTask.uploadAsync()") &&
    apiSource.includes("uploadTask.release();") &&
    apiSource.includes("safeDeleteTemporaryUploadFile(file);") &&
    recordingUploadSource.includes("part-${partIndex}-${Crypto.randomUUID()}.bin"),
  nativeMetadataAndSessionAreExplicit:
    realtimeUploadSource.includes('"X-OwnMinutes-Sequence"') &&
    realtimeUploadSource.includes('"X-OwnMinutes-Duration-Ms"') &&
    realtimeUploadSource.includes('"X-OwnMinutes-Sample-Rate"') &&
    realtimeUploadSource.includes("...buildSessionHeaders(params.authCookie)"),
  freezesProcessingModeOnFirstRealtimeContact:
    realtimeUploadSource.includes('"x-ownminutes-processing-mode": params.processingMode') &&
    realtimeFinishSource.includes('"x-ownminutes-processing-mode": params.processingMode'),
  interruptedRecoveryFinishesExistingRealtimeOnly:
    realtimeFinishSource.includes("finishRealtimePcmSessionIfPresent") &&
    realtimeFinishSource.includes('if (response.status === 404) return null') &&
    realtimeFinishSource.includes('lastProviderStatus === "completed"'),
  providerFinishFailureIsNotTreatedAsSuccess:
    realtimeFinishSource.includes('!response.ok || !payload.ok || payload.providerStatus !== "completed"'),
  routeUsesDualFormatParser:
    routeSource.includes("readRealtimeChunkRequest(request)") && routeSource.includes("RealtimeChunkRequestError"),
};

console.log(JSON.stringify(checks, null, 2));
if (Object.values(checks).some((value) => !value)) process.exitCode = 1;

async function captureRequestError(request) {
  try {
    await readRealtimeChunkRequest(request);
    return null;
  } catch (error) {
    return error;
  }
}

function sourceBetween(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex);
  if (startIndex < 0 || endIndex < 0) return "";
  return source.slice(startIndex, endIndex);
}
