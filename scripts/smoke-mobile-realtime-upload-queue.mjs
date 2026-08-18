#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { createJiti } from "jiti";
import {
  isRealtimeUploadQueueCancelledError,
  nextRealtimeUploadSequence,
  realtimeCaptureMayResume,
  realtimeFailureCooldownMs,
  realtimeSequenceAfterFailure,
  RealtimeUploadQueue,
  retryRealtimeUpload,
} from "../apps/mobile/src/realtime-upload-queue.ts";

const jiti = createJiti(import.meta.url);
const {
  MobileApiError,
  runMobileApiOperationWithTimeout,
} = await jiti.import("../apps/mobile/src/mobile-http.ts");

const orderedQueue = new RealtimeUploadQueue();
const order = [];
const orderedTasks = [
  orderedQueue.enqueue(async () => {
    await wait(25);
    order.push(1);
  }),
  orderedQueue.enqueue(async () => {
    order.push(2);
  }),
  orderedQueue.enqueue(async () => {
    order.push(3);
  }),
];
await Promise.all(orderedTasks);
const pendingCountReturnsToZero = orderedQueue.pendingCount() === 0;
const sequenceBeforeBacklog = 20;
const droppedSequence = nextRealtimeUploadSequence(sequenceBeforeBacklog, 20, 20);
const recoveredSequence = nextRealtimeUploadSequence(sequenceBeforeBacklog, 19, 20);
const cooldownSchedule = [1, 2, 3, 4, 5, 6].map(realtimeFailureCooldownMs);
const retryNotBefore = 50_000 + realtimeFailureCooldownMs(1);
const failedTailSequence = realtimeSequenceAfterFailure(20, 20);
const failedEarlierSequence = realtimeSequenceAfterFailure(20, 15);
const retriedTailSequence = nextRealtimeUploadSequence(failedTailSequence, 0, 20);
const retriedEarlierSequence = nextRealtimeUploadSequence(failedEarlierSequence, 0, 20);

let retryCalls = 0;
const retryResult = await retryRealtimeUpload(
  async () => {
    retryCalls += 1;
    if (retryCalls < 3) throw new TypeError("synthetic network interruption");
    return "uploaded";
  },
  (error) => error instanceof TypeError,
  { attempts: 3, baseDelayMs: 100 },
);

let nonRetryCalls = 0;
let nonRetryRejected = false;
try {
  await retryRealtimeUpload(
    async () => {
      nonRetryCalls += 1;
      throw new Error("synthetic invalid request");
    },
    () => false,
  );
} catch {
  nonRetryRejected = true;
}

const cancelledQueue = new RealtimeUploadQueue();
let releaseFirst = () => undefined;
const firstGate = new Promise((resolve) => {
  releaseFirst = resolve;
});
const first = cancelledQueue.enqueue(async () => {
  await firstGate;
  return "first-finished";
});
const cancelled = cancelledQueue.enqueue(async () => "must-not-run");
await wait(0);
cancelledQueue.cancelPending();
releaseFirst();
await first;
let queuedTaskCancelled = false;
try {
  await cancelled;
} catch (error) {
  queuedTaskCancelled = isRealtimeUploadQueueCancelledError(error);
}

const drainQueue = new RealtimeUploadQueue();
drainQueue.enqueue(async () => wait(30));
const earlyDrain = await drainQueue.drain(1);
const finalDrain = await drainQueue.drain(100);

const failedSequenceQueue = new RealtimeUploadQueue();
let followingUploadRan = false;
const failedSequence = failedSequenceQueue.enqueue(async () => {
  await wait(1);
  throw new TypeError("synthetic exhausted transport");
});
const handledFailure = failedSequence.catch(() => failedSequenceQueue.cancelPending());
const followingUpload = failedSequenceQueue.enqueue(async () => {
  followingUploadRan = true;
});
await handledFailure;
let followingUploadCancelled = false;
try {
  await followingUpload;
} catch (error) {
  followingUploadCancelled = isRealtimeUploadQueueCancelledError(error);
}

