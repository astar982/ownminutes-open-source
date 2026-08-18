#!/usr/bin/env node

import { readFileSync } from "node:fs";
import {
  isRealtimeUploadQueueCancelledError,
  nextRealtimeUploadSequence,
  realtimeCaptureMayResume,
  realtimeFailureCooldownMs,
  realtimeSequenceAfterFailure,
  RealtimeUploadQueue,
  RealtimeUploadQueueCancelledError,
} from "../apps/mobile/src/realtime-upload-queue.ts";

// Deterministic accelerated regression gate. It validates the mobile queue
// and recording-lifecycle contract in CI, but it does not replace the required
// 30/90-minute physical-iPhone acceptance evidence.

const bufferIntervalMs = 100;
const sampleRate = 16_000;
const channels = 1;
const bytesPerSample = 2;
const bufferBytes = Math.round(sampleRate * channels * bytesPerSample * (bufferIntervalMs / 1000));
const chunkTargetMs = 10_000;
const chunkTargetBytes = Math.round(sampleRate * channels * bytesPerSample * (chunkTargetMs / 1000));
const queueLimit = 6;
const thirtyMinuteBufferCount = 30 * 60 * (1000 / bufferIntervalMs);
const secondSessionBufferCount = 60 * (1000 / bufferIntervalMs);

