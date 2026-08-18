#!/usr/bin/env node

import { readFileSync } from "node:fs";

const {
  assessRecordingDurationLimit,
  assessRecordingStorageHealth,
  classifyNativeRecordingCompletion,
  createUnknownRecordingStorageHealth,
  recordingDurationMaximumMs,
  recordingDurationWarningLeadMs,
  recordingStorageEmergencyStopBytes,
  recordingStorageEstimatedMaximumBytes,
  recordingStoragePcmBytesPerSecond,
  recordingStorageStartMinimumBytes,
  recordingStorageTargetMaximumSeconds,
  recordingStorageWarningBytes,
  remainingRecordingDurationSeconds,
  unavailableRecordingStorageHealth,
} = await import("../apps/mobile/src/recording-storage.ts");

const mib = 1024 * 1024;
const preflightBlocked = assessRecordingStorageHealth(recordingStorageStartMinimumBytes - 1, "preflight", 1000);
const preflightAllowedWithWarning = assessRecordingStorageHealth(recordingStorageStartMinimumBytes, "preflight", 2000);
const recordingCritical = assessRecordingStorageHealth(recordingStorageEmergencyStopBytes - 1, "recording", 3000);
const recordingWarning = assessRecordingStorageHealth(recordingStorageEmergencyStopBytes, "recording", 4000);
const recordingReady = assessRecordingStorageHealth(recordingStorageWarningBytes, "recording", 5000);
const unavailable = unavailableRecordingStorageHealth(6000);
const unknown = createUnknownRecordingStorageHealth();
const durationBeforeWarning = assessRecordingDurationLimit(recordingDurationMaximumMs - recordingDurationWarningLeadMs - 1);
const durationWarning = assessRecordingDurationLimit(recordingDurationMaximumMs - recordingDurationWarningLeadMs);
const durationLimit = assessRecordingDurationLimit(recordingDurationMaximumMs);
const nativeDurationCompletion = classifyNativeRecordingCompletion({
  armed: true,
  durationMs: recordingDurationMaximumMs - 500,
  hasError: false,
  isFinished: true,
  stopInFlight: false,
});
const nativeEarlyCompletion = classifyNativeRecordingCompletion({
  armed: true,
  durationMs: 20 * 60 * 1000,
  hasError: false,
  isFinished: true,
  stopInFlight: false,
});
const nativeErrorCompletion = classifyNativeRecordingCompletion({
  armed: true,
  durationMs: recordingDurationMaximumMs,
  hasError: true,
  isFinished: true,
  stopInFlight: false,
});
const nativeMediaServicesResetCompletion = classifyNativeRecordingCompletion({
  armed: true,
  durationMs: 30_000,
  hasError: false,
  isFinished: true,
  mediaServicesDidReset: true,
  stopInFlight: false,
});
const nativeMediaServicesResetWithErrorCompletion = classifyNativeRecordingCompletion({
  armed: true,
  durationMs: 30_000,
  hasError: true,
  isFinished: true,
  mediaServicesDidReset: true,
  stopInFlight: false,
});

const appSource = readFileSync("apps/mobile/App.tsx", "utf8");
const i18nSource = readFileSync("apps/mobile/src/i18n/core.ts", "utf8");
const recordingStartIndex = appSource.indexOf("async function doStartRecording(");
const preflightFenceIndex = appSource.indexOf("setRecordingStartPreflightBusy(true)", recordingStartIndex);
const preflightIndex = appSource.indexOf('readRecordingStorageHealth("preflight")');
const requestStateIndex = appSource.indexOf('setStatus("requesting")', preflightIndex);
const permissionRequestIndex = appSource.indexOf("requestRecordingPermissionsAsync()", preflightIndex);
const persistIndex = appSource.indexOf("await persistPendingRecording({", appSource.indexOf("async function stopRecording(reason?: RecordingStopReason)"));
const indexedIndex = appSource.indexOf("localRecordingIndexed = true", persistIndex);
const localDurationProbeIndex = appSource.indexOf("await readLocalRecordingDurationMs(durableUri)", appSource.indexOf("async function stopRecording"));

