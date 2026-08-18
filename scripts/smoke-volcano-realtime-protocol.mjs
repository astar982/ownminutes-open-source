#!/usr/bin/env node

import { gunzipSync } from "node:zlib";
import { WebSocketServer } from "ws";
import {
  buildVolcanoProtocolFrame,
  createVolcanoRealtimeSession,
  parseVolcanoProtocolResponse,
  resetVolcanoRealtimeSessionsForTests,
  transcribeWithVolcanoRealtime,
} from "../src/lib/server/volcano-realtime-asr.ts";

const apiKey = "protocol-smoke-secret-key";
const resourceId = "volc.seedasr.sauc.duration";
const observed = {
  audioFrames: 0,
  finalFrames: 0,
  fullRequests: 0,
  headersOk: false,
  initialPayloadOk: false,
  managerConnections: 0,
  sequences: [],
};

const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
await new Promise((resolve) => server.once("listening", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("Mock WebSocket server did not expose a port.");

server.on("connection", (socket, request) => {
  const managerConnection = request.url === "/manager";
  const silentChunkConnection = request.url === "/silent-chunk";
  if (managerConnection) observed.managerConnections += 1;
  observed.headersOk =
    request.headers["x-api-key"] === apiKey &&
    request.headers["x-api-connect-id"] === request.headers["x-api-request-id"] &&
    request.headers["x-api-resource-id"] === resourceId &&
    typeof request.headers["x-api-request-id"] === "string" &&
    request.headers["x-api-sequence"] === "-1";

  socket.on("message", (data) => {
    const frame = parseClientFrame(Buffer.from(data));
    observed.sequences.push(frame.sequence);
    if (frame.messageType === 0x1) {
      observed.fullRequests += 1;
      const payload = JSON.parse(frame.payload.toString("utf8"));
      observed.initialPayloadOk =
        payload.audio?.format === "pcm" &&
        payload.audio?.rate === 16000 &&
        payload.audio?.channel === 1 &&
        payload.request?.model_name === "bigmodel" &&
        payload.request?.show_utterances === true &&
        payload.request?.enable_speaker_info === true;
      socket.send(serverResponse(frame.sequence, { result: { text: "", utterances: [] } }));
      return;
    }

    if (frame.messageType !== 0x2) return;
    if (frame.flags === 0x3) {
      observed.finalFrames += 1;
      socket.send(
        serverResponse(
          frame.sequence,
          {
            result: {
              text: "测试会议结束。",
              utterances: [{ definite: true, start_time: 0, end_time: 1200, speaker_id: 1, text: "测试会议结束。" }],
            },
          },
          0x3,
        ),
      );
      return;
    }

    observed.audioFrames += 1;
    if (silentChunkConnection) return;
    socket.send(
      serverResponse(frame.sequence, {
        result: {
          text: "这是实时转写测试。",
          utterances: [{ definite: true, start_time: 0, end_time: 1000, speaker_id: 1, text: "这是实时转写测试。" }],
        },
      }),
    );
    if (managerConnection) setTimeout(() => socket.close(1012, "smoke-reconnect"), 5);
  });
});

const session = createVolcanoRealtimeSession({
  config: {
    apiKey,
    resourceId,
    wsUrl: `ws://127.0.0.1:${address.port}/direct`,
  },
  meetingId: "protocol-smoke",
  ownerUserId: "protocol-smoke-user",
});

const chunkResult = await session.acceptChunk({
  buffer: Buffer.alloc(3_200, 1),
  channels: 1,
  durationMs: 100,
  meetingId: "protocol-smoke",
  ownerUserId: "protocol-smoke-user",
  recordedAt: Date.now(),
  sampleRate: 16_000,
  sequence: 1,
});
const finishResult = await session.finish();
session.close("smoke-complete");
const silentSession = createVolcanoRealtimeSession({
  config: {
    apiKey,
    resourceId,
    wsUrl: `ws://127.0.0.1:${address.port}/silent-chunk`,
  },
  meetingId: "protocol-silent-chunk-smoke",
  ownerUserId: "protocol-silent-chunk-user",
});
const silentStartedAt = Date.now();
const silentChunkResult = await silentSession.acceptChunk({
  buffer: Buffer.alloc(3_200, 3),
  channels: 1,
  durationMs: 100,
  meetingId: "protocol-silent-chunk-smoke",
  ownerUserId: "protocol-silent-chunk-user",
  recordedAt: Date.now(),
  sampleRate: 16_000,
  sequence: 1,
});
const silentChunkElapsedMs = Date.now() - silentStartedAt;
const silentFinishResult = await silentSession.finish();
silentSession.close("silent-smoke-complete");
const managerRuntime = {
  providerId: "volcano-asr",
  fields: {
    VOLCANO_ASR_WS_URL: `ws://127.0.0.1:${address.port}/manager`,
    VOLCANO_REALTIME_ASR_RESOURCE_ID: resourceId,
  },
  secrets: { VOLCANO_ASR_API_KEY: apiKey },
};
const managerInput = {
  buffer: Buffer.alloc(3_200, 2),
  channels: 1,
  durationMs: 100,
  meetingId: "manager-reconnect-smoke",
  ownerUserId: "manager-reconnect-user",
  providerRuntime: managerRuntime,
  recordedAt: Date.now(),
  sampleRate: 16_000,
  sequence: 1,
};
const firstManagerResult = await transcribeWithVolcanoRealtime(managerInput);
const managerResults = [firstManagerResult];
for (let sequence = 2; sequence <= 6; sequence += 1) {
  await new Promise((resolve) => setTimeout(resolve, 30));
  managerResults.push(await transcribeWithVolcanoRealtime({ ...managerInput, sequence }));
}
resetVolcanoRealtimeSessionsForTests();
await new Promise((resolve) => server.close(resolve));

const parserRoundTrip = parseVolcanoProtocolResponse(
  serverResponse(9, { result: { text: "round trip", utterances: [] } }),
);
const serialized = JSON.stringify({ chunkResult, finishResult, silentChunkResult, silentFinishResult, managerResults, observed, parserRoundTrip });
const checks = {
  authenticatedWithApiKey: observed.headersOk,
  sentInitialRequest: observed.fullRequests === 8 && observed.initialPayloadOk,
  sentAudioFrame: observed.audioFrames === 8,
  returnedDraft: chunkResult.providerStatus === "draft" && chunkResult.transcriptSegment?.text === "这是实时转写测试。",
  preservedSpeaker: chunkResult.transcriptSegment?.speaker === "Speaker 1",
  silentChunkDoesNotBlockQueue: silentChunkResult.providerStatus === "accepted" && silentChunkElapsedMs < 1_000,
  silentChunkStillFinalizes: silentFinishResult.transcriptSegment?.text === "测试会议结束。",
  sentFinalNegativeSequence: observed.finalFrames === 2 && observed.sequences.filter((sequence) => sequence < 0).length === 2,
  returnedFinalTranscript: finishResult.transcriptSegment?.text === "测试会议结束。",
  finalReplacesCumulativeDraft: finishResult.transcriptSegment?.id === chunkResult.transcriptSegment?.id,
  parserRoundTrip: parserRoundTrip.sequence === 9 && parserRoundTrip.messageType === 0x9,
  survivesRepeatedFreshSessionReconnects:
    observed.managerConnections === managerResults.length &&
    managerResults.every((result) => result.providerStatus === "draft") &&
    managerResults.slice(1).every((result) => result.diagnostic?.includes("connection was recreated")),
  doesNotLeakSecret: !serialized.includes(apiKey),
};

console.log(JSON.stringify(checks, null, 2));
if (Object.values(checks).some((value) => !value)) process.exitCode = 1;

function serverResponse(sequence, payload, flags = 0x1) {
  return buildVolcanoProtocolFrame({
    flags,
    messageType: 0x9,
    payload: Buffer.from(JSON.stringify(payload), "utf8"),
    sequence,
    serialization: 1,
  });
}

function parseClientFrame(frame) {
  const headerSize = (frame[0] & 0x0f) * 4;
  const messageType = frame[1] >> 4;
  const flags = frame[1] & 0x0f;
  const compression = frame[2] & 0x0f;
  let offset = headerSize;
  const sequence = flags & 0x1 ? frame.readInt32BE(offset) : 0;
  if (flags & 0x1) offset += 4;
  const payloadSize = frame.readUInt32BE(offset);
  offset += 4;
  const compressedPayload = frame.subarray(offset, offset + payloadSize);
  return {
    flags,
    messageType,
    payload: compression === 1 ? gunzipSync(compressedPayload) : compressedPayload,
    sequence,
  };
}