async function main() {
const harness = new AcceleratedMobileRecordingHarness();

harness.startSession("soak-30m", "degraded");
// Deliberately feed the first 100 seconds without yielding. A real slow
// transport can receive audio faster than it completes requests; this burst
// deterministically proves that the queue reaches, but never exceeds, its cap.
await harness.ingestBuffers(1_000, { yieldEveryChunks: 0 });
await harness.drainRealtime(2_000);
await harness.ingestBuffers(thirtyMinuteBufferCount - 1_000, { yieldEveryChunks: 1 });
const firstRecording = await harness.stopSession("user");

// Reuse the same recorder harness and queue after the degraded session. This
// catches leaked cooldown/generation state that would block a second meeting.
harness.startSession("soak-after-failure", "healthy");
await harness.ingestBuffers(secondSessionBufferCount, { yieldEveryChunks: 1 });
const secondRecording = await harness.stopSession("user");

const appSource = readFileSync("apps/mobile/App.tsx", "utf8");
const packageSource = readFileSync("package.json", "utf8");
const ciSource = readFileSync(".github/workflows/ci.yml", "utf8");
const audioStreamCallback = sourceBetween(appSource, "onBuffer: (buffer) => {", "},\n  });");
const realtimeFailureFlow = sourceBetween(appSource, "void upload.then(", "async function pushRealtimePcmChunk");
const startRecordingFlow = sourceBetween(appSource, "async function doStartRecording(", "async function pauseRecording()");
const stopRecordingFlow = sourceBetween(
  appSource,
  "async function stopRecording(reason?: RecordingStopReason)",
  "stopRecordingRef.current = stopRecording",
);
const durableStopIndex = stopRecordingFlow.indexOf("recorder.stop()");
const secondaryStopIndex = stopRecordingFlow.indexOf("audioStream.stream.stop()");
const firstUploadedSequences = harness.uploadedSequencesByMeeting.get("soak-30m") ?? [];
const secondUploadedSequences = harness.uploadedSequencesByMeeting.get("soak-after-failure") ?? [];
const uploadedSequencesAreContiguous = [firstUploadedSequences, secondUploadedSequences].every(
  (sequences) =>
    sequences.length > 0 &&
    sequences.every((sequence, index) => sequence === (index === 0 ? 1 : sequences[index - 1] + 1)),
);
const maxRealtimeMemoryBytes = (queueLimit + 1) * chunkTargetBytes;

const checks = {
  simulatesExactlyThirtyMinutes:
    thirtyMinuteBufferCount === 18_000 &&
    firstRecording.bufferCount === 18_000 &&
    firstRecording.durationMs === 1_800_000,
  durableAudioKeepsEveryPcmBuffer:
    firstRecording.bytes === thirtyMinuteBufferCount * bufferBytes &&
    firstRecording.bytes === 57_600_000,
  usesTenSecondRealtimeChunks: chunkTargetBytes === 320_000 && harness.fullChunksCreated > 0,
  exercisesSlowAndTimeoutTransport:
    harness.transportStats.slow > 0 &&
    harness.transportStats.timeout > 0 &&
    harness.realtimeFailures > 0,
  cooldownRecoversAfterNetworkReturns:
    harness.maxFailureStreak > 0 &&
    harness.cooldownSkips > 0 &&
    harness.recoveredAfterFailure,
  boundsQueueAndRealtimeMemory:
    harness.maxQueuePending === queueLimit &&
    harness.droppedChunks > 0 &&
    harness.maxRealtimeBytes <= maxRealtimeMemoryBytes &&
    harness.retainedRealtimeBytes === 0,
  preservesRealtimeSequenceAfterFailure:
    harness.uploadedSequences.length > 0 && uploadedSequencesAreContiguous,
  realtimeFailureNeverStopsFormalRecorder:
    harness.unexpectedDurableStops === 0 &&
    firstRecording.stopReason === "user" &&
    firstRecording.bytes === 57_600_000,
  secondRecordingStartsAndPersists:
    harness.startedSessions === 2 &&
    secondRecording.meetingId === "soak-after-failure" &&
    secondRecording.bufferCount === 600 &&
    secondRecording.durationMs === 60_000 &&
    secondRecording.bytes === 1_920_000,
  appUsesSameChunkAndQueueBounds:
    /const realtimeChunkTargetMs = 10_000;/.test(appSource) &&
    /const realtimeChunkQueueLimit = 6;/.test(appSource),
  appDropsLiveDraftBeforeStoppingDurableAudio:
    realtimeFailureFlow.includes("queue.cancelPending()") &&
    realtimeFailureFlow.includes("realtimeFailureCooldownMs(") &&
    realtimeFailureFlow.includes("realtimeSequenceAfterFailure(") &&
    realtimeFailureFlow.includes('t("runtime.realtimeUploadFailed")') &&
    !realtimeFailureFlow.includes("stopRecording("),
  appSkipsPcmCopiesDuringCooldown:
    audioStreamCallback.indexOf("realtimeCaptureMayResume(") >= 0 &&
    audioStreamCallback.indexOf("realtimeCaptureMayResume(") < audioStreamCallback.indexOf("accumulateRealtimePcmBuffer(buffer)"),
  appResetsRealtimeStateForNextMeeting:
    startRecordingFlow.includes("resetRealtimePcmBuffer(nextMeetingId, frozenProcessingMode)") &&
    appSource.includes("realtimeFailureStreakRef.current = 0") &&
    appSource.includes("realtimeRetryNotBeforeRef.current = 0"),
  appStopsDurableRecorderBeforeSecondaryStream:
    durableStopIndex >= 0 && secondaryStopIndex > durableStopIndex,
  packageExposesSoakGate: packageSource.includes('"smoke:mobile-recording-soak"'),
  ciRunsSoakGate: ciSource.includes("npm run smoke:mobile-recording-soak"),
};

console.log(
  JSON.stringify(
    {
      checks,
      evidence: {
        bufferBytes,
        chunkTargetBytes,
        cooldownSkips: harness.cooldownSkips,
        droppedChunks: harness.droppedChunks,
        firstRecording,
        fullChunksCreated: harness.fullChunksCreated,
        maxFailureStreak: harness.maxFailureStreak,
        maxQueuePending: harness.maxQueuePending,
        maxRealtimeBytes: harness.maxRealtimeBytes,
        realtimeFailures: harness.realtimeFailures,
        realtimeUploads: harness.uploadedSequences.length,
        secondRecording,
        transportStats: harness.transportStats,
      },
    },
    null,
    2,
  ),
);

if (Object.values(checks).some((value) => !value)) process.exitCode = 1;
}

