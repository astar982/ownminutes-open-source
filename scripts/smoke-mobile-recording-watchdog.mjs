#!/usr/bin/env node

import { readFileSync } from "node:fs";

const { assessRecordingFileHealth, createRecordingFileHealth, recordingFileStallThresholdMs } = await import(
  "../apps/mobile/src/recording-health.ts"
);

const startedAt = 1_000;
const initial = createRecordingFileHealth(startedAt);
const growing = assessRecordingFileHealth(initial, {
  durationMs: 5_000,
  exists: true,
  now: 6_000,
  recording: true,
  size: 160_000,
});
const waiting = assessRecordingFileHealth(initial, {
  durationMs: 9_000,
  exists: true,
  now: 10_000,
  recording: true,
  size: 0,
});
const stalled = assessRecordingFileHealth(initial, {
  durationMs: recordingFileStallThresholdMs + 1,
  exists: true,
  now: startedAt + recordingFileStallThresholdMs + 1,
  recording: true,
  size: 0,
});
const paused = assessRecordingFileHealth(initial, {
  durationMs: 60_000,
  exists: true,
  now: 61_000,
  recording: false,
  size: 0,
});
const missing = assessRecordingFileHealth(growing, {
  durationMs: 10_000,
  exists: false,
  now: 11_000,
  recording: true,
  size: growing.bytes,
});

const appSource = readFileSync("apps/mobile/App.tsx", "utf8");
const i18nSource = readFileSync("apps/mobile/src/i18n/core.ts", "utf8");
const storeSource = readFileSync("apps/mobile/src/recording-store.ts", "utf8");
const watchdogStart = appSource.indexOf('if (!activeRecordingUri || (status !== "recording" && status !== "paused")) return;');
const watchdogEnd = appSource.indexOf("}, [activeRecordingUri, status, t]);", watchdogStart);
const watchdogFlow = watchdogStart >= 0 && watchdogEnd > watchdogStart
  ? appSource.slice(watchdogStart, watchdogEnd)
  : "";
const checks = {
  detectsHealthyGrowth: growing.status === "healthy" && growing.bytes === 160_000 && growing.lastGrowthAt === 6_000,
  waitsBeforeThreshold: waiting.status === "waiting",
  detectsStalledFile: stalled.status === "stalled",
  doesNotFlagPausedRecording: paused.status === "paused",
  detectsMissingFile: missing.status === "missing",
  resolvesDelayedUriIntoRecoveryIndex:
    appSource.includes("resolveDelayedRecordingUri") &&
    appSource.includes("delayedRecordingUriAttempts") &&
    appSource.includes("recordingGenerationRef.current !== input.generation") &&
    appSource.includes("activeRecording: true") &&
    appSource.includes('t("runtime.recordingIndexConfirmed")'),
  watchesNativeFileGrowth:
    appSource.includes("recordingFileWatchIntervalMs") &&
    appSource.includes("FileSystem.getInfoAsync(activeRecordingUri)") &&
    appSource.includes("assessRecordingFileHealth") &&
    appSource.includes('t("record.fileHealthy"') &&
    i18nSource.includes('fileHealthy: "本地音频持续写入'),
  restoresInterruptedIndexedRecording:
    storeSource.includes("activeRecording?: boolean") &&
    storeSource.includes("activeRecording: parsed.activeRecording") &&
    appSource.includes('t("runtime.recoveredInterruptedRecording"'),
  cancelsSupersededWatchers:
    countOccurrences(appSource, "recordingGenerationRef.current += 1") >= 3 &&
    appSource.includes("isCancelled: () => recordingGenerationRef.current !== input.generation"),
  safeStopsAfterTwoConsecutiveFailures:
    watchdogFlow.includes("recordingFileWatchdogFailuresRef.current += 1") &&
    watchdogFlow.includes("recordingFileWatchdogFailuresRef.current >= 2") &&
    watchdogFlow.includes("recordingFileWatchdogStopRef.current") &&
    watchdogFlow.includes('stopRecordingRef.current(next.status === "missing" ? "file-missing" : "file-stalled")') &&
    watchdogFlow.includes('stopRecordingRef.current("file-missing")'),
  watchdogStopIsSingleFlightAndRecoversAfterHealthyProbe:
    countOccurrences(watchdogFlow, "!recordingFileWatchdogStopRef.current") >= 2 &&
    countOccurrences(watchdogFlow, "recordingFileWatchdogStopRef.current = true") >= 2 &&
    watchdogFlow.includes("recordingFileWatchdogFailuresRef.current = 0"),
};

console.log(JSON.stringify(checks, null, 2));
if (Object.values(checks).some((value) => !value)) process.exitCode = 1;

function countOccurrences(input, pattern) {
  return input.split(pattern).length - 1;
}