const hardDeadlineQueue = new RealtimeUploadQueue();
let uploadAfterHardDeadlineRan = false;
let recoveredUploadRan = false;
const nonCancellableUpload = hardDeadlineQueue.enqueue(() =>
  runMobileApiOperationWithTimeout(
    () => new Promise(() => undefined),
    { language: "en", timeoutMs: 5 },
  ),
);
const handledHardDeadline = nonCancellableUpload.catch((error) => {
  hardDeadlineQueue.cancelPending();
  return error;
});
const uploadQueuedBehindDeadline = hardDeadlineQueue.enqueue(async () => {
  uploadAfterHardDeadlineRan = true;
});
const hardDeadlineError = await handledHardDeadline;
let uploadBehindDeadlineCancelled = false;
try {
  await uploadQueuedBehindDeadline;
} catch (error) {
  uploadBehindDeadlineCancelled = isRealtimeUploadQueueCancelledError(error);
}
await hardDeadlineQueue.enqueue(async () => {
  recoveredUploadRan = true;
});

const appSource = readFileSync("apps/mobile/App.tsx", "utf8");
const apiSource = readFileSync("apps/mobile/src/api.ts", "utf8");
const httpSource = readFileSync("apps/mobile/src/mobile-http.ts", "utf8");
const i18nSource = readFileSync("apps/mobile/src/i18n/core.ts", "utf8");
const routeSource = readFileSync("src/app/api/meetings/[id]/realtime-chunks/route.ts", "utf8");
const ciSource = readFileSync(".github/workflows/ci.yml", "utf8");
const checks = {
  serializesUploadsInCreationOrder: order.join(",") === "1,2,3",
  releasesQueuedAudioAfterUpload: pendingCountReturnsToZero,
  retriesTransientNetworkFailures: retryCalls === 3 && retryResult.attempts === 3 && retryResult.value === "uploaded",
  doesNotRetryPermanentFailures: nonRetryRejected && nonRetryCalls === 1,
  cancelsQueuedWorkForNewRecording: queuedTaskCancelled,
  drainReportsTimeoutAndCompletion: earlyDrain === false && finalDrain === true,
  capturesMeetingIdentityAtEnqueue:
    appSource.includes("activeRealtimeMeetingIdRef") &&
    appSource.includes("targetMeetingId") &&
    appSource.includes("targetApiBaseUrl") &&
    appSource.includes("authCookie"),
  isolatesLateFailuresFromNewRecording:
    appSource.includes("if (!queue.isCurrentGeneration(generation)) throw new RealtimeUploadQueueCancelledError()"),
  waitsForQueueBeforeFinish:
    appSource.includes("queue.drain(20_000)") &&
    appSource.includes("实时分片队列未能在 20 秒内排空"),
  boundsRealtimeBacklog:
    appSource.includes("nextRealtimeUploadSequence(") &&
    appSource.includes('t("runtime.realtimeQueueCongested")') &&
    i18nSource.includes('realtimeQueueCongested: "The live draft queue is busy') &&
    i18nSource.includes('realtimeQueueCongested: "实时草稿队列繁忙'),
  backlogDropDoesNotConsumeSequence: droppedSequence === null && recoveredSequence === 21,
  failureCooldownBacksOffAndCapsAtOneMinute:
    cooldownSchedule.join(",") === "5000,10000,20000,40000,60000,60000" &&
    realtimeFailureCooldownMs(0) === 5000 &&
    realtimeFailureCooldownMs(-3) === 5000,
  captureResumesOnlyAfterCooldownBoundary:
    !realtimeCaptureMayResume(retryNotBefore - 1, retryNotBefore) &&
    realtimeCaptureMayResume(retryNotBefore, retryNotBefore) &&
    realtimeCaptureMayResume(retryNotBefore + 1, retryNotBefore),
  failedSequenceRollsBackForRetry:
    failedTailSequence === 19 &&
    failedEarlierSequence === 14 &&
    retriedTailSequence === 20 &&
    retriedEarlierSequence === 15,
  appAppliesCooldownAndRestoresFailedSequence:
    appSource.includes("realtimeFailureStreakRef.current + 1") &&
    appSource.includes("realtimeFailureStreakRef.current = failureStreak") &&
    appSource.includes("realtimeRetryNotBeforeRef.current = Date.now() + realtimeFailureCooldownMs(") &&
    appSource.includes("realtimeSequenceAfterFailure(") &&
    appSource.includes("realtimeFailureStreakRef.current = 0") &&
    appSource.includes("realtimeRetryNotBeforeRef.current = 0"),
  unrecoverableFailureStopsFollowingSequence: followingUploadCancelled && !followingUploadRan,
  nonCancellableNativeUploadCannotPermanentlyBlockQueue:
    hardDeadlineError instanceof MobileApiError &&
    hardDeadlineError.kind === "timeout" &&
    uploadBehindDeadlineCancelled &&
    !uploadAfterHardDeadlineRan &&
    recoveredUploadRan &&
    hardDeadlineQueue.pendingCount() === 0,
  retriesOnlyRetryableHttpAndNetworkErrors:
    apiSource.includes("status === 408") &&
    apiSource.includes("status === 425") &&
    apiSource.includes("status === 429") &&
    apiSource.includes("status >= 500") &&
    apiSource.includes("error instanceof TypeError") &&
    apiSource.includes("error instanceof MobileApiError") &&
    apiSource.includes("error instanceof RealtimeChunkUploadError && error.retryable") &&
    httpSource.includes('buildMobileApiError("invalid-response"'),
  serverRejectsWrongOrderAndDeduplicates:
    routeSource.includes('sequenceDecision.status === "duplicate"') &&
    routeSource.includes('sequenceDecision.status === "out_of_order"') &&
    routeSource.includes("withRealtimeSessionLock"),
  appCoolsDownRealtimeWithoutStoppingDurableRecording:
    appSource.includes("queue.cancelPending()") &&
    appSource.includes("if (authenticationRejected)") &&
    appSource.includes("realtimeFailureCooldownMs(") &&
    appSource.includes("realtimeSequenceAfterFailure(") &&
    appSource.includes('t("runtime.realtimeUploadFailed")') &&
    i18nSource.includes('realtimeUploadFailed: "Live draft upload failed') &&
    i18nSource.includes('realtimeUploadFailed: "实时草稿上传失败'),
  quotaExhaustionStopsRealtimeForCurrentMeetingOnly:
    appSource.includes('ack.code === "official_quota_insufficient"') &&
    appSource.includes("if (activeRealtimeMeetingIdRef.current === context.meetingId)") &&
    appSource.includes("activeRealtimeMeetingIdRef.current = null") &&
    appSource.includes("queue.cancelPending()") &&
    appSource.includes('setRealtimeUploadDiagnostic(t("runtime.realtimeQuotaExhausted"))') &&
    !appSource.slice(
      appSource.indexOf('ack.code === "official_quota_insufficient"'),
      appSource.indexOf('ack.providerStatus === "rejected_format"'),
    ).includes("audioStream.stream.stop()") &&
    (i18nSource.match(/realtimeQuotaExhausted:/g)?.length ?? 0) === 3,
  liveFailureIsVisibleOutsideDeveloperDiagnostics:
    appSource.includes("const realtimeTranscriptionWarning =") &&
    appSource.includes("!audioStream.isStreaming") &&
    appSource.includes('(status === "recording" || status === "paused") && realtimeTranscriptionWarning') &&
    appSource.includes("{realtimeTranscriptionWarning}") &&
    appSource.indexOf('(status === "recording" || status === "paused") && realtimeTranscriptionWarning') <
      appSource.indexOf('Panel title="录制稳定性检查"'),
  ciProtectsRealtimeUploadQueue: ciSource.includes("npm run smoke:mobile-realtime-queue"),
  ciProtectsRealtimeHttpContract: ciSource
    .split(/\r?\n/)
    .some((line) => line.trim() === "npm run smoke:mobile-realtime"),
};

console.log(JSON.stringify(checks, null, 2));
if (Object.values(checks).some((value) => !value)) process.exitCode = 1;

function wait(delayMs) {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}
