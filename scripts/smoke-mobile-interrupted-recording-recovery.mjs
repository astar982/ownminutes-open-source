#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  assessInterruptedRecordingRecovery,
  isInterruptedRecordingState,
} from "../apps/mobile/src/interrupted-recording-recovery.ts";

const baseProbe = {
  exists: true,
  firstBytes: 48_000,
  secondBytes: 48_000,
  loaded: true,
  durationSeconds: 12.345,
};

assert.deepEqual(assessInterruptedRecordingRecovery(baseProbe), {
  recoverable: true,
  durationMs: 12_345,
  reason: "ready",
  message: "异常中断录音已确认可读取，可以继续上传并生成纪要。",
});
assert.equal(assessInterruptedRecordingRecovery({ ...baseProbe, exists: false }).reason, "missing");
assert.equal(assessInterruptedRecordingRecovery({ ...baseProbe, firstBytes: 512, secondBytes: 512 }).reason, "empty");
assert.equal(assessInterruptedRecordingRecovery({ ...baseProbe, secondBytes: 49_000 }).reason, "still-growing");
assert.equal(assessInterruptedRecordingRecovery({ ...baseProbe, loaded: false }).reason, "unreadable");
assert.equal(assessInterruptedRecordingRecovery({ ...baseProbe, playbackError: "decoder failed" }).reason, "unreadable");
assert.equal(assessInterruptedRecordingRecovery({ ...baseProbe, durationSeconds: 0 }).reason, "duration-missing");
assert.equal(isInterruptedRecordingState({ activeRecording: true, recordingLifecycleBusy: true }), false);
assert.equal(isInterruptedRecordingState({ activeRecording: true, recordingLifecycleBusy: false }), true);
assert.equal(isInterruptedRecordingState({ activeRecording: false, recordingLifecycleBusy: false }), false);

const appSource = readFileSync("apps/mobile/App.tsx", "utf8");
const pendingSyncSource = readFileSync("apps/mobile/src/pending-sync.ts", "utf8");
const recordingStoreSource = readFileSync("apps/mobile/src/recording-store.ts", "utf8");
const retryStart = appSource.indexOf("async function retryUpload(");
const retrySource = appSource.slice(retryStart);
const checks = {
  iosUsesCrashRecoverableCafContainer:
    appSource.includes('extension: ".caf"') &&
    appSource.includes("outputFormat: IOSOutputFormat.LINEARPCM") &&
    appSource.includes("linearPCMBitDepth: 16") &&
    appSource.includes("linearPCMIsBigEndian: false") &&
    appSource.includes("linearPCMIsFloat: false") &&
    recordingStoreSource.includes('if (extension === ".caf") return "audio/x-caf"'),
  activeRecordingsNeverAutoSync: pendingSyncSource.includes("recording.activeRecording !== true"),
  activeRecordingsExcludedFromAutoTimer: appSource.includes("recording.activeRecording !== true"),
  fileSizeCheckedTwice: appSource.includes("firstBytes !== secondBytes"),
  playerLoadRequired: appSource.includes("createAudioPlayer(recording.uri") && appSource.includes("status.isLoaded"),
  durationRecoveredFromMedia: appSource.includes("durationMs: assessment.durationMs"),
  recoveryIsUserVisible:
    appSource.includes("{!pendingRecording?.activeRecording || hasInterruptedRecording ? (") &&
    appSource.includes('label={hasInterruptedRecording ? t("record.recover")'),
  interruptedRecordingOwnsHeroAction:
    appSource.includes("isInterruptedRecordingState({") &&
    appSource.includes("recordingLifecycleBusy,") &&
    appSource.includes('hasInterruptedRecording\n        ? t("record.recover")') &&
    appSource.includes("if (hasInterruptedRecording) {") &&
    appSource.includes("void retryUpload();"),
  failedRecoveryPreservesFile:
    appSource.includes('setAutoSyncMessage(t("runtime.interruptedUnavailable"), "warning")') &&
    appSource.includes('lastError: t("runtime.interruptedUnavailable")') &&
    !appSource.includes("deleteRecordingFile(target.uri)"),
  interruptedRecoveryDurablyClosesRealtimeSession:
    recordingStoreSource.includes("realtimeClosePendingAt?: string") &&
    retrySource.includes("realtimeClosePendingAt: target.realtimeClosePendingAt ?? target.createdAt") &&
    appSource.includes("if (working.realtimeClosePendingAt)") &&
    appSource.includes("await finishRealtimePcmSessionIfPresent({"),
};

assert.ok(Object.values(checks).every(Boolean), JSON.stringify(checks, null, 2));
console.log(JSON.stringify({ ok: true, checks }, null, 2));
