#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { registerHooks } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { probeAudioDurationMs } from "../src/lib/audio-normalization.ts";
import { calculateMeetingUsage } from "../src/lib/processing-route.ts";

const actualSeconds = 61;
const wav = buildSilentWav(16_000, actualSeconds);
const resolvedDurationMs = await probeAudioDurationMs(wav);
assert.ok(resolvedDurationMs >= 60_900 && resolvedDurationMs <= 61_100);

const usage = calculateMeetingUsage({ durationMs: resolvedDurationMs, route: "official_quota" });
assert.equal(usage.processedMinutes, 2);
assert.equal(usage.officialMinutesCharged, 2);

const appSource = readFileSync("apps/mobile/App.tsx", "utf8");
const apiSource = readFileSync("apps/mobile/src/api.ts", "utf8");
const storeSource = readFileSync("apps/mobile/src/recording-store.ts", "utf8");
const durationAuthoritySource = readFileSync("src/lib/server/uploaded-audio-duration.ts", "utf8");
const uploadRouteSource = readFileSync("src/app/api/meetings/[id]/chunks/route.ts", "utf8");
const recordingStoreSource = readFileSync("src/lib/server/meeting-audio-store.ts", "utf8");
const commitUploadSourceStart = recordingStoreSource.indexOf("export async function commitMeetingRecordingUpload");
const commitUploadSourceEnd = recordingStoreSource.indexOf("async function readMeetingRecordingUploadStatusUnsafe");
const commitUploadSource = recordingStoreSource.slice(commitUploadSourceStart, commitUploadSourceEnd);
const revisionSourceStart = recordingStoreSource.indexOf("function deriveMeetingAudioRevision");
const revisionSourceEnd = recordingStoreSource.indexOf("function meetingAudioMetadataFromManifest");
const revisionSource = recordingStoreSource.slice(revisionSourceStart, revisionSourceEnd);
const finalizerSource = readFileSync("src/lib/server/meeting-finalizer.ts", "utf8");
const checkpointSource = readFileSync("src/lib/server/meeting-processing-checkpoint.ts", "utf8");
const meetingProcessingSource = readFileSync("src/lib/meeting-processing.ts", "utf8");
const audioNormalizationSource = readFileSync("src/lib/audio-normalization.ts", "utf8");
const durationProbeStart = audioNormalizationSource.indexOf("export async function probeAudioDurationMs");
const durationProbeEnd = audioNormalizationSource.indexOf("export async function normalizeAudioForVolcanoAsr");
assert.ok(durationProbeStart >= 0 && durationProbeEnd > durationProbeStart);
const durationProbeSource = audioNormalizationSource.slice(
  durationProbeStart,
  durationProbeEnd,
);
assert.ok(appSource.includes("const stoppedDurationMs = Math.max"));
assert.ok(appSource.includes("const localMediaDurationMs = await readLocalRecordingDurationMs(durableUri)"));
assert.ok(appSource.includes("const durableDurationMs = Math.max(stoppedDurationMs, localMediaDurationMs ?? 0)"));
assert.ok(appSource.includes("durationMs: durableDurationMs"));
assert.ok(appSource.includes("setCompletedDurationMs(ack.durationMs)"));
assert.ok(apiSource.includes('"X-OwnMinutes-Duration-Ms"'));
assert.ok(apiSource.includes("recording-upload"));
assert.ok(!apiSource.includes('durationMs: "0"'));
assert.ok(storeSource.includes("durationMs?: number"));
assert.ok(durationAuthoritySource.includes("return probeAudioDurationMs(input.buffer)"));
assert.ok(uploadRouteSource.includes("resolveUploadedAudioDurationMs({ buffer, fullRecording, sequence, submittedDurationMs })"));
assert.ok(recordingStoreSource.includes("const durationMs = await probeAudioFileDurationMs(assembled.filePath)"));
assert.ok(recordingStoreSource.includes("export async function prepareMeetingAudioSnapshot"));
assert.ok(recordingStoreSource.includes("audioSha256: assembled.sha256"));
assert.ok(recordingStoreSource.includes("const audioRevision = deriveMeetingAudioRevision(manifest)"));
assert.ok(recordingStoreSource.includes("sha256: input.sha256"));
assert.ok(recordingStoreSource.includes('code: "audio_chunk_content_conflict"'));
assert.ok(recordingStoreSource.includes('code: "meeting_audio_incomplete"'));
assert.ok(recordingStoreSource.includes('code: "meeting_audio_not_sealed"'));
assert.ok(recordingStoreSource.includes("const audioSeal = await sealMeetingAudioUnsafe"));
assert.ok(commitUploadSource.includes("receipt: state.receipt"));
assert.ok(commitUploadSource.includes("receipt: assembled.receipt"));
assert.ok(recordingStoreSource.includes("expectedLastSequence: input.receipt.totalChunks"));
assert.ok(recordingStoreSource.includes("audioUpdatedAt: lastChunkReceivedAt"));
assert.ok(recordingStoreSource.includes("readMeetingResultFreshness"));
assert.ok(revisionSource.includes("sha256: chunk.sha256"));
assert.ok(!revisionSource.includes("receivedAt"));
assert.ok(recordingStoreSource.includes("return withMeetingWriteFence(key, () => operation())"));
assert.ok(recordingStoreSource.includes("expectedAudioRevision?: string"));
assert.ok(recordingStoreSource.includes('code: "audio_revision_changed"'));
assert.ok(recordingStoreSource.includes("let cleanupInFlight: Promise<void> | null = null"));
assert.ok(recordingStoreSource.includes("cleanupComplete = true"));
assert.ok(recordingStoreSource.includes('assemblyMethod: "bounded-temp-file"'));
assert.ok(!recordingStoreSource.includes("probeAudioDurationMs(assembled.buffer)"));
assert.ok(recordingStoreSource.includes("validateFullRecordingDuration(durationMs)"));
assert.ok(!durationProbeSource.includes("Buffer.concat(errors)"));
assert.ok(durationProbeSource.includes("无法读取音频时长，请确认音频文件完整后重试。"));
assert.ok(finalizerSource.includes("prepareMeetingAudioSnapshot(input.meetingId)"));
assert.ok(finalizerSource.includes("const authoritativeDurationMs = audioSnapshot.durationMs"));
assert.ok(finalizerSource.includes("getOfficialTurboFallbackDecision(authoritativeDurationMs)"));
assert.ok(finalizerSource.includes("durationMs: authoritativeDurationMs"));
assert.ok(finalizerSource.includes("audioSha256: audioSnapshot.audioSha256"));
assert.ok(finalizerSource.includes("audioRevision: audioSnapshot.audioRevision"));
assert.ok(finalizerSource.includes("reprocessMeetingOperationKey(input.meetingId, audio.audioRevision)"));
assert.ok(finalizerSource.includes("existingResult.processingOperationKey || initialMeetingOperationKey(input.meetingId)"));
assert.ok(finalizerSource.includes("isReprocess: resultIsReprocess"));
assert.ok(finalizerSource.includes("expectedAudioRevision: audioSnapshot.audioRevision"));
assert.ok(recordingStoreSource.includes("return audio.audioUpdatedAt <= result.generatedAt"));
assert.ok(checkpointSource.includes("checkpoint.audioSha256 !== input.audioSha256"));
assert.ok(finalizerSource.includes('error.code !== "audio_revision_changed"'));
assert.ok(finalizerSource.includes("cleanupFailed = await audioSnapshot.cleanup().then(() => false, () => true)"));
assert.ok(checkpointSource.includes("audioSha256: string"));
assert.ok(meetingProcessingSource.includes("audioRevision?: string"));