class AcceleratedMobileRecordingHarness {
  activeSession = null;
  allUploadTasks = [];
  cooldownSkips = 0;
  droppedChunks = 0;
  fullChunksCreated = 0;
  maxFailureStreak = 0;
  maxQueuePending = 0;
  maxRealtimeBytes = 0;
  recoveredAfterFailure = false;
  recordings = [];
  realtimeFailures = 0;
  retainedRealtimeBytes = 0;
  startedSessions = 0;
  transportStats = { healthy: 0, slow: 0, timeout: 0 };
  unexpectedDurableStops = 0;
  uploadedSequences = [];
  uploadedSequencesByMeeting = new Map();

  startSession(meetingId, networkProfile) {
    if (this.activeSession?.durableActive) throw new Error("A durable recording is already active.");

    const queue = this.activeSession?.queue ?? new RealtimeUploadQueue();
    queue.cancelPending();
    this.activeSession = {
      bufferCount: 0,
      durableActive: true,
      durableBytes: 0,
      elapsedMs: 0,
      failureStreak: 0,
      hadRealtimeFailure: false,
      meetingId,
      networkProfile,
      pendingBuffers: [],
      pendingBytes: 0,
      queue,
      retryNotBefore: 0,
      sequence: 0,
    };
    this.uploadedSequencesByMeeting.set(meetingId, []);
    this.startedSessions += 1;
  }

  async ingestBuffers(count, options = {}) {
    const session = this.requireActiveSession();
    const yieldEveryChunks = Math.max(0, Math.round(options.yieldEveryChunks ?? 1));
    const reusablePcm = new Uint8Array(bufferBytes);
    let chunksSinceYield = 0;

    for (let index = 0; index < count; index += 1) {
      if (!session.durableActive) {
        this.unexpectedDurableStops += 1;
        throw new Error("Realtime failure stopped the durable recorder.");
      }

      session.bufferCount += 1;
      session.elapsedMs += bufferIntervalMs;
      // The formal AVAudioRecorder writes independently of the disposable
      // realtime PCM draft, so this counter always advances first.
      session.durableBytes += reusablePcm.byteLength;

      if (!realtimeCaptureMayResume(session.elapsedMs, session.retryNotBefore)) {
        this.cooldownSkips += 1;
        continue;
      }

      session.pendingBuffers.push(new Uint8Array(reusablePcm));
      session.pendingBytes += reusablePcm.byteLength;
      this.noteRealtimeMemory();
      if (session.pendingBytes < chunkTargetBytes) continue;

      const chunk = takePendingBytes(session, chunkTargetBytes);
      this.fullChunksCreated += 1;
      this.enqueueRealtimeChunk(chunk, chunkTargetMs, session.elapsedMs);
      chunksSinceYield += 1;
      if (yieldEveryChunks > 0 && chunksSinceYield >= yieldEveryChunks) {
        chunksSinceYield = 0;
        await wait(0);
      }
    }
  }

  async drainRealtime(timeoutMs) {
    const session = this.requireActiveSession();
    const drained = await session.queue.drain(timeoutMs);
    if (!drained) throw new Error(`Realtime queue did not drain within ${timeoutMs}ms.`);
    await Promise.all(this.allUploadTasks);
  }

  async stopSession(stopReason) {
    const session = this.requireActiveSession();
    if (session.pendingBytes > 0 && realtimeCaptureMayResume(session.elapsedMs, session.retryNotBefore)) {
      const pendingBytes = session.pendingBytes;
      const chunk = takePendingBytes(session, pendingBytes);
      this.enqueueRealtimeChunk(
        chunk,
        Math.max(1, Math.round((pendingBytes / (sampleRate * channels * bytesPerSample)) * 1000)),
        session.elapsedMs,
      );
    }

    const drained = await session.queue.drain(5_000);
    if (!drained) session.queue.cancelPending();
    await Promise.all(this.allUploadTasks);

    session.durableActive = false;
    const recording = {
      bufferCount: session.bufferCount,
      bytes: session.durableBytes,
      durationMs: session.elapsedMs,
      meetingId: session.meetingId,
      stopReason,
    };
    this.recordings.push(recording);
    return recording;
  }