const checks = {
  thresholdOrderIsSafe:
    recordingStorageEmergencyStopBytes < recordingStorageStartMinimumBytes &&
    recordingStorageStartMinimumBytes < recordingStorageWarningBytes,
  pcmBudgetMatchesDurableRecordingFormat:
    recordingStoragePcmBytesPerSecond === 32_000 &&
    recordingStorageTargetMaximumSeconds === 120 * 60 &&
    recordingStorageEstimatedMaximumBytes === 32_000 * 120 * 60,
  maximumPcmFitsDefault256MiBUpload:
    recordingStorageEstimatedMaximumBytes > 0 && recordingStorageEstimatedMaximumBytes < 256 * mib,
  durationLimitMatchesStorageBudget:
    recordingDurationMaximumMs === recordingStorageTargetMaximumSeconds * 1000 &&
    recordingDurationWarningLeadMs === 10 * 60 * 1000,
  durationWarnsTenMinutesBeforeLimit:
    durationBeforeWarning.shouldWarn === false &&
    durationWarning.shouldWarn === true &&
    durationWarning.shouldStop === false &&
    durationWarning.remainingMs === recordingDurationWarningLeadMs,
  durationStopsAtLimit:
    durationLimit.shouldWarn === true && durationLimit.shouldStop === true && durationLimit.remainingMs === 0,
  nativeDurationSecondsRespectSessionDeadline:
    remainingRecordingDurationSeconds(0) === 120 * 60 &&
    remainingRecordingDurationSeconds(30 * 60 * 1000) === 90 * 60 &&
    remainingRecordingDurationSeconds(recordingDurationMaximumMs - 1) === 1 &&
    remainingRecordingDurationSeconds(recordingDurationMaximumMs) === 0,
  nativeCompletionClassifierClosesOnlyArmedEvents:
    nativeDurationCompletion === "duration-limit" &&
    nativeEarlyCompletion === "native-error" &&
    nativeErrorCompletion === "native-error" &&
    classifyNativeRecordingCompletion({ armed: false, durationMs: recordingDurationMaximumMs, hasError: false, isFinished: true, stopInFlight: false }) === "ignore" &&
    classifyNativeRecordingCompletion({ armed: true, durationMs: recordingDurationMaximumMs, hasError: false, isFinished: false, stopInFlight: false }) === "ignore" &&
    classifyNativeRecordingCompletion({ armed: true, durationMs: recordingDurationMaximumMs, hasError: false, isFinished: true, stopInFlight: true }) === "ignore",
  mediaServicesResetHasDedicatedRecoveryPath:
    nativeMediaServicesResetCompletion === "media-services-reset" &&
    nativeMediaServicesResetWithErrorCompletion === "media-services-reset" &&
    classifyNativeRecordingCompletion({
      armed: false,
      durationMs: 30_000,
      hasError: false,
      isFinished: true,
      mediaServicesDidReset: true,
      stopInFlight: false,
    }) === "ignore" &&
    classifyNativeRecordingCompletion({
      armed: true,
      durationMs: 30_000,
      hasError: false,
      isFinished: true,
      mediaServicesDidReset: true,
      stopInFlight: true,
    }) === "ignore",
  startBudgetCoversTwoHoursAndEmergencyReserve:
    recordingStorageStartMinimumBytes >= recordingStorageEstimatedMaximumBytes + recordingStorageEmergencyStopBytes,
  preflightBlocksBelow512MiB:
    recordingStorageStartMinimumBytes === 512 * mib &&
    preflightBlocked.status === "blocked" &&
    preflightBlocked.canStart === false &&
    preflightBlocked.shouldStop === false,
  preflightAllowsKnownWarningRange:
    preflightAllowedWithWarning.status === "warning" &&
    preflightAllowedWithWarning.canStart === true &&
    preflightAllowedWithWarning.shouldStop === false,
  recordingStopsBelow128MiB:
    recordingStorageEmergencyStopBytes === 128 * mib &&
    recordingCritical.status === "critical" &&
    recordingCritical.shouldStop === true,
  recordingWarnsAtBoundary:
    recordingWarning.status === "warning" && recordingWarning.canStart === true && recordingWarning.shouldStop === false,
  recordingReadyAt1GiB:
    recordingStorageWarningBytes === 1024 * mib &&
    recordingReady.status === "ready" &&
    recordingReady.canStart === true &&
    recordingReady.shouldStop === false,
  unavailableProbeDoesNotDestroyRecording:
    unavailable.status === "unavailable" && unavailable.canStart === true && unavailable.shouldStop === false,
  unknownStateIsNonDestructive: unknown.status === "unknown" && unknown.canStart === true && unknown.shouldStop === false,
  nativeFreeSpaceProbeIsBounded:
    appSource.includes("FileSystem.getFreeDiskStorageAsync()") &&
    appSource.includes('2000,\n      "读取设备剩余空间超时。"') &&
    appSource.includes("unavailableRecordingStorageHealth()"),
  preflightRunsBeforeRecorderRequestState:
    preflightIndex >= 0 &&
    requestStateIndex > preflightIndex &&
    appSource.includes("if (!storageHealth.canStart)") &&
    preflightFenceIndex >= recordingStartIndex &&
    preflightFenceIndex < preflightIndex &&
    permissionRequestIndex > preflightIndex &&
    appSource.includes(
      'recordingStartPreflightBusy || status === "requesting" || recordingActive || status === "processing"',
    ) &&
    appSource.includes('recordingStartPreflightBusy || status === "requesting"') &&
    appSource.includes("recordingStartPreflightBusy ||\n    status === \"requesting\""),
  preflightBlocksFirstRunNavigation:
    appSource.includes(
      'firstRunGuide && !recordingStartPreflightBusy && status === "idle" && !canShowMeetingProgress',
    ) &&
    appSource.includes(
      "if (recordingLifecycleBusyRef.current || recordingStopInFlightRef.current) return;\n    if (action === \"start\")",
    ),
  activeRecordingIsPolledEvery15Seconds:
    appSource.includes("const recordingStorageWatchIntervalMs = 15000") &&
    appSource.includes('readRecordingStorageHealth("recording")'),
  emergencyStopIsSingleFlight:
    appSource.includes("recordingStorageEmergencyStopRef.current") &&
    appSource.includes("recordingStopInFlightRef.current") &&
    appSource.includes('stopRecordingRef.current("low-storage")'),
  durationStopIsSingleFlight:
    appSource.includes("recordingDurationLimitStopRef.current") &&
    appSource.includes('stopRecordingRef.current("duration-limit")') &&
    appSource.includes('t("recordingFlow.durationLimit")'),
  durationDeadlineCountsRecordedAudioNotPausedWallClock:
    !appSource.includes("recordingSessionStartedAtRef") &&
    appSource.includes("recordingDurationRef.current") &&
    appSource.includes("setRecordingSessionElapsedMs") &&
    appSource.includes("assessRecordingDurationLimit(recordingSessionElapsedMs)"),
  nativeRecorderEnforcesDurationInBackground:
    appSource.includes("recorder.record({ forDuration: remainingRecordingDurationSeconds(0) })") &&
    appSource.includes("const remainingSeconds = remainingRecordingDurationSeconds(elapsedMs)") &&
    appSource.includes("recorder.record({ forDuration: remainingSeconds })") &&
    appSource.includes("nativeDurationLimitArmedRef.current = true"),
  nativeDurationCompletionCannotLeaveUiRecording:
    appSource.includes("nativeRecorderStatusRef.current = (event)") &&
    appSource.includes("classifyNativeRecordingCompletion") &&
    appSource.includes("mediaServicesDidReset: event.mediaServicesDidReset") &&
    appSource.includes('if (disposition === "ignore") return') &&
    appSource.includes("void stopRecordingRef.current(disposition)"),
  mediaServicesResetRoutesToDedicatedRecovery:
    appSource.includes('if (disposition === "media-services-reset")') &&
    appSource.includes("void handleMediaServicesReset()") &&
    appSource.includes("const recoveryUri = activeRecordingUriRef.current || activeRecordingUri") &&
    appSource.includes('t("runtime.mediaResetRecovered")') &&
    appSource.includes('t("runtime.mediaResetNeedsScan")'),
  stoppedFileDurationPrecedesRecoveryIndex:
    localDurationProbeIndex >= 0 &&
    persistIndex > localDurationProbeIndex &&
    appSource.includes("const durableDurationMs = Math.max(stoppedDurationMs, localMediaDurationMs ?? 0)") &&
    appSource.includes("durationMs: durableDurationMs"),
  localIndexPrecedesSuccessMessage:
    persistIndex >= 0 && indexedIndex > persistIndex &&
    appSource.includes("localRecordingIndexed") &&
    appSource.includes('"runtime.recordingIndexedSafely"'),
  failureMessageDoesNotClaimSuccess:
    appSource.includes('"runtime.recordingIndexUnconfirmed"') &&
    appSource.includes('t("runtime.stopFailedPreserved")') &&
    i18nSource.includes('recordingIndexUnconfirmed: "Recording ended, but the recovery index could not be confirmed.') &&
    i18nSource.includes('recordingIndexUnconfirmed: "录音已结束，但未能确认恢复索引。'),
  warningIsAccessibleAndVisible:
    appSource.includes('recordingActive && recordingStorageWarning') &&
    appSource.includes('accessibilityRole="alert"') &&
    appSource.includes('label: "设备存储空间"') &&
    appSource.includes('t("record.storageWarning"') &&
    i18nSource.includes('storageWarning: "设备空间剩余'),
  durationWarningIsAccessibleAndVisible:
    appSource.includes("recordingActive && recordingDurationLimit.shouldWarn") &&
    appSource.includes('label: "单场会话时长"') &&
    appSource.includes('state: !recordingActive') &&
    appSource.includes('t("record.durationWarning"') &&
    i18nSource.includes('durationWarning: "本场会议会话最多 2 小时') &&
    appSource.includes('accessibilityLiveRegion="polite"'),
};

console.log(JSON.stringify(checks, null, 2));
if (Object.values(checks).some((value) => !value)) process.exitCode = 1;
