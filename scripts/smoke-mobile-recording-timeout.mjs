#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  RecordingStoreTimeoutError,
  withRecordingStoreTimeout,
} from "../apps/mobile/src/recording-store-timeout.ts";

assert.equal(await withRecordingStoreTimeout(Promise.resolve("ready"), 50), "ready");
await assert.rejects(
  withRecordingStoreTimeout(new Promise(() => {}), 15),
  (error) => error instanceof RecordingStoreTimeoutError,
);
const expected = new Error("forwarded");
await assert.rejects(withRecordingStoreTimeout(Promise.reject(expected), 50), (error) => error === expected);

const appSource = readFileSync("apps/mobile/App.tsx", "utf8");
const recordingStoreSource = readFileSync("apps/mobile/src/recording-store.ts", "utf8");
const restoreFlow = appSource.slice(
  appSource.indexOf("const restorePendingRecording = useCallback"),
  appSource.indexOf("const activatePendingRecording", appSource.indexOf("const restorePendingRecording = useCallback")),
);
const restoreSessionFlow = appSource.slice(
  appSource.indexOf("const restoreSession = useCallback"),
  appSource.indexOf("function updateApiBaseUrl", appSource.indexOf("const restoreSession = useCallback")),
);

assert.ok(appSource.includes("const recordingRestoreBudgetMs = 12_000"));
assert.ok(/withTimeout\(\s*loadPendingRecordings\(\),\s*recordingRestoreBudgetMs/.test(restoreFlow));
assert.ok(restoreFlow.includes("setRecordingRecoveryError"));
assert.ok(restoreFlow.includes("issueMessages.length > 0 ? issueMessages.join(\" \") : null"));
assert.ok(restoreSessionFlow.includes("setSessionRestoreComplete(true)"));
assert.ok(recordingStoreSource.includes("export const recordingStoreFileProbeTimeoutMs = 2_500"));
assert.ok(recordingStoreSource.includes("withRecordingStoreTimeout("));

console.log(JSON.stringify({
  appLaunchRecoveryHasTotalBudget: true,
  oldRecoveryWarningClearsAfterHealthyScan: true,
  perFileProbesAreBounded: true,
  timeoutForwardsSuccessAndFailure: true,
}, null, 2));