  enqueueRealtimeChunk(bytes, durationMs, capturedAtMs) {
    const session = this.requireActiveSession();
    const sequence = nextRealtimeUploadSequence(session.sequence, session.queue.pendingCount(), queueLimit);
    if (sequence === null) {
      this.droppedChunks += 1;
      return;
    }

    session.sequence = sequence;
    const generation = session.queue.currentGeneration();
    const chunk = { bytes, capturedAtMs, durationMs, sequence };
    this.retainedRealtimeBytes += bytes.byteLength;
    this.noteRealtimeMemory();

    const upload = session.queue
      .enqueue(async () => {
        await this.uploadChunk(session, chunk);
        if (!session.queue.isCurrentGeneration(generation)) throw new RealtimeUploadQueueCancelledError();
      })
      .then(
        () => {
          session.failureStreak = 0;
          session.retryNotBefore = 0;
          if (session.hadRealtimeFailure) this.recoveredAfterFailure = true;
          this.uploadedSequences.push(sequence);
          this.uploadedSequencesByMeeting.get(session.meetingId)?.push(sequence);
        },
        (error) => {
          if (isRealtimeUploadQueueCancelledError(error) || !session.queue.isCurrentGeneration(generation)) return;

          this.realtimeFailures += 1;
          session.hadRealtimeFailure = true;
          session.queue.cancelPending();
          session.pendingBuffers = [];
          session.pendingBytes = 0;
          session.failureStreak += 1;
          this.maxFailureStreak = Math.max(this.maxFailureStreak, session.failureStreak);
          session.retryNotBefore = session.elapsedMs + realtimeFailureCooldownMs(session.failureStreak);
          session.sequence = realtimeSequenceAfterFailure(session.sequence, sequence);
        },
      )
      .finally(() => {
        this.retainedRealtimeBytes = Math.max(0, this.retainedRealtimeBytes - bytes.byteLength);
      });

    this.allUploadTasks.push(upload);
    this.maxQueuePending = Math.max(this.maxQueuePending, session.queue.pendingCount());
    this.noteRealtimeMemory();
  }

  async uploadChunk(session, chunk) {
    const mode = transportMode(session.networkProfile, chunk.capturedAtMs);
    this.transportStats[mode] += 1;
    if (mode === "slow") await wait(2);
    if (mode === "timeout") {
      await wait(1);
      throw new TypeError("synthetic realtime request timeout");
    }
  }

  noteRealtimeMemory() {
    const pendingBytes = this.activeSession?.pendingBytes ?? 0;
    this.maxRealtimeBytes = Math.max(this.maxRealtimeBytes, this.retainedRealtimeBytes + pendingBytes);
  }

  requireActiveSession() {
    if (!this.activeSession?.durableActive) throw new Error("No active durable recording.");
    return this.activeSession;
  }
}

function takePendingBytes(session, byteLength) {
  const output = new Uint8Array(byteLength);
  let offset = 0;
  while (offset < byteLength && session.pendingBuffers.length > 0) {
    const next = session.pendingBuffers[0];
    const take = Math.min(byteLength - offset, next.byteLength);
    output.set(next.subarray(0, take), offset);
    offset += take;
    if (take === next.byteLength) session.pendingBuffers.shift();
    else session.pendingBuffers[0] = next.subarray(take);
  }
  session.pendingBytes = Math.max(0, session.pendingBytes - offset);
  return output.buffer;
}

function transportMode(profile, capturedAtMs) {
  if (profile === "healthy") return "healthy";
  if (capturedAtMs <= 100_000) return "slow";
  if (capturedAtMs < 600_000) return "timeout";
  if (capturedAtMs < 1_200_000) return "slow";
  return "healthy";
}

function sourceBetween(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex);
  if (startIndex < 0 || endIndex < 0) return "";
  return source.slice(startIndex, endIndex);
}

function wait(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}

await main();