const revisionRace = await verifyTailChunkRevisionFence(wav);

console.log(JSON.stringify({
  claimedDurationMs: 1_000,
  officialMinutesCharged: usage.officialMinutesCharged,
  processedMinutes: usage.processedMinutes,
  revisionRace,
  resolvedDurationMs,
}, null, 2));

async function verifyTailChunkRevisionFence(firstChunk) {
  const repoRoot = process.cwd();
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), "ownminutes-audio-revision-"));
  process.env.OWNMINUTES_AUTH_DATA_DIR = path.join(tempRoot, "auth");
  process.env.OWNMINUTES_AUTH_REPOSITORY = "local-file";

  registerHooks({
    resolve(specifier, context, nextResolve) {
      const sourcePath = specifier.startsWith("@/")
        ? path.join(repoRoot, "src", specifier.slice(2))
        : specifier.startsWith(".") && context.parentURL?.startsWith("file:")
          ? fileURLToPath(new URL(specifier, context.parentURL))
          : "";
      if (!sourcePath) return nextResolve(specifier, context);
      for (const candidate of [`${sourcePath}.ts`, `${sourcePath}.tsx`, path.join(sourcePath, "index.ts")]) {
        if (readFileExists(candidate)) return { shortCircuit: true, url: pathToFileURL(candidate).href };
      }
      return nextResolve(specifier, context);
    },
  });

  process.chdir(tempRoot);
  try {
    const authStore = await import(pathToFileURL(path.join(repoRoot, "src/lib/server/auth-store.ts")).href);
    const meetingStore = await import(pathToFileURL(path.join(repoRoot, "src/lib/server/meeting-audio-store.ts")).href);
    const recordingUploadStore = await import(pathToFileURL(path.join(repoRoot, "src/lib/server/recording-upload-store.ts")).href);
    const suffix = `${Date.now()}-${process.pid}`;
    const meetingId = `audio-revision-${suffix}`;
    const user = authStore.registerUser({
      email: `audio-revision-${suffix}@example.com`,
      name: "Audio Revision Smoke",
      password: `OwnMinutes-${suffix}`,
    });
    await meetingStore.saveMeetingAudioChunk({
      meetingId,
      ownerUserId: user.id,
      sequence: 1,
      buffer: firstChunk,
      mimeType: "audio/wav",
      recordedAt: 1,
      durationMs: 1_000,
    });

    await assert.rejects(
      meetingStore.sealMeetingAudio({
        meetingId,
        ownerUserId: user.id,
        expectedLastSequence: 2,
        totalBytes: firstChunk.byteLength,
      }),
      (error) => error?.status === 409 && error?.code === "meeting_audio_incomplete",
    );
    const initialSeal = await meetingStore.sealMeetingAudio({
      meetingId,
      ownerUserId: user.id,
      expectedLastSequence: 1,
      totalBytes: firstChunk.byteLength,
    });
    const snapshot = await meetingStore.prepareMeetingAudioSnapshot(meetingId);
    const beforeTail = await meetingStore.readMeetingAudioMetadata(meetingId);
    assert.equal(initialSeal.audioRevision, beforeTail.audioRevision);
    assert.equal(beforeTail.sealed, true);
    assert.equal(snapshot.audioRevision, beforeTail.audioRevision);

    const duplicate = await meetingStore.saveMeetingAudioChunk({
      meetingId,
      ownerUserId: user.id,
      sequence: 1,
      buffer: firstChunk,
      mimeType: "audio/wav",
      recordedAt: 999,
      durationMs: 999,
    });
    const afterDuplicate = await meetingStore.readMeetingAudioMetadata(meetingId);
    assert.equal(duplicate.idempotent, true);
    assert.equal(duplicate.receivedAt, beforeTail.lastChunkReceivedAt);
    assert.equal(afterDuplicate.audioRevision, beforeTail.audioRevision);
    assert.equal(afterDuplicate.audioUpdatedAt, beforeTail.audioUpdatedAt);
    assert.equal(afterDuplicate.sealed, true);
    await assert.rejects(
      meetingStore.saveMeetingAudioChunk({
        meetingId,
        ownerUserId: user.id,
        sequence: 1,
        buffer: Buffer.from("different-content-for-existing-sequence"),
        mimeType: "audio/wav",
        recordedAt: 1,
        durationMs: 1_000,
      }),
      (error) => error?.status === 409 && error?.code === "audio_chunk_content_conflict",
    );

    await meetingStore.saveMeetingAudioChunk({
      meetingId,
      ownerUserId: user.id,
      sequence: 2,
      buffer: Buffer.from("late-tail-chunk"),
      mimeType: "audio/wav",
      recordedAt: 2,
      durationMs: 1_000,
    });
    const afterTail = await meetingStore.readMeetingAudioMetadata(meetingId);
    assert.notEqual(afterTail.audioRevision, snapshot.audioRevision);
    assert.equal(afterTail.sealed, false);

    const result = {
      audioRevision: snapshot.audioRevision,
      meetingId,
      title: "Audio revision smoke",
      generatedAt: new Date().toISOString(),
      provider: "volcano",
      adapter: "volcano-file-asr",
      transcript: [],
      summary: {
        summary: "revision smoke",
        topics: [],
        speakerViews: [],
        decisions: [],
        actionItems: [],
        risks: [],
        openQuestions: [],
        knowledgePoints: [],
      },
      obsidianMarkdown: "# Audio revision smoke",
      diagnostics: [],
    };
    await assert.rejects(
      meetingStore.saveMeetingResult(meetingId, result, { expectedAudioRevision: snapshot.audioRevision }),
      (error) => error?.status === 409 && error?.code === "audio_revision_changed" && error?.retryable === true,
    );
    assert.equal(await meetingStore.readMeetingResult(meetingId), null);
    const secondSeal = await meetingStore.sealMeetingAudio({
      meetingId,
      ownerUserId: user.id,
      expectedLastSequence: 2,
      totalBytes: afterTail.totalBytes,
    });
    assert.equal(secondSeal.audioRevision, afterTail.audioRevision);

    const legacyResult = {
      ...result,
      audioRevision: undefined,
      generatedAt: afterTail.audioUpdatedAt,
    };
    await meetingStore.saveMeetingResult(meetingId, legacyResult, { expectedAudioRevision: afterTail.audioRevision });
    assert.equal((await meetingStore.readMeetingResultFreshness(meetingId)).current, true);

    await new Promise((resolve) => setTimeout(resolve, 5));
    await meetingStore.saveMeetingAudioChunk({
      meetingId,
      ownerUserId: user.id,
      sequence: 3,
      buffer: Buffer.from("another-late-tail-chunk"),
      mimeType: "audio/wav",
      recordedAt: 3,
      durationMs: 1_000,
    });
    const afterSecondTail = await meetingStore.readMeetingAudioMetadata(meetingId);
    const staleFreshness = await meetingStore.readMeetingResultFreshness(meetingId);
    const staleListItem = (await meetingStore.listUserMeetings(user.id)).find((item) => item.meetingId === meetingId);
    const staleDetail = await meetingStore.readUserMeetingDetail(meetingId, user.id);
    assert.equal(staleFreshness.current, false);
    assert.equal(staleFreshness.currentResult, null);
    assert.equal(staleListItem?.hasResult, false);
    assert.equal(staleDetail.result, null);
    assert.equal(staleDetail.obsidianMarkdown, null);

    const finalSeal = await meetingStore.sealMeetingAudio({
      meetingId,
      ownerUserId: user.id,
      expectedLastSequence: 3,
      totalBytes: afterSecondTail.totalBytes,
    });
    assert.equal(finalSeal.audioRevision, afterSecondTail.audioRevision);

    const recoveryOperationKey = `meeting:${meetingId}:reprocess:${afterSecondTail.audioRevision}`;
    const currentResult = {
      ...result,
      audioRevision: afterSecondTail.audioRevision,
      processingOperationKey: recoveryOperationKey,
    };
    await meetingStore.saveMeetingResult(meetingId, currentResult, { expectedAudioRevision: afterSecondTail.audioRevision });
    assert.equal((await meetingStore.readMeetingResultFreshness(meetingId)).current, true);
    assert.equal((await meetingStore.readMeetingResult(meetingId))?.audioRevision, afterSecondTail.audioRevision);

    const reservation = authStore.reserveMeetingFinalizationQuota(user.id, {
      durationMs: afterSecondTail.durationMs,
      meetingId,
      operationKey: recoveryOperationKey,
      processingRoute: "official_quota",
    });
    const claim = authStore.claimMeetingProviderStep(user.id, {
      reservationId: reservation.id,
      stage: { type: "finalization_asr" },
    });
    authStore.startMeetingProviderStep(user.id, { claimToken: claim.claimToken, stepId: claim.step.id });
    authStore.completeMeetingProviderStep(user.id, { claimToken: claim.claimToken, stepId: claim.step.id });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      authStore.recordMeetingFinalizeUsage(user.id, {
        durationMs: afterSecondTail.durationMs,
        meetingId,
        isReprocess: true,
        reservationOperationKey: recoveryOperationKey,
        resultGeneratedAt: currentResult.generatedAt,
        route: "official_quota",
      });
    }
    const recoveryEvents = authStore.getUserUsage(user.id).events.filter(
      (event) => event.type === "meeting_finalize" && event.note.includes(meetingId),
    );
    assert.equal(recoveryEvents.length, 1);

    const legacyUploadMeetingId = `legacy-upload-receipt-${suffix}`;
    const legacyUploadId = `legacy-upload-${suffix}`;
    const legacySaved = await meetingStore.saveMeetingAudioChunk({
      meetingId: legacyUploadMeetingId,
      ownerUserId: user.id,
      sequence: 1,
      buffer: firstChunk,
      mimeType: "audio/wav",
      recordedAt: 1,
      durationMs: resolvedDurationMs,
    });
    const uploadMetadata = {
      durationMs: resolvedDurationMs,
      mimeType: "audio/wav",
      recordedAt: 1,
      totalBytes: firstChunk.byteLength,
      totalParts: 1,
      uploadId: legacyUploadId,
    };
    await recordingUploadStore.finalizeRecordingUpload({
      meetingId: legacyUploadMeetingId,
      metadata: uploadMetadata,
      ownerUserId: user.id,
      uploadId: legacyUploadId,
      receipt: {
        durationMs: resolvedDurationMs,
        receivedAt: legacySaved.receivedAt,
        savedBytes: legacySaved.savedBytes,
        totalBytes: legacySaved.totalBytes,
        totalChunks: legacySaved.totalChunks,
      },
    });
    assert.equal((await meetingStore.readMeetingAudioMetadata(legacyUploadMeetingId)).sealed, false);
    const recoveredLegacyReceipt = await meetingStore.commitMeetingRecordingUpload({
      meetingId: legacyUploadMeetingId,
      ownerUserId: user.id,
      uploadId: legacyUploadId,
    });
    const recoveredLegacyAudio = await meetingStore.readMeetingAudioMetadata(legacyUploadMeetingId);
    assert.equal(recoveredLegacyReceipt.sealed, true);
    assert.equal(recoveredLegacyReceipt.audioRevision, recoveredLegacyAudio.audioRevision);
    assert.equal(recoveredLegacyAudio.sealed, true);
    await snapshot.cleanup();
    await snapshot.cleanup();

    return {
      currentRevisionAccepted: true,
      duplicateContentIsIdempotent: true,
      differentContentConflicts: true,
      legacyFreshnessUsesAudioTimestamp: true,
      legacyUploadReceiptAutoSealed: true,
      lateTailChangesRevision: true,
      recordingSealRejectsIncompleteAudio: true,
      recordingSealInvalidatedByNewContent: true,
      resultSaveUsageRecoveryUsesResultOperation: true,
      staleHistoryIsHidden: true,
      stalePublishRejected: true,
    };
  } finally {
    process.chdir(repoRoot);
    rmSync(tempRoot, { force: true, recursive: true });
  }
}

function readFileExists(filePath) {
  try {
    readFileSync(filePath);
    return true;
  } catch {
    return false;
  }
}

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
