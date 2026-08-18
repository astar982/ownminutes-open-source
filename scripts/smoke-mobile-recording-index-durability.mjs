#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import {
  createSerialExecutor,
  readAtomicArrayIndex,
  writeAtomicArrayIndex,
} from "../apps/mobile/src/atomic-recording-index.ts";
import { withRecordingStoreTimeout } from "../apps/mobile/src/recording-store-timeout.ts";
import { selectDeviceLegacyRecoveryRecordings } from "../apps/mobile/src/local-recording-privacy.ts";

const nodeRequire = createRequire(import.meta.url);
const ts = nodeRequire("../apps/mobile/node_modules/typescript/lib/typescript.js");

const paths = {
  backup: "/recordings/index.json.backup",
  backupTemporary: "/recordings/index.json.backup.tmp",
  primary: "/recordings/index.json",
  temporary: "/recordings/index.json.tmp",
};
const store = createMemoryStore();
const isItem = (value) => Boolean(value && typeof value === "object" && typeof value.meetingId === "string");
const first = [{ meetingId: "meeting-1" }];
const second = [{ meetingId: "meeting-2" }, ...first];

await writeAtomicArrayIndex(store, paths, first, isItem);
assert.deepEqual(JSON.parse(store.files.get(paths.primary)), first);
assert.deepEqual(JSON.parse(store.files.get(paths.backup)), first);

store.files.set(paths.backup, "stale-corrupt-backup");
const healthyPrimary = await readAtomicArrayIndex(store, paths, isItem);
assert.equal(healthyPrimary.source, "primary");
assert.deepEqual(JSON.parse(store.files.get(paths.backup)), first);

store.files.set(paths.primary, "{truncated");
const backupRecovery = await readAtomicArrayIndex(store, paths, isItem);
assert.equal(backupRecovery.source, "backup");
assert.deepEqual(backupRecovery.records, first);
assert.deepEqual(JSON.parse(store.files.get(paths.primary)), first);

store.failMoveDestination = paths.primary;
await assert.rejects(writeAtomicArrayIndex(store, paths, second, isItem), /injected move failure/);
const interruptedCommitRecovery = await readAtomicArrayIndex(store, paths, isItem);
assert.equal(interruptedCommitRecovery.source, "temporary");
assert.deepEqual(interruptedCommitRecovery.records, second);
assert.deepEqual(JSON.parse(store.files.get(paths.backup)), second);

store.files.set(paths.primary, "invalid-primary");
store.files.set(paths.backup, "invalid-backup");
store.files.delete(paths.temporary);
const unrecoverable = await readAtomicArrayIndex(store, paths, isItem);
assert.equal(unrecoverable.source, "unrecoverable");
assert.deepEqual(unrecoverable.records, []);
assert.equal(store.files.get(paths.primary), "invalid-primary");
assert.equal(store.files.get(paths.backup), "invalid-backup");

const runSerially = createSerialExecutor();
let active = 0;
let maximumActive = 0;
const completionOrder = [];
await Promise.all(
  Array.from({ length: 20 }, (_, index) =>
    runSerially(async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, index % 3));
      completionOrder.push(index);
      active -= 1;
    }),
  ),
);
assert.equal(maximumActive, 1);
assert.deepEqual(completionOrder, Array.from({ length: 20 }, (_, index) => index));
await assert.rejects(runSerially(async () => Promise.reject(new Error("injected mutation failure"))));
assert.equal(await runSerially(async () => "continued"), "continued");

const recordingStoreSource = readFileSync("apps/mobile/src/recording-store.ts", "utf8");
const appSource = readFileSync("apps/mobile/App.tsx", "utf8");
const apiSource = readFileSync("apps/mobile/src/api.ts", "utf8");
const i18nSource = readFileSync("apps/mobile/src/i18n/core.ts", "utf8");
const startFlow = appSource.slice(
  appSource.indexOf("async function doStartRecording("),
  appSource.indexOf("async function pauseRecording()"),
);
const resetFlow = appSource.slice(
  appSource.indexOf("async function resetMeeting()"),
  appSource.indexOf("async function handleMediaServicesReset()"),
);
assert.ok(recordingStoreSource.includes("const runRecordingStoreMutation = createSerialExecutor()"));
assert.ok(recordingStoreSource.includes('index.source === "unrecoverable"'));
assert.ok(recordingStoreSource.includes("已停止写入以保护原音频"));
assert.ok(recordingStoreSource.includes("已停止删除以保护原音频"));
assert.ok(appSource.includes("const issueMessages = (snapshot.issues ?? []).map"));
assert.ok(appSource.includes('setRecordingRecoveryError(issueMessages.length > 0 ? issueMessages.join(" ") : null)'));
assert.ok(appSource.includes('case "indexed_file_inaccessible"'));
assert.ok(i18nSource.match(/localIndexedFilesUnavailable:/g)?.length === 3);
assert.ok(appSource.includes("if (snapshot.notice)"));
assert.ok(appSource.includes("setAutoSyncMessage(notices.join"));
assert.ok(!recordingStoreSource.includes("FileSystem.deleteAsync(destination"));
assert.ok(recordingStoreSource.includes("destinationInfo.size >= sourceInfo.size"));
assert.ok(recordingStoreSource.includes("scanRootOrphanRecordings"));
assert.ok(recordingStoreSource.includes('`${documentDirectory}ExpoAudio/`'));
assert.ok(recordingStoreSource.includes("recordingDirectory(), pattern: managedRecordingNamePattern"));
assert.ok(recordingStoreSource.includes("localRecoveryOnly: true"));
assert.ok(recordingStoreSource.includes('kind: "indexed_file_inaccessible"'));
assert.ok(appSource.includes("const hasIsolatedRecovery = pendingRecording?.localRecoveryOnly === true"));
assert.ok(appSource.includes("if (hasIsolatedRecovery) {"));
assert.ok(appSource.includes("void resetMeeting();"));
assert.ok(appSource.includes("deviceLegacyRecoveryRecordings.map"));
assert.ok(appSource.includes('t("runtime.localRecoveryReadOnly")'));
assert.ok(appSource.includes("confirmDeleteSelectedLocalRecording"));
assert.ok(appSource.includes("deleteLocalRecordingFromDevice({"));
assert.ok(recordingStoreSource.includes("export async function deleteLocalRecordingFromDevice"));
assert.ok(appSource.includes("<MeetingAudioPlayer"));
assert.ok(appSource.includes("onExport={() => void shareSelectedMeetingRecording()"));
assert.ok(!startFlow.includes("deleteRecordingFile("));
assert.ok(!resetFlow.includes("deleteRecordingFile("));
const durableRecorderVerifiedIndex = startFlow.indexOf("if (!recorder.getStatus().isRecording)");
const realtimeJournalPersistIndex = startFlow.indexOf("await preparePendingRealtimeSession({");
const realtimeBufferActivationIndex = startFlow.indexOf("resetRealtimePcmBuffer(nextMeetingId", realtimeJournalPersistIndex);
const realtimeStreamStartIndex = startFlow.indexOf("await audioStream.stream.start()", realtimeJournalPersistIndex);
assert.ok(durableRecorderVerifiedIndex >= 0 && durableRecorderVerifiedIndex < realtimeJournalPersistIndex);
assert.ok(realtimeJournalPersistIndex >= 0 && realtimeJournalPersistIndex < realtimeBufferActivationIndex);
assert.ok(realtimeBufferActivationIndex >= 0 && realtimeBufferActivationIndex < realtimeStreamStartIndex);
assert.ok(startFlow.includes("if (activeRealtimeJournalMeetingIdRef.current !== nextMeetingId) return;"));
assert.ok(appSource.includes("await attachPendingRealtimeSessionUri(input.meetingId, uri)"));
assert.ok(appSource.includes('consentMethod: "in_app_confirmation"'));
assert.ok(appSource.includes('const recordingConsentPolicyVersion = "2026-07-30"'));
assert.ok(appSource.includes('consentMethod: working.consentMethod ?? "legacy_unknown"'));
assert.ok(apiSource.includes('"X-OwnMinutes-Consent-Confirmed-At"'));
assert.ok(apiSource.includes('"X-OwnMinutes-Consent-Method"'));
assert.ok(apiSource.includes('"X-OwnMinutes-Consent-Policy-Version"'));

const recordingStoreRecovery = await runRecordingStoreRecoveryScenarios(recordingStoreSource);

console.log(JSON.stringify({
  backupRecovery: backupRecovery.source,
  healthyPrimaryRefreshedBackup: healthyPrimary.source === "primary",
  interruptedCommitRecovery: interruptedCommitRecovery.source,
  maximumConcurrentMutations: maximumActive,
  recordingStoreRecovery,
  preservesCorruptFiles: store.files.get(paths.primary) === "invalid-primary" && store.files.get(paths.backup) === "invalid-backup",
}, null, 2));

async function runRecordingStoreRecoveryScenarios(source) {
  const oldManagedUri =
    "file:///var/mobile/Containers/Data/Application/OLD-CONTAINER/Documents/ownminutes-recordings/meeting-upgraded.m4a";
  const currentManagedUri = "file:///documents/ownminutes-recordings/meeting-upgraded.m4a";
  const upgradedContainer = createRecordingStoreHarness(source, {
    records: [pendingRecording("meeting-upgraded", oldManagedUri)],
  });
  upgradedContainer.addFile(currentManagedUri, 80_000, 1_000);
  const upgradedSnapshot = await upgradedContainer.module.loadPendingRecordings();
  assert.equal(upgradedSnapshot.recordings[0].uri, currentManagedUri);
  assert.deepEqual(upgradedSnapshot.recordings[0].recoverySourceUris, [oldManagedUri]);
  assert.equal(upgradedSnapshot.notice?.relocatedCount, 1);
  assert.equal(upgradedContainer.state.deleteCalls, 0);
  assert.equal(upgradedContainer.state.writeCount, 2);

  // Mirrors the reported device state: exactly five index entries still point
  // at the previous iOS app container after a TestFlight update.
  const fiveOldContainerRecords = Array.from({ length: 5 }, (_, index) => {
    const meetingId = `meeting-old-container-${index + 1}`;
    return pendingRecording(
      meetingId,
      `file:///var/mobile/Containers/Data/Application/OLD-CONTAINER/Documents/ownminutes-recordings/${meetingId}.m4a`,
    );
  });
  const fiveOldContainer = createRecordingStoreHarness(source, { records: fiveOldContainerRecords });
  for (const recording of fiveOldContainerRecords) {
    fiveOldContainer.addFile(
      `file:///documents/ownminutes-recordings/${recording.meetingId}.m4a`,
      80_000,
      1_000,
    );
  }
  const fiveOldContainerSnapshot = await fiveOldContainer.module.loadPendingRecordings();
  assert.equal(fiveOldContainerSnapshot.recordings.length, 5);
  assert.equal(fiveOldContainerSnapshot.notice?.relocatedCount, 5);
  for (const original of fiveOldContainerRecords) {
    const migrated = fiveOldContainerSnapshot.recordings.find(
      (recording) => recording.meetingId === original.meetingId,
    );
    const expectedUri = `file:///documents/ownminutes-recordings/${original.meetingId}.m4a`;
    assert.equal(migrated?.uri, expectedUri);
    assert.deepEqual(migrated?.recoverySourceUris, [original.uri]);
    assert.equal(fiveOldContainer.fileSize(expectedUri), 80_000);
  }
  assert.equal(fiveOldContainer.state.deleteCalls, 0);
  assert.equal(fiveOldContainer.state.writeCount, 2);

  const oldExpoAudioUri =
    "file:///var/mobile/Containers/Data/Application/OLD-CONTAINER/Documents/ExpoAudio/recording-interrupted.caf";
  const currentExpoAudioUri = "file:///documents/ExpoAudio/recording-interrupted.caf";
  const upgradedExpoAudio = createRecordingStoreHarness(source, {
    records: [{ ...pendingRecording("meeting-upgraded-active", oldExpoAudioUri), activeRecording: true }],
  });
  upgradedExpoAudio.addFile(
    currentExpoAudioUri,
    90_000,
    Date.parse("2026-07-17T00:00:00.000Z") / 1000,
  );
  const upgradedExpoSnapshot = await upgradedExpoAudio.module.loadPendingRecordings();
  assert.equal(upgradedExpoSnapshot.recordings[0].uri, currentExpoAudioUri);
  assert.deepEqual(upgradedExpoSnapshot.recordings[0].recoverySourceUris, [oldExpoAudioUri]);
  assert.equal(upgradedExpoAudio.state.deleteCalls, 0);

  const originalStillAvailable = createRecordingStoreHarness(source, {
    records: [pendingRecording("meeting-original-available", oldManagedUri)],
  });
  originalStillAvailable.addFile(oldManagedUri, 70_000, 1_000);
  originalStillAvailable.addFile(currentManagedUri, 80_000, 1_000);
  const originalStillAvailableSnapshot = await originalStillAvailable.module.loadPendingRecordings();
  assert.equal(originalStillAvailableSnapshot.recordings[0].uri, oldManagedUri);
  assert.equal(originalStillAvailableSnapshot.recordings[0].recoverySourceUris, undefined);

  const originalProbeUnavailable = createRecordingStoreHarness(source, {
    records: [pendingRecording("meeting-original-unavailable", oldManagedUri)],
  });
  originalProbeUnavailable.failInfo(oldManagedUri);
  originalProbeUnavailable.addFile(currentManagedUri, 80_000, 1_000);
  const originalProbeUnavailableSnapshot = await originalProbeUnavailable.module.loadPendingRecordings();
  assert.equal(originalProbeUnavailableSnapshot.recordings[0].uri, oldManagedUri);
  assert.equal(originalProbeUnavailableSnapshot.recordings[0].recoverySourceUris, undefined);
  assert.equal(issueCount(originalProbeUnavailableSnapshot, "indexed_file_inaccessible"), 1);

  const destinationAlreadyOwnedUri = "file:///documents/ownminutes-recordings/meeting-owned.m4a";
  const destinationAlreadyOwned = createRecordingStoreHarness(source, {
    records: [
      pendingRecording(
        "meeting-owned",
        "file:///var/mobile/Containers/Data/Application/OLD-CONTAINER/Documents/ownminutes-recordings/meeting-owned.m4a",
      ),
      pendingRecording("meeting-current-owner", destinationAlreadyOwnedUri),
    ],
  });
  destinationAlreadyOwned.addFile(destinationAlreadyOwnedUri, 90_000, Date.parse("2026-07-17T00:00:00.000Z") / 1000);
  const destinationAlreadyOwnedSnapshot = await destinationAlreadyOwned.module.loadPendingRecordings();
  assert.match(
    destinationAlreadyOwnedSnapshot.recordings.find((recording) => recording.meetingId === "meeting-owned")?.uri ?? "",
    /OLD-CONTAINER/,
  );

  const duplicateDestination = createRecordingStoreHarness(source, {
    records: [
      pendingRecording(
        "meeting-duplicate",
        "file:///old-a/Documents/ownminutes-recordings/meeting-duplicate.m4a",
      ),
      pendingRecording(
        "meeting-duplicate-copy",
        "file:///old-b/Documents/ownminutes-recordings/meeting-duplicate.m4a",
      ),
    ],
  });
  duplicateDestination.addFile(
    "file:///documents/ownminutes-recordings/meeting-duplicate.m4a",
    90_000,
    Date.parse("2026-07-17T00:00:00.000Z") / 1000,
  );
  const duplicateDestinationSnapshot = await duplicateDestination.module.loadPendingRecordings();
  assert.equal(
    duplicateDestinationSnapshot.recordings
      .filter((recording) => recording.meetingId.startsWith("meeting-duplicate"))
      .every((recording) => recording.uri.includes("file:///old-")),
    true,
  );
  assert.equal(
    duplicateDestinationSnapshot.recordings.some(
      (recording) => recording.uri === "file:///documents/ownminutes-recordings/meeting-duplicate.m4a" && recording.localRecoveryOnly,
    ),
    true,
  );

  const mismatchedManagedName = createRecordingStoreHarness(source, {
    records: [pendingRecording(
      "meeting-private-a",
      "file:///old/Documents/ownminutes-recordings/meeting-private-b.m4a",
    )],
  });
  mismatchedManagedName.addFile(
    "file:///documents/ownminutes-recordings/meeting-private-b.m4a",
    90_000,
    Date.parse("2026-07-17T00:00:00.000Z") / 1000,
  );
  const mismatchedManagedNameSnapshot = await mismatchedManagedName.module.loadPendingRecordings();
  assert.match(mismatchedManagedNameSnapshot.recordings[0].uri, /file:\/\/\/old\//);

  const staleExpoTimestamp = createRecordingStoreHarness(source, {
    records: [{ ...pendingRecording("meeting-stale-expo", oldExpoAudioUri), activeRecording: true }],
  });
  staleExpoTimestamp.addFile(currentExpoAudioUri, 90_000, Date.parse("2026-07-01T00:00:00.000Z") / 1000);
  const staleExpoTimestampSnapshot = await staleExpoTimestamp.module.loadPendingRecordings();
  assert.equal(staleExpoTimestampSnapshot.recordings[0].uri, oldExpoAudioUri);

  const unmanagedTraversal = createRecordingStoreHarness(source, {
    records: [
      pendingRecording(
        "meeting-unmanaged-traversal",
        "file:///old/Documents/ownminutes-recordings/nested/recording-unsafe.m4a",
      ),
    ],
  });
  unmanagedTraversal.addFile("file:///documents/ownminutes-recordings/recording-unsafe.m4a", 80_000, 1_000);
  const unmanagedTraversalSnapshot = await unmanagedTraversal.module.loadPendingRecordings();
  assert.equal(
    unmanagedTraversalSnapshot.recordings[0].uri,
    "file:///old/Documents/ownminutes-recordings/nested/recording-unsafe.m4a",
  );
  const unmanagedTraversalDelete = await unmanagedTraversal.module.deletePendingRecordingAfterRemoteDelete(
    "meeting-unmanaged-traversal",
  );
  assert.equal(unmanagedTraversalDelete.pending, false);
  assert.equal(unmanagedTraversal.fileSize("file:///documents/ownminutes-recordings/recording-unsafe.m4a"), 80_000);
  assert.equal(unmanagedTraversal.state.deleteCalls, 0);

  const largeConflict = createRecordingStoreHarness(source);
  largeConflict.addFile("file:///documents/recording-large.caf", 20_000, 1_000);
  largeConflict.addFile("file:///documents/ownminutes-recordings/meeting-large.caf", 10_000, 900);
  const largerUri = await largeConflict.module.moveRecordingIntoManagedDirectory(
    "meeting-large",
    "file:///documents/recording-large.caf",
  );
  assert.match(largerUri, /meeting-large-recovered-/);
  assert.equal(largeConflict.fileSize("file:///documents/ownminutes-recordings/meeting-large.caf"), 10_000);
  assert.equal(largeConflict.fileSize(largerUri), 20_000);
  assert.equal(largeConflict.state.deleteCalls, 0);

  const smallConflict = createRecordingStoreHarness(source);
  smallConflict.addFile("file:///documents/recording-small.caf", 5_000, 1_000);
  smallConflict.addFile("file:///documents/ownminutes-recordings/meeting-small.caf", 25_000, 900);
  const retainedUri = await smallConflict.module.moveRecordingIntoManagedDirectory(
    "meeting-small",
    "file:///documents/recording-small.caf",
  );
  assert.equal(retainedUri, "file:///documents/ownminutes-recordings/meeting-small.caf");
  assert.equal(smallConflict.fileSize("file:///documents/recording-small.caf"), 5_000);
  assert.equal(smallConflict.fileSize(retainedUri), 25_000);
  assert.equal(smallConflict.state.deleteCalls, 0);

  const missing = createRecordingStoreHarness(source, {
    records: [pendingRecording("meeting-missing", "file:///documents/ownminutes-recordings/meeting-missing.caf")],
  });
  const missingSnapshot = await missing.module.loadPendingRecordings();
  assert.equal(missingSnapshot.recordings.length, 1);
  assert.equal(missingSnapshot.recordings[0].meetingId, "meeting-missing");
  assert.equal(missingSnapshot.recordings[0].consentMethod, "legacy_unknown");
  assert.equal(issueCount(missingSnapshot, "indexed_file_inaccessible"), 1);
  assert.equal(missing.state.records.length, 1);

  const temporarilyUnavailable = createRecordingStoreHarness(source, {
    records: [
      pendingRecording(
        "meeting-unavailable",
        "file:///documents/ownminutes-recordings/meeting-unavailable.caf",
      ),
    ],
  });
  temporarilyUnavailable.failInfo("file:///documents/ownminutes-recordings/meeting-unavailable.caf");
  const unavailableSnapshot = await temporarilyUnavailable.module.loadPendingRecordings();
  assert.equal(unavailableSnapshot.recordings.length, 1);
  assert.equal(unavailableSnapshot.recordings[0].meetingId, "meeting-unavailable");
  assert.equal(issueCount(unavailableSnapshot, "indexed_file_inaccessible"), 1);

  const exactlyFiveHungRecords = Array.from({ length: 5 }, (_, index) => pendingRecording(
    `meeting-hung-${index + 1}`,
    `file:///documents/ownminutes-recordings/meeting-hung-${index + 1}.caf`,
  ));
  const exactlyFiveHung = createRecordingStoreHarness(source, { records: exactlyFiveHungRecords });
  for (const recording of exactlyFiveHungRecords) exactlyFiveHung.hangInfo(recording.uri);
  const fiveHungStartedAt = Date.now();
  const fiveHungSnapshot = await exactlyFiveHung.module.loadPendingRecordings();
  const fiveHungElapsedMs = Date.now() - fiveHungStartedAt;
  assert.ok(fiveHungElapsedMs < 7_500, `five hung probes exceeded bounded recovery budget: ${fiveHungElapsedMs}ms`);
  assert.equal(fiveHungSnapshot.recordings.length, 5);
  assert.equal(issueCount(fiveHungSnapshot, "indexed_file_inaccessible"), 5);
  assert.equal(exactlyFiveHung.state.deleteCalls, 0);
  assert.equal(exactlyFiveHung.state.records.length, 5);

  const startedAt = Date.parse("2026-07-17T02:00:00.000Z");
  const matched = createRecordingStoreHarness(source, {
    records: [
      {
        ...pendingRecording("meeting-reset", "file:///documents/ownminutes-recordings/meeting-reset.caf", startedAt),
        activeRecording: true,
        audioUploadedAt: "2026-07-17T02:01:00.000Z",
      },
    ],
  });
  matched.addFile("file:///documents/ownminutes-recordings/meeting-reset.caf", 100, startedAt / 1000);
  matched.addFile("file:///documents/ExpoAudio/recording-interrupted.caf", 1_200_000, (startedAt + 20 * 60_000) / 1000);
  const matchedSnapshot = await matched.module.loadPendingRecordings();
  assert.equal(matchedSnapshot.recordings.length, 1);
  assert.equal(matchedSnapshot.recordings[0].meetingId, "meeting-reset");
  assert.equal(matchedSnapshot.recordings[0].uri, "file:///documents/ExpoAudio/recording-interrupted.caf");
  assert.equal(matchedSnapshot.recordings[0].audioUploadedAt, undefined);
  assert.equal(matched.fileSize("file:///documents/ownminutes-recordings/meeting-reset.caf"), 100);
  assert.equal(matched.fileSize("file:///documents/ExpoAudio/recording-interrupted.caf"), 1_200_000);
  assert.equal(matchedSnapshot.notice?.orphanMatchedCount, 1);
  assert.equal(matched.state.deleteCalls, 0);

  const completedMissing = createRecordingStoreHarness(source, {
    records: [
      pendingRecording(
        "meeting-completed-missing",
        "file:///documents/ownminutes-recordings/meeting-completed-missing.caf",
        startedAt,
      ),
    ],
  });
  completedMissing.addFile(
    "file:///documents/recording-unrelated.caf",
    900_000,
    (startedAt + 10 * 60_000) / 1000,
  );
  const completedMissingSnapshot = await completedMissing.module.loadPendingRecordings();
  const completedMissingRecord = completedMissingSnapshot.recordings.find(
    (recording) => recording.meetingId === "meeting-completed-missing",
  );
  const quarantinedUnrelated = completedMissingSnapshot.recordings.find(
    (recording) => recording.localRecoveryOnly,
  );
  assert.equal(
    completedMissingRecord?.uri,
    "file:///documents/ownminutes-recordings/meeting-completed-missing.caf",
  );
  assert.ok(quarantinedUnrelated);
  assert.equal(quarantinedUnrelated.uri, "file:///documents/recording-unrelated.caf");

  const ambiguous = createRecordingStoreHarness(source, {
    records: [
      { ...pendingRecording("meeting-a", "file:///documents/missing-a.caf", startedAt), activeRecording: true },
      { ...pendingRecording("meeting-b", "file:///documents/missing-b.caf", startedAt + 60_000), activeRecording: true },
    ],
  });
  ambiguous.addFile(
    "file:///documents/recording-ambiguous.caf",
    700_000,
    (startedAt + 30_000) / 1000,
  );
  const ambiguousSnapshot = await ambiguous.module.loadPendingRecordings();
  assert.equal(ambiguousSnapshot.recordings.find((recording) => recording.meetingId === "meeting-a")?.uri, "file:///documents/missing-a.caf");
  assert.equal(ambiguousSnapshot.recordings.find((recording) => recording.meetingId === "meeting-b")?.uri, "file:///documents/missing-b.caf");
  assert.equal(ambiguousSnapshot.recordings.filter((recording) => recording.localRecoveryOnly).length, 1);

  const multipleOrphans = createRecordingStoreHarness(source, {
    records: [
      { ...pendingRecording("meeting-single", "file:///documents/missing-single.caf", startedAt), activeRecording: true },
    ],
  });
  multipleOrphans.addFile("file:///documents/recording-option-a.caf", 600_000, (startedAt + 20_000) / 1000);
  multipleOrphans.addFile("file:///documents/recording-option-b.caf", 800_000, (startedAt + 40_000) / 1000);
  const multipleOrphansSnapshot = await multipleOrphans.module.loadPendingRecordings();
  assert.equal(
    multipleOrphansSnapshot.recordings.find((recording) => recording.meetingId === "meeting-single")?.uri,
    "file:///documents/missing-single.caf",
  );
  assert.equal(multipleOrphansSnapshot.recordings.filter((recording) => recording.localRecoveryOnly).length, 2);

  const isolated = createRecordingStoreHarness(source, {
    records: [pendingRecording("meeting-healthy", "file:///documents/ownminutes-recordings/meeting-healthy.caf", startedAt)],
  });
  isolated.addFile("file:///documents/ownminutes-recordings/meeting-healthy.caf", 2_000_000, startedAt / 1000);
  isolated.addFile("file:///documents/recording-unmatched.wav", 800_000, (startedAt + 8 * 60 * 60_000) / 1000);
  const isolatedSnapshot = await isolated.module.loadPendingRecordings();
  const isolatedRecord = isolatedSnapshot.recordings.find((recording) => recording.localRecoveryOnly);
  assert.ok(isolatedRecord);
  assert.equal(isolatedRecord.activeRecording, true);
  assert.match(isolatedRecord.meetingId, /^local-recovery-/);
  assert.equal(issueCount(isolatedSnapshot, "isolated_recording"), 1);
  assert.equal(isolatedSnapshot.recordings.length, 2);
  const attemptedRelease = await isolated.module.upsertPendingRecording({
    ...isolatedRecord,
    activeRecording: false,
  });
  assert.equal(attemptedRelease.find((recording) => recording.meetingId === isolatedRecord.meetingId)?.activeRecording, true);
  const duplicateScan = await isolated.module.loadPendingRecordings();
  assert.equal(duplicateScan.recordings.filter((recording) => recording.localRecoveryOnly).length, 1);
  assert.equal(duplicateScan.recordings.length, 2);

  const immediateDeletion = createRecordingStoreHarness(source, {
    records: [pendingRecording("meeting-delete-now", "file:///documents/ownminutes-recordings/meeting-delete-now.caf")],
  });
  immediateDeletion.addFile("file:///documents/ownminutes-recordings/meeting-delete-now.caf", 64_000, 1_000);
  const immediateDeletionResult = await immediateDeletion.module.deletePendingRecordingAfterRemoteDelete("meeting-delete-now");
  assert.equal(immediateDeletionResult.cleaned, true);
  assert.equal(immediateDeletionResult.pending, false);
  assert.equal(immediateDeletionResult.recordings.length, 0);
  assert.equal(immediateDeletion.state.records.length, 1);
  assert.ok(immediateDeletion.state.records[0].localDeletionPendingAt);
  assert.ok(immediateDeletion.state.records[0].localDeletionCompletedAt);
  assert.equal(immediateDeletion.state.writeCount, 2);
  const lateUploadSnapshot = await immediateDeletion.module.upsertPendingRecording(
    pendingRecording("meeting-delete-now", "file:///documents/ownminutes-recordings/meeting-delete-now.caf"),
  );
  assert.equal(lateUploadSnapshot.length, 0);
  assert.ok(immediateDeletion.state.records[0].localDeletionCompletedAt);

  const deferredDeletionUri = "file:///documents/ownminutes-recordings/meeting-delete-later.caf";
  const deferredDeletion = createRecordingStoreHarness(source, {
    records: [pendingRecording("meeting-delete-later", deferredDeletionUri)],
  });
  deferredDeletion.addFile(deferredDeletionUri, 64_000, 1_000);
  deferredDeletion.failDelete(deferredDeletionUri);
  const deferredDeletionResult = await deferredDeletion.module.deletePendingRecordingAfterRemoteDelete("meeting-delete-later");
  assert.equal(deferredDeletionResult.cleaned, false);
  assert.equal(deferredDeletionResult.pending, true);
  assert.equal(deferredDeletionResult.recordings.length, 0);
  assert.ok(deferredDeletion.state.records[0].localDeletionPendingAt);
  const lateUploadDuringPending = await deferredDeletion.module.upsertPendingRecording(
    pendingRecording("meeting-delete-later", deferredDeletionUri),
  );
  assert.equal(lateUploadDuringPending.length, 0);
  assert.ok(deferredDeletion.state.records[0].localDeletionPendingAt);
  assert.equal(deferredDeletion.state.records[0].localDeletionCompletedAt, undefined);
  const deferredRestartSnapshot = await deferredDeletion.module.loadPendingRecordings();
  assert.equal(deferredRestartSnapshot.recordings.length, 0);
  assert.equal(deferredRestartSnapshot.recordings.some((recording) => recording.localRecoveryOnly), false);
  deferredDeletion.clearDeleteFailure(deferredDeletionUri);
  const cleanupAfterRestart = await deferredDeletion.module.loadPendingRecordings();
  assert.equal(cleanupAfterRestart.recordings.length, 0);
  assert.equal(deferredDeletion.state.records.length, 1);
  assert.ok(deferredDeletion.state.records[0].localDeletionCompletedAt);
  assert.equal(cleanupAfterRestart.notice?.localCleanupCount, 1);

  const oldDeletionUri =
    "file:///var/mobile/Containers/Data/Application/OLD-CONTAINER/Documents/ownminutes-recordings/meeting-delete-upgraded.caf";
  const currentDeletionUri = "file:///documents/ownminutes-recordings/meeting-delete-upgraded.caf";
  const upgradedDeletion = createRecordingStoreHarness(source, {
    records: [{
      ...pendingRecording("meeting-delete-upgraded", oldDeletionUri),
      localDeletionPendingAt: "2026-07-17T10:00:00.000Z",
    }],
  });
  upgradedDeletion.addFile(currentDeletionUri, 64_000, 1_000);
  const upgradedDeletionSnapshot = await upgradedDeletion.module.loadPendingRecordings();
  assert.equal(upgradedDeletionSnapshot.recordings.length, 0);
  assert.equal(upgradedDeletion.fileSize(currentDeletionUri), undefined);

  const sharedUri = "file:///documents/ownminutes-recordings/shared-original.caf";
  const sharedCurrentFile = createRecordingStoreHarness(source, {
    records: [
      pendingRecording("meeting-shared-delete", sharedUri),
      pendingRecording("meeting-shared-survivor", sharedUri),
    ],
  });
  sharedCurrentFile.addFile(sharedUri, 64_000, Date.parse("2026-07-17T00:00:00.000Z") / 1000);
  const sharedDeleteResult = await sharedCurrentFile.module.deletePendingRecordingAfterRemoteDelete("meeting-shared-delete");
  assert.equal(sharedDeleteResult.pending, false);
  assert.equal(sharedCurrentFile.fileSize(sharedUri), 64_000);
  assert.equal(sharedDeleteResult.recordings.some((recording) => recording.meetingId === "meeting-shared-survivor"), true);

  const sharedRebasedUri = "file:///documents/ownminutes-recordings/meeting-shared-rebased.caf";
  const sharedRebasedFile = createRecordingStoreHarness(source, {
    records: [
      pendingRecording(
        "meeting-shared-rebased",
        "file:///old/Documents/ownminutes-recordings/meeting-shared-rebased.caf",
      ),
      pendingRecording("meeting-shared-current-owner", sharedRebasedUri),
    ],
  });
  sharedRebasedFile.addFile(sharedRebasedUri, 64_000, Date.parse("2026-07-17T00:00:00.000Z") / 1000);
  await sharedRebasedFile.module.deletePendingRecordingAfterRemoteDelete("meeting-shared-rebased");
  assert.equal(sharedRebasedFile.fileSize(sharedRebasedUri), 64_000);

  const journalProtectedUri = "file:///documents/ownminutes-recordings/meeting-journal-protected.caf";
  const journalProtectedRecord = pendingRecording("meeting-journal-protected", journalProtectedUri);
  const journalWriteFailure = createRecordingStoreHarness(source, {
    records: [journalProtectedRecord],
  });
  journalWriteFailure.addFile(journalProtectedUri, 64_000, 1_000);
  journalWriteFailure.failNextIndexWrite();
  await assert.rejects(
    journalWriteFailure.module.deletePendingRecordingAfterRemoteDelete("meeting-journal-protected", "user-a"),
    /injected index write failure/,
  );
  assert.equal(journalWriteFailure.state.records[0].localDeletionPendingAt, undefined);
  assert.match(
    [...journalWriteFailure.state.secure.values()].join("\n"),
    /meeting-journal-protected/,
  );

  const journalColdStart = createRecordingStoreHarness(source, {
    records: [journalProtectedRecord],
    secureEntries: [...journalWriteFailure.state.secure.entries()],
  });
  journalColdStart.addFile(journalProtectedUri, 64_000, 1_000);
  const journalColdStartSnapshot = await journalColdStart.module.loadPendingRecordings();
  assert.equal(journalColdStartSnapshot.recordings.length, 0);
  assert.equal(journalColdStart.fileSize(journalProtectedUri), undefined);
  assert.match([...journalColdStart.state.secure.values()].join("\n"), /completedAt/);

  const legacyAccountUri = "file:///documents/ownminutes-recordings/legacy-account-recording.caf";
  const userAUri = "file:///documents/ownminutes-recordings/user-a-recording.caf";
  const userBUri = "file:///documents/ownminutes-recordings/user-b-recording.caf";
  const legacyAccountRecord = {
    ...pendingRecording("legacy-account-recording", legacyAccountUri),
    userId: undefined,
  };
  const userARecord = { ...pendingRecording("user-a-recording", userAUri), userId: "user-a" };
  const userBRecord = { ...pendingRecording("user-b-recording", userBUri), userId: "user-b" };
  const accountJournalFailure = createRecordingStoreHarness(source, {
    records: [legacyAccountRecord, userARecord, userBRecord],
  });
  accountJournalFailure.addFile(legacyAccountUri, 64_000, 1_000);
  accountJournalFailure.addFile(userAUri, 64_000, 1_000);
  accountJournalFailure.addFile(userBUri, 64_000, 1_000);
  accountJournalFailure.failNextIndexWrite();
  await assert.rejects(
    accountJournalFailure.module.deleteLocalRecordingsForUser("user-a"),
    /injected index write failure/,
  );

  const accountColdStart = createRecordingStoreHarness(source, {
    records: [legacyAccountRecord, userARecord, userBRecord],
    secureEntries: [...accountJournalFailure.state.secure.entries()],
  });
  accountColdStart.addFile(legacyAccountUri, 64_000, 1_000);
  accountColdStart.addFile(userAUri, 64_000, 1_000);
  accountColdStart.addFile(userBUri, 64_000, 1_000);
  const accountColdStartSnapshot = await accountColdStart.module.loadPendingRecordings();
  assert.deepEqual(
    new Set(accountColdStartSnapshot.recordings.map((recording) => recording.meetingId)),
    new Set(["legacy-account-recording", "user-b-recording"]),
  );
  assert.equal(
    accountColdStartSnapshot.recordings.find((recording) => recording.meetingId === "legacy-account-recording")?.localRecoveryOnly,
    true,
  );
  assert.equal(accountColdStart.fileSize(legacyAccountUri), 64_000);
  assert.equal(accountColdStart.fileSize(userAUri), undefined);
  assert.equal(accountColdStart.fileSize(userBUri), 64_000);
  const crossAccountClaim = await accountColdStart.module.upsertPendingRecording({
    ...legacyAccountRecord,
    userId: "user-b",
  });
  assert.equal(crossAccountClaim.length, 2);
  assert.equal(
    crossAccountClaim.find((recording) => recording.meetingId === "legacy-account-recording")?.userId,
    undefined,
  );

  const ownerlessRemoteDelete = createRecordingStoreHarness(source, {
    records: [legacyAccountRecord],
  });
  ownerlessRemoteDelete.addFile(legacyAccountUri, 64_000, 1_000);
  const ownerlessRemoteDeleteResult = await ownerlessRemoteDelete.module.deletePendingRecordingAfterRemoteDelete(
    "legacy-account-recording",
    "user-a",
  );
  assert.equal(ownerlessRemoteDeleteResult.cleaned, false);
  assert.equal(ownerlessRemoteDeleteResult.pending, false);
  assert.equal(ownerlessRemoteDeleteResult.recordings[0].localRecoveryOnly, true);
  assert.equal(ownerlessRemoteDelete.fileSize(legacyAccountUri), 64_000);

  const ownerlessLocalDeleteRecord = { ...legacyAccountRecord, localRecoveryOnly: true };
  const ownerlessLocalDelete = createRecordingStoreHarness(source, {
    records: [ownerlessLocalDeleteRecord],
  });
  ownerlessLocalDelete.addFile(legacyAccountUri, 64_000, 1_000);
  const ownerlessLocalDeleteResult = await ownerlessLocalDelete.module.deleteLocalRecordingFromDevice({
    expectedUserId: null,
    meetingId: ownerlessLocalDeleteRecord.meetingId,
    uri: ownerlessLocalDeleteRecord.uri,
  });
  assert.equal(ownerlessLocalDeleteResult.cleaned, true);
  assert.equal(ownerlessLocalDeleteResult.pending, false);
  assert.equal(ownerlessLocalDeleteResult.recordings.length, 0);
  assert.equal(ownerlessLocalDelete.fileSize(legacyAccountUri), undefined);
  assert.ok(ownerlessLocalDelete.state.records[0].localDeletionCompletedAt);

  const ownedLocalDeleteUri = "file:///documents/ownminutes-recordings/owned-local-delete.caf";
  const ownedLocalDeleteRecord = pendingRecording("owned-local-delete", ownedLocalDeleteUri);
  const ownedLocalDelete = createRecordingStoreHarness(source, { records: [ownedLocalDeleteRecord] });
  ownedLocalDelete.addFile(ownedLocalDeleteUri, 64_000, 1_000);
  await assert.rejects(
    ownedLocalDelete.module.deleteLocalRecordingFromDevice({
      expectedUserId: "user-b",
      meetingId: ownedLocalDeleteRecord.meetingId,
      uri: ownedLocalDeleteRecord.uri,
    }),
    /本机录音已发生变化/,
  );
  await assert.rejects(
    ownedLocalDelete.module.deleteLocalRecordingFromDevice({
      expectedUserId: "user-a",
      meetingId: ownedLocalDeleteRecord.meetingId,
      uri: "file:///documents/ownminutes-recordings/stale-local-delete.caf",
    }),
    /本机录音已发生变化/,
  );
  assert.equal(ownedLocalDelete.fileSize(ownedLocalDeleteUri), 64_000);
  assert.equal(ownedLocalDelete.state.deleteCalls, 0);

  const localDeleteWriteFailure = createRecordingStoreHarness(source, { records: [ownedLocalDeleteRecord] });
  localDeleteWriteFailure.addFile(ownedLocalDeleteUri, 64_000, 1_000);
  localDeleteWriteFailure.failNextIndexWrite();
  await assert.rejects(
    localDeleteWriteFailure.module.deleteLocalRecordingFromDevice({
      expectedUserId: "user-a",
      meetingId: ownedLocalDeleteRecord.meetingId,
      uri: ownedLocalDeleteRecord.uri,
    }),
    /injected index write failure/,
  );
  assert.equal(localDeleteWriteFailure.fileSize(ownedLocalDeleteUri), 64_000);
  assert.equal(localDeleteWriteFailure.state.deleteCalls, 0);

  const deferredLocalDelete = createRecordingStoreHarness(source, { records: [ownedLocalDeleteRecord] });
  deferredLocalDelete.addFile(ownedLocalDeleteUri, 64_000, 1_000);
  deferredLocalDelete.failDelete(ownedLocalDeleteUri);
  const deferredLocalDeleteResult = await deferredLocalDelete.module.deleteLocalRecordingFromDevice({
    expectedUserId: "user-a",
    meetingId: ownedLocalDeleteRecord.meetingId,
    uri: ownedLocalDeleteRecord.uri,
  });
  assert.equal(deferredLocalDeleteResult.pending, true);
  assert.equal(deferredLocalDeleteResult.recordings.length, 0);
  assert.ok(deferredLocalDelete.state.records[0].localDeletionPendingAt);
  deferredLocalDelete.clearDeleteFailure(ownedLocalDeleteUri);
  const deferredLocalDeleteRestart = await deferredLocalDelete.module.loadPendingRecordings();
  assert.equal(deferredLocalDeleteRestart.recordings.length, 0);
  assert.equal(deferredLocalDelete.fileSize(ownedLocalDeleteUri), undefined);
  assert.ok(deferredLocalDelete.state.records[0].localDeletionCompletedAt);

  const accountJournalOrphanUri = "file:///documents/recording-account-deleted.caf";
  const accountOrphanColdStart = createRecordingStoreHarness(source, {
    records: [],
    secureEntries: [...accountJournalFailure.state.secure.entries()],
  });
  accountOrphanColdStart.addFile(accountJournalOrphanUri, 64_000, 1_000);
  const accountOrphanSnapshot = await accountOrphanColdStart.module.loadPendingRecordings();
  assert.equal(accountOrphanSnapshot.recordings.length, 1);
  assert.equal(accountOrphanSnapshot.recordings[0].localRecoveryOnly, true);
  assert.equal(accountOrphanColdStart.fileSize(accountJournalOrphanUri), 64_000);
  assert.match([...accountOrphanColdStart.state.secure.values()].join("\n"), /completedAt/);

  const unrecoverableAccountOrphan = createRecordingStoreHarness(source, {
    indexSource: "unrecoverable",
    records: [],
    secureEntries: [...accountJournalFailure.state.secure.entries()],
  });
  unrecoverableAccountOrphan.addFile(accountJournalOrphanUri, 64_000, 1_000);
  const unrecoverableAccountOrphanSnapshot = await unrecoverableAccountOrphan.module.loadPendingRecordings();
  assert.equal(unrecoverableAccountOrphanSnapshot.recordings.length, 1);
  assert.equal(unrecoverableAccountOrphanSnapshot.recordings[0].localRecoveryOnly, true);
  assert.equal(unrecoverableAccountOrphan.fileSize(accountJournalOrphanUri), 64_000);
  assert.doesNotMatch([...unrecoverableAccountOrphan.state.secure.values()].join("\n"), /completedAt/);
  assert.equal(issueCount(unrecoverableAccountOrphanSnapshot, "index_unrecoverable"), 1);

  const managedOrphanUri = "file:///documents/ownminutes-recordings/managed-orphan-after-corrupt-index.m4a";
  const unrecoverableManagedOrphan = createRecordingStoreHarness(source, {
    indexSource: "unrecoverable",
    records: [],
  });
  unrecoverableManagedOrphan.addFile(managedOrphanUri, 96_000, 1_100);
  const unrecoverableManagedSnapshot = await unrecoverableManagedOrphan.module.loadPendingRecordings();
  assert.equal(unrecoverableManagedSnapshot.recordings.length, 1);
  assert.equal(unrecoverableManagedSnapshot.recordings[0].uri, managedOrphanUri);
  assert.equal(unrecoverableManagedSnapshot.recordings[0].localRecoveryOnly, true);
  assert.equal(unrecoverableManagedSnapshot.recordings[0].activeRecording, true);
  assert.equal(unrecoverableManagedOrphan.fileSize(managedOrphanUri), 96_000);
  assert.equal(issueCount(unrecoverableManagedSnapshot, "index_unrecoverable"), 1);
  const managedRecoveryHubEntries = selectDeviceLegacyRecoveryRecordings(unrecoverableManagedSnapshot.recordings);
  assert.equal(managedRecoveryHubEntries.length, 1);
  assert.equal(managedRecoveryHubEntries[0].uri, managedOrphanUri);

  // This journal is written before live upload starts. Simulate a force quit
  // after live chunks were already sent but before expo-audio exposed a URI or
  // the normal recording index could be written.
  const realtimeJournalKey = "ownminutes_realtime_session_journal_v1";
  const realtimeJournalQuarantineKey = "ownminutes_realtime_session_journal_quarantined_v1";
  const formalRecordingUri =
    "file:///documents/ownminutes-recordings/meeting-formal-survives-corrupt-journal.caf";
  const corruptRealtimeJournal = createRecordingStoreHarness(source, {
    records: [{
      ...pendingRecording("meeting-formal-survives-corrupt-journal", formalRecordingUri),
      activeRecording: false,
      processingMode: "official_quota",
    }],
    secureEntries: [[realtimeJournalKey, "{\"entries\":"]],
  });
  corruptRealtimeJournal.addFile(formalRecordingUri, 256_000, 1_200);
  const corruptRealtimeJournalSnapshot =
    await corruptRealtimeJournal.module.loadPendingRecordings();
  assert.equal(corruptRealtimeJournalSnapshot.recordings.length, 1);
  assert.equal(
    corruptRealtimeJournalSnapshot.recordings[0].meetingId,
    "meeting-formal-survives-corrupt-journal",
  );
  assert.equal(corruptRealtimeJournalSnapshot.recordings[0].uri, formalRecordingUri);
  assert.equal(corruptRealtimeJournalSnapshot.recordings[0].processingMode, "official_quota");
  assert.notEqual(corruptRealtimeJournalSnapshot.recordings[0].localRecoveryOnly, true);
  assert.equal(issueCount(corruptRealtimeJournalSnapshot, "realtime_journal_unrecoverable"), 1);
  assert.equal(corruptRealtimeJournal.state.secure.has(realtimeJournalKey), false);
  assert.match(
    corruptRealtimeJournal.state.secure.get(realtimeJournalQuarantineKey) ?? "",
    /invalid_realtime_session_journal/,
  );
  assert.equal(corruptRealtimeJournal.fileSize(formalRecordingUri), 256_000);
  await corruptRealtimeJournal.module.preparePendingRealtimeSession(
    pendingRealtimeSession("meeting-after-corrupt-journal", "user-a"),
  );
  assert.equal(corruptRealtimeJournal.state.secure.has(realtimeJournalQuarantineKey), false);
  assert.match(
    corruptRealtimeJournal.state.secure.get(realtimeJournalKey) ?? "",
    /meeting-after-corrupt-journal/,
  );

  const realtimeStartedAt = Date.parse("2026-07-17T14:00:00.000Z");
  const realtimeOrphanUri = "file:///documents/ExpoAudio/recording-realtime-uri-delayed.caf";
  const realtimeJournalRecovery = createRecordingStoreHarness(source, {
    records: [],
    secureEntries: [[
      realtimeJournalKey,
      JSON.stringify({
        entries: [{
          consentConfirmedAt: "2026-07-17T13:59:58.000Z",
          consentMethod: "in_app_confirmation",
          consentPolicyVersion: "2026-07-30",
          createdAt: new Date(realtimeStartedAt).toISOString(),
          meetingId: "meeting-realtime-uri-delayed",
          processingMode: "official_quota",
          realtimeClosePendingAt: new Date(realtimeStartedAt + 5_000).toISOString(),
          title: "Realtime force quit recovery",
          updatedAt: new Date(realtimeStartedAt + 60_000).toISOString(),
          userId: "user-a",
        }],
        version: 1,
      }),
    ]],
  });
  realtimeJournalRecovery.addFile(
    realtimeOrphanUri,
    1_200_000,
    (realtimeStartedAt + 30 * 60_000) / 1000,
  );
  const realtimeJournalSnapshot = await realtimeJournalRecovery.module.loadPendingRecordings();
  assert.equal(realtimeJournalSnapshot.recordings.length, 1);
  assert.equal(realtimeJournalSnapshot.recordings[0].meetingId, "meeting-realtime-uri-delayed");
  assert.equal(realtimeJournalSnapshot.recordings[0].uri, realtimeOrphanUri);
  assert.equal(realtimeJournalSnapshot.recordings[0].userId, "user-a");
  assert.equal(realtimeJournalSnapshot.recordings[0].processingMode, "official_quota");
  assert.equal(realtimeJournalSnapshot.recordings[0].consentConfirmedAt, "2026-07-17T13:59:58.000Z");
  assert.equal(realtimeJournalSnapshot.recordings[0].consentMethod, "in_app_confirmation");
  assert.equal(realtimeJournalSnapshot.recordings[0].consentPolicyVersion, "2026-07-30");
  assert.equal(
    realtimeJournalSnapshot.recordings[0].realtimeClosePendingAt,
    new Date(realtimeStartedAt + 5_000).toISOString(),
  );
  assert.equal(realtimeJournalSnapshot.recordings[0].localRecoveryOnly, undefined);
  assert.match(realtimeJournalRecovery.state.secure.get(realtimeJournalKey) ?? "", /recording-realtime-uri-delayed\.caf/);
  await realtimeJournalRecovery.module.completePendingRealtimeSession("meeting-realtime-uri-delayed");
  assert.equal(realtimeJournalRecovery.state.secure.has(realtimeJournalKey), false);

  const remoteDeleteRealtimeUri =
    "file:///documents/ownminutes-recordings/meeting-realtime-remote-delete.caf";
  const remoteDeleteRealtime = createRecordingStoreHarness(source, {
    records: [pendingRecording("meeting-realtime-remote-delete", remoteDeleteRealtimeUri)],
  });
  remoteDeleteRealtime.addFile(remoteDeleteRealtimeUri, 64_000, 1_000);
  await remoteDeleteRealtime.module.preparePendingRealtimeSession(
    pendingRealtimeSession("meeting-realtime-remote-delete", "user-a"),
  );
  await remoteDeleteRealtime.module.deletePendingRecordingAfterRemoteDelete(
    "meeting-realtime-remote-delete",
    "user-a",
  );
  assert.doesNotMatch(
    remoteDeleteRealtime.state.secure.get(realtimeJournalKey) ?? "",
    /meeting-realtime-remote-delete/,
  );

  const localDeleteRealtimeUri =
    "file:///documents/ownminutes-recordings/meeting-realtime-local-delete.caf";
  const localDeleteRealtimeRecord = pendingRecording(
    "meeting-realtime-local-delete",
    localDeleteRealtimeUri,
  );
  const localDeleteRealtime = createRecordingStoreHarness(source, {
    records: [localDeleteRealtimeRecord],
  });
  localDeleteRealtime.addFile(localDeleteRealtimeUri, 64_000, 1_000);
  await localDeleteRealtime.module.preparePendingRealtimeSession(
    pendingRealtimeSession("meeting-realtime-local-delete", "user-a"),
  );
  await localDeleteRealtime.module.deleteLocalRecordingFromDevice({
    expectedUserId: "user-a",
    meetingId: localDeleteRealtimeRecord.meetingId,
    uri: localDeleteRealtimeRecord.uri,
  });
  assert.doesNotMatch(
    localDeleteRealtime.state.secure.get(realtimeJournalKey) ?? "",
    /meeting-realtime-local-delete/,
  );

  const accountDeleteRealtimeAUri =
    "file:///documents/ownminutes-recordings/meeting-realtime-account-a.caf";
  const accountDeleteRealtimeBUri =
    "file:///documents/ownminutes-recordings/meeting-realtime-account-b.caf";
  const accountDeleteRealtime = createRecordingStoreHarness(source, {
    records: [
      pendingRecording("meeting-realtime-account-a", accountDeleteRealtimeAUri),
      {
        ...pendingRecording("meeting-realtime-account-b", accountDeleteRealtimeBUri),
        userId: "user-b",
      },
    ],
  });
  accountDeleteRealtime.addFile(accountDeleteRealtimeAUri, 64_000, 1_000);
  accountDeleteRealtime.addFile(accountDeleteRealtimeBUri, 64_000, 1_000);
  await accountDeleteRealtime.module.preparePendingRealtimeSession(
    pendingRealtimeSession("meeting-realtime-account-a", "user-a"),
  );
  await accountDeleteRealtime.module.preparePendingRealtimeSession(
    pendingRealtimeSession("meeting-realtime-account-b", "user-b"),
  );
  await accountDeleteRealtime.module.deleteLocalRecordingsForUser("user-a");
  assert.doesNotMatch(
    accountDeleteRealtime.state.secure.get(realtimeJournalKey) ?? "",
    /meeting-realtime-account-a/,
  );
  assert.match(
    accountDeleteRealtime.state.secure.get(realtimeJournalKey) ?? "",
    /meeting-realtime-account-b/,
  );

  const staleRealtimeTombstone = {
    ...pendingRecording(
      "meeting-realtime-stale-tombstone",
      "file:///documents/ownminutes-recordings/meeting-realtime-stale-tombstone.caf",
    ),
    localDeletionPendingAt: "2026-07-17T15:00:00.000Z",
  };
  const staleRealtimeJournalRecovery = createRecordingStoreHarness(source, {
    records: [staleRealtimeTombstone],
    secureEntries: [[
      realtimeJournalKey,
      JSON.stringify({
        entries: [pendingRealtimeSession("meeting-realtime-stale-tombstone", "user-a")],
        version: 1,
      }),
    ]],
  });
  const staleRealtimeSnapshot = await staleRealtimeJournalRecovery.module.loadPendingRecordings();
  assert.equal(staleRealtimeSnapshot.recordings.length, 0);
  assert.doesNotMatch(
    staleRealtimeJournalRecovery.state.secure.get(realtimeJournalKey) ?? "",
    /meeting-realtime-stale-tombstone/,
  );

  return {
    migratesExactlyFiveOldContainerIndexesWithoutDeleting:
      fiveOldContainerSnapshot.recordings.length === 5 && fiveOldContainer.state.deleteCalls === 0,
    commitsRelocatedIndexesBeforeLaterRecoveryWork: fiveOldContainer.state.writeCount === 2,
    exactFiveHungProbesStayWithinLaunchBudget:
      fiveHungElapsedMs < 7_500 && fiveHungSnapshot.recordings.length === 5,
    safelyRelocatesManagedUriAfterContainerChange:
      upgradedSnapshot.recordings[0].uri === currentManagedUri &&
      upgradedContainer.state.deleteCalls === 0,
    safelyRelocatesExpoAudioUriAfterContainerChange:
      upgradedExpoSnapshot.recordings[0].uri === currentExpoAudioUri &&
      upgradedExpoAudio.state.deleteCalls === 0,
    neverRelocatesWhenOriginalUriExists:
      originalStillAvailableSnapshot.recordings[0].uri === oldManagedUri,
    neverRelocatesOnTransientSourceProbeError:
      originalProbeUnavailableSnapshot.recordings[0].uri === oldManagedUri,
    neverRelocatesToAnotherMeetingOwnedDestination:
      destinationAlreadyOwnedSnapshot.recordings.some(
        (recording) => recording.meetingId === "meeting-owned" && recording.uri.includes("OLD-CONTAINER"),
      ),
    neverRelocatesDuplicateDestinationCandidates:
      duplicateDestinationSnapshot.recordings
        .filter((recording) => recording.meetingId.startsWith("meeting-duplicate"))
        .every((recording) => recording.uri.includes("file:///old-")),
    neverRelocatesManagedFilenameForDifferentMeeting:
      mismatchedManagedNameSnapshot.recordings[0].uri.includes("file:///old/"),
    neverRelocatesStaleExpoAudioByBasenameAlone:
      staleExpoTimestampSnapshot.recordings[0].uri === oldExpoAudioUri,
    rejectsNestedOrUnmanagedRelocation:
      unmanagedTraversalSnapshot.recordings[0].uri.includes("/nested/"),
    refusesPhysicalDeleteOutsideControlledRecordingPaths:
      unmanagedTraversal.state.deleteCalls === 0 &&
      unmanagedTraversal.fileSize("file:///documents/ownminutes-recordings/recording-unsafe.m4a") === 80_000,
    keepsLargerDestinationWithoutDeletingSource: retainedUri.endsWith("meeting-small.caf"),
    keepsMissingIndexEntry: missingSnapshot.recordings.length === 1,
    keepsTemporarilyUnavailableIndexEntry: unavailableSnapshot.recordings.length === 1,
    matchesLargerOrphanToSmallIndex:
      matchedSnapshot.recordings[0].uri === "file:///documents/ExpoAudio/recording-interrupted.caf",
    preservesBothFilesOnConflict: matched.state.deleteCalls === 0,
    neverAssociatesOrphanToNonActiveMissingMeeting:
      completedMissingRecord?.uri.endsWith("meeting-completed-missing.caf") &&
      Boolean(quarantinedUnrelated?.localRecoveryOnly),
    quarantinesAmbiguousCandidateMatches:
      ambiguousSnapshot.recordings.filter((recording) => recording.localRecoveryOnly).length === 1,
    quarantinesMultipleOrphanChoices:
      multipleOrphansSnapshot.recordings.filter((recording) => recording.localRecoveryOnly).length === 2,
    quarantinesUnmatchedOrphan: Boolean(isolatedRecord?.localRecoveryOnly && isolatedRecord.activeRecording),
    isolatedRecoveryCannotAutoRelease: attemptedRelease.some(
      (recording) => recording.meetingId === isolatedRecord.meetingId && recording.activeRecording,
    ),
    avoidsDuplicateOrphanImport: duplicateScan.recordings.length === 2,
    durableDeleteFencePrecedesFileCleanup:
      deferredDeletionResult.pending === true && Boolean(deferredDeletion.state.records[0].localDeletionPendingAt),
    lateUploadCannotResurrectDeletedRecording:
      lateUploadSnapshot.length === 0 && Boolean(immediateDeletion.state.records[0].localDeletionCompletedAt),
    pendingDeletionCannotBecomeOrphanRecovery:
      deferredRestartSnapshot.recordings.length === 0,
    startupRetriesDeferredLocalDeletion: cleanupAfterRestart.recordings.length === 0,
    startupDeletionRebasesOldContainerUri:
      upgradedDeletionSnapshot.recordings.length === 0 && upgradedDeletion.fileSize(currentDeletionUri) === undefined,
    neverDeletesAnotherMeetingSharedOriginal:
      sharedCurrentFile.fileSize(sharedUri) === 64_000,
    neverDeletesAnotherMeetingRebasedOriginal:
      sharedRebasedFile.fileSize(sharedRebasedUri) === 64_000,
    successfulLocalDeletionHidesIndexAndRetainsFence:
      immediateDeletionResult.recordings.length === 0 && immediateDeletion.state.records.length === 1,
    secureJournalSurvivesFirstIndexWriteFailure:
      journalColdStartSnapshot.recordings.length === 0 && journalColdStart.fileSize(journalProtectedUri) === undefined,
    accountDeletionPreservesOwnerlessLegacyRecovery:
      accountColdStartSnapshot.recordings.length === 2 && accountColdStart.fileSize(legacyAccountUri) === 64_000,
    ownerlessLegacyCannotBeClaimedByAnotherSession:
      crossAccountClaim.length === 2 &&
      !crossAccountClaim.find((recording) => recording.meetingId === "legacy-account-recording")?.userId,
    authenticatedMeetingDeleteCannotDeleteOwnerlessAudio:
      ownerlessRemoteDeleteResult.recordings[0]?.localRecoveryOnly === true &&
      ownerlessRemoteDelete.fileSize(legacyAccountUri) === 64_000,
    explicitOwnerlessLocalDeleteRemovesOnlyTheSelectedDeviceRecording:
      ownerlessLocalDeleteResult.recordings.length === 0 && ownerlessLocalDelete.fileSize(legacyAccountUri) === undefined,
    localDeleteRejectsStaleOrCrossAccountUiState:
      ownedLocalDelete.fileSize(ownedLocalDeleteUri) === 64_000 && ownedLocalDelete.state.deleteCalls === 0,
    localDeletePersistsFenceBeforePhysicalRemoval:
      localDeleteWriteFailure.fileSize(ownedLocalDeleteUri) === 64_000 && localDeleteWriteFailure.state.deleteCalls === 0,
    localDeleteRetriesPhysicalCleanupAfterRestart:
      deferredLocalDeleteRestart.recordings.length === 0 && deferredLocalDelete.fileSize(ownedLocalDeleteUri) === undefined,
    accountJournalDoesNotDeleteOwnerlessOrphan:
      accountOrphanSnapshot.recordings.length === 1 && accountOrphanColdStart.fileSize(accountJournalOrphanUri) === 64_000,
    unrecoverableIndexKeepsOwnerlessRecoveryVisible:
      unrecoverableAccountOrphanSnapshot.recordings.length === 1 &&
      unrecoverableAccountOrphan.fileSize(accountJournalOrphanUri) === 64_000,
    corruptIndexScansManagedRecordingDirectory:
      unrecoverableManagedSnapshot.recordings[0]?.uri === managedOrphanUri &&
      unrecoverableManagedOrphan.fileSize(managedOrphanUri) === 96_000,
    managedOrphanReachesBrowsePlayExportRecoveryUi:
      managedRecoveryHubEntries[0]?.uri === managedOrphanUri,
    recoversRealtimeAfterLongNullUriAndForceQuit:
      realtimeJournalSnapshot.recordings[0]?.meetingId === "meeting-realtime-uri-delayed" &&
      realtimeJournalSnapshot.recordings[0]?.uri === realtimeOrphanUri,
    deletedMeetingsCannotBeResurrectedByRealtimeJournal:
      !remoteDeleteRealtime.state.secure.has(realtimeJournalKey) &&
      !localDeleteRealtime.state.secure.has(realtimeJournalKey) &&
      staleRealtimeSnapshot.recordings.length === 0,
    accountDeletePrunesOnlyOwnedRealtimeJournal:
      !(accountDeleteRealtime.state.secure.get(realtimeJournalKey) ?? "").includes("meeting-realtime-account-a") &&
      (accountDeleteRealtime.state.secure.get(realtimeJournalKey) ?? "").includes("meeting-realtime-account-b"),
    preservesMinimalMeetingConsentWithoutParticipantIdentity:
      realtimeJournalSnapshot.recordings[0]?.consentMethod === "in_app_confirmation" &&
      missingSnapshot.recordings[0]?.consentMethod === "legacy_unknown",
    corruptRealtimeJournalCannotHideFormalRecording:
      corruptRealtimeJournalSnapshot.recordings[0]?.uri === formalRecordingUri &&
      corruptRealtimeJournal.fileSize(formalRecordingUri) === 256_000,
    corruptRealtimeJournalIsQuarantinedWithoutDisablingFutureRecording:
      issueCount(corruptRealtimeJournalSnapshot, "realtime_journal_unrecoverable") === 1 &&
      !(corruptRealtimeJournal.state.secure.get(realtimeJournalKey) ?? "").includes(
        "meeting-formal-survives-corrupt-journal",
      ),
  };
}

function issueCount(snapshot, kind) {
  return snapshot.issues?.find((issue) => issue.kind === kind)?.count ?? 0;
}

function pendingRecording(meetingId, uri, timestamp = Date.parse("2026-07-17T00:00:00.000Z")) {
  const createdAt = new Date(timestamp).toISOString();
  return {
    createdAt,
    meetingId,
    updatedAt: createdAt,
    userId: "user-a",
    uri,
  };
}

function pendingRealtimeSession(meetingId, userId) {
  const createdAt = "2026-07-17T14:00:00.000Z";
  return {
    createdAt,
    meetingId,
    processingMode: "official_quota",
    realtimeClosePendingAt: "2026-07-17T14:00:05.000Z",
    title: meetingId,
    updatedAt: "2026-07-17T14:01:00.000Z",
    userId,
  };
}

function createRecordingStoreHarness(source, options = {}) {
  const documentDirectory = "file:///documents/";
  const state = {
    deleteCalls: 0,
    files: new Map(),
    indexSource: options.indexSource ?? "primary",
    records: structuredClone(options.records ?? []),
    secure: new Map(options.secureEntries ?? []),
    unavailableIndexWrites: 0,
    unavailableDelete: new Set(),
    unavailableInfo: new Set(),
    hangingInfo: new Set(),
    writeCount: 0,
  };
  const fileSystem = {
    documentDirectory,
    async copyAsync({ from, to }) {
      if (!state.files.has(from)) throw new Error(`missing source: ${from}`);
      if (state.files.has(to)) throw new Error(`destination exists: ${to}`);
      state.files.set(to, { ...state.files.get(from) });
    },
    async deleteAsync(uri) {
      state.deleteCalls += 1;
      if (state.unavailableDelete.has(uri)) throw new Error(`temporarily undeletable: ${uri}`);
      state.files.delete(uri);
    },
    async getInfoAsync(uri) {
      if (state.hangingInfo.has(uri)) return new Promise(() => {});
      if (state.unavailableInfo.has(uri)) throw new Error(`temporarily unavailable: ${uri}`);
      const file = state.files.get(uri);
      if (!file) return { exists: false, isDirectory: false, uri };
      return {
        exists: true,
        isDirectory: false,
        modificationTime: file.modificationTime,
        size: file.size,
        uri,
      };
    },
    async makeDirectoryAsync() {},
    async moveAsync({ from, to }) {
      if (!state.files.has(from)) throw new Error(`missing source: ${from}`);
      if (state.files.has(to)) throw new Error(`destination exists: ${to}`);
      state.files.set(to, state.files.get(from));
      state.files.delete(from);
    },
    async readAsStringAsync() {
      throw new Error("unexpected direct index read");
    },
    async readDirectoryAsync(uri) {
      return [...state.files.keys()]
        .filter((path) => path.startsWith(uri))
        .map((path) => path.slice(uri.length))
        .filter((name) => name && !name.includes("/"));
    },
    async writeAsStringAsync() {
      throw new Error("unexpected direct index write");
    },
  };
  const secureStore = {
    async deleteItemAsync(key) {
      state.secure.delete(key);
    },
    async getItemAsync(key) {
      return state.secure.get(key) ?? null;
    },
    async setItemAsync(key, value) {
      state.secure.set(key, value);
    },
  };
  const atomicIndex = {
    createSerialExecutor,
    async readAtomicArrayIndex() {
      return {
        records: structuredClone(state.records),
        source: state.indexSource,
      };
    },
    async writeAtomicArrayIndex(_store, _paths, records) {
      if (state.unavailableIndexWrites > 0) {
        state.unavailableIndexWrites -= 1;
        throw new Error("injected index write failure");
      }
      state.records = structuredClone(records);
      state.writeCount += 1;
    },
  };
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
    fileName: "recording-store.ts",
  }).outputText;
  const commonJsModule = { exports: {} };
  const localRequire = (specifier) => {
    if (specifier === "expo-file-system/legacy") return fileSystem;
    if (specifier === "expo-secure-store") return secureStore;
    if (specifier === "./atomic-recording-index") return atomicIndex;
    if (specifier === "./recording-store-timeout") {
      return { withRecordingStoreTimeout };
    }
    throw new Error(`unexpected module import: ${specifier}`);
  };
  Function("require", "module", "exports", output)(localRequire, commonJsModule, commonJsModule.exports);
  return {
    addFile(uri, size, modificationTime = 1_000) {
      state.files.set(uri, { modificationTime, size });
    },
    fileSize(uri) {
      return state.files.get(uri)?.size;
    },
    failInfo(uri) {
      state.unavailableInfo.add(uri);
    },
    hangInfo(uri) {
      state.hangingInfo.add(uri);
    },
    failDelete(uri) {
      state.unavailableDelete.add(uri);
    },
    failNextIndexWrite() {
      state.unavailableIndexWrites += 1;
    },
    clearDeleteFailure(uri) {
      state.unavailableDelete.delete(uri);
    },
    module: commonJsModule.exports,
    state,
  };
}

function createMemoryStore() {
  const files = new Map();
  return {
    files,
    failMoveDestination: null,
    async copy(from, to) {
      if (!files.has(from)) throw new Error(`missing source: ${from}`);
      files.set(to, files.get(from));
    },
    async exists(path) {
      return files.has(path);
    },
    async move(from, to) {
      if (!files.has(from)) throw new Error(`missing source: ${from}`);
      if (this.failMoveDestination === to) {
        this.failMoveDestination = null;
        throw new Error("injected move failure");
      }
      files.set(to, files.get(from));
      files.delete(from);
    },
    async read(path) {
      if (!files.has(path)) throw new Error(`missing file: ${path}`);
      return files.get(path);
    },
    async remove(path) {
      files.delete(path);
    },
    async write(path, contents) {
      files.set(path, contents);
    },
  };
}
