#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  mergeDeferredSyncOptions,
  pendingRetryDelayMs,
  selectPendingSyncTargets,
  shouldDrainDeferredSync,
} from "../apps/mobile/src/pending-sync.ts";
import {
  selectAccountLocalRecordings,
  selectDeviceLegacyRecoveryRecordings,
} from "../apps/mobile/src/local-recording-privacy.ts";

const now = Date.parse("2026-07-11T04:00:00.000Z");
const recordings = [
  pending("newest", "2026-07-11T03:00:00.000Z", { userId: "user-a" }),
  pending("other-user", "2026-07-11T00:00:00.000Z", { userId: "user-b" }),
  pending("waiting", "2026-07-11T02:00:00.000Z", {
    nextRetryAt: "2026-07-11T04:05:00.000Z",
    userId: "user-a",
  }),
  pending("completed", "2026-07-11T00:30:00.000Z", {
    finalizedAt: "2026-07-11T00:45:00.000Z",
    userId: "user-a",
  }),
  pending("oldest", "2026-07-11T01:00:00.000Z", { userId: "user-a" }),
  pending("ownerless-legacy", "2026-07-10T23:30:00.000Z"),
  pending("ownerless-recovery", "2026-07-10T23:45:00.000Z", { localRecoveryOnly: true }),
  pending("owned-quarantine", "2026-07-10T23:50:00.000Z", {
    localRecoveryOnly: true,
    userId: "user-a",
  }),
  pending("interrupted", "2026-07-11T00:15:00.000Z", {
    activeRecording: true,
    userId: "user-a",
  }),
  pending("deleted-remotely", "2026-07-11T00:10:00.000Z", {
    localDeletionPendingAt: "2026-07-11T03:30:00.000Z",
    userId: "user-a",
  }),
];

assert.deepEqual(
  selectPendingSyncTargets(recordings, { now, userId: "user-a" }).map((item) => item.meetingId),
  ["oldest", "newest"],
  "normal sync should filter by owner, honor backoff, and process oldest first",
);

assert.deepEqual(
  selectAccountLocalRecordings(recordings, "user-a").map((item) => item.meetingId),
  ["newest", "waiting", "completed", "oldest", "interrupted"],
  "account A must not see account B, ownerless, or quarantined recovery records as its own",
);
assert.deepEqual(
  selectAccountLocalRecordings(recordings, "user-b").map((item) => item.meetingId),
  ["other-user"],
  "switching accounts must expose only the newly authenticated owner's records",
);
assert.deepEqual(selectAccountLocalRecordings(recordings, undefined), [], "sign-out must expose no account recordings");
assert.deepEqual(
  selectDeviceLegacyRecoveryRecordings(recordings).map((item) => item.meetingId),
  ["ownerless-recovery"],
  "only explicitly quarantined ownerless audio belongs in device legacy recovery",
);

for (const meetingId of ["ownerless-legacy", "ownerless-recovery", "owned-quarantine"]) {
  assert.deepEqual(
    selectPendingSyncTargets(recordings, {
      force: true,
      now,
      onlyMeetingId: meetingId,
      userId: "user-a",
    }),
    [],
    `${meetingId} must not upload even through a forced per-meeting retry`,
  );
}

const appSource = readFileSync("apps/mobile/App.tsx", "utf8");
const apiSource = readFileSync("apps/mobile/src/api.ts", "utf8");
const recordingStoreSource = readFileSync("apps/mobile/src/recording-store.ts", "utf8");
const syncStart = appSource.indexOf("async function syncPendingRecordings(");
const syncEnd = appSource.indexOf("async function retryUpload()", syncStart);
const syncSource = appSource.slice(syncStart, syncEnd);
const resetStart = appSource.indexOf("async function resetMeeting()");
const resetEnd = appSource.indexOf("async function handleMediaServicesReset()", resetStart);
const resetSource = appSource.slice(resetStart, resetEnd);
const startStart = appSource.indexOf("async function doStartRecording(");
const startEnd = appSource.indexOf("async function pauseRecording()", startStart);
const startSource = appSource.slice(startStart, startEnd);
const retryStart = appSource.indexOf("async function retryUpload(");
const retryEnd = appSource.indexOf("async function retrySelectedMeetingFinalization()", retryStart);
const retrySource = appSource.slice(retryStart, retryEnd);
assert.ok(recordingStoreSource.includes("recordingUploadId?: string"));
assert.ok(recordingStoreSource.includes("recordingUploadedParts?: number"));
assert.ok(recordingStoreSource.includes("recordingRecordedAt?: number"));
assert.ok(recordingStoreSource.includes("localDeletionPendingAt?: string"));
assert.ok(recordingStoreSource.includes("realtimeClosePendingAt?: string"));
assert.ok(recordingStoreSource.includes("deletePendingRecordingAfterRemoteDelete"));
assert.ok(appSource.includes("await persistPendingRecording(working)"));
assert.ok(appSource.includes("recordingRecordedAt"));
assert.ok(appSource.includes('t("runtime.syncParts", { uploaded: uploadedParts, total: totalParts })'));
assert.ok(apiSource.includes("fetchRecordingUploadStatus"));
assert.ok(apiSource.includes("if (receivedParts.has(partIndex)) continue"));
assert.deepEqual(
  mergeDeferredSyncOptions(null, { force: true, onlyMeetingId: "meeting-a", showActiveResult: true }),
  { force: true, onlyMeetingId: "meeting-a", showActiveResult: true },
  "the first deferred manual retry should retain its complete semantics",
);
assert.deepEqual(
  mergeDeferredSyncOptions(
    { force: true, onlyMeetingId: "meeting-a", showActiveResult: true },
    {},
  ),
  { force: true, onlyMeetingId: "meeting-a", showActiveResult: true },
  "a generic auto-sync wake must not weaken an explicit retry",
);
assert.deepEqual(
  mergeDeferredSyncOptions(
    { force: true, onlyMeetingId: "meeting-a", showActiveResult: true },
    { force: true, onlyMeetingId: "meeting-b", showActiveResult: true },
  ),
  { force: true },
  "two different explicit retries should broaden to a forced scan instead of dropping either target",
);
assert.equal(
  shouldDrainDeferredSync({
    hasDeferredOptions: true,
    recordingLifecycleBusy: true,
    syncInFlight: false,
    uploadInFlight: false,
  }),
  false,
  "deferred work must not run while the durable recorder owns the lifecycle",
);
assert.equal(
  shouldDrainDeferredSync({
    hasDeferredOptions: true,
    recordingLifecycleBusy: false,
    syncInFlight: false,
    uploadInFlight: false,
  }),
  true,
  "deferred work must wake immediately after recording leaves the busy lifecycle",
);
assert.equal(
  shouldDrainDeferredSync({
    hasDeferredOptions: true,
    recordingLifecycleBusy: false,
    syncInFlight: true,
    uploadInFlight: true,
  }),
  false,
  "an existing sync must remain the only queue owner",
);
assert.ok(syncSource.includes("deferredSyncOptionsRef.current = mergeDeferredSyncOptions"));
assert.ok(syncSource.includes("return { deferred: true, failed: 0, succeeded: 0 }"));
assert.ok(syncSource.includes("recordingLifecycleBusyRef.current && !explicitCurrentMeetingRetry"));
assert.ok(syncSource.includes("autoSyncRequestRef.current()"));
assert.ok(syncSource.includes("targetMeetingId === currentMeetingIdRef.current"));
assert.ok(syncSource.includes("isCurrentSyncSession()"));
assert.ok(syncSource.includes("working.meetingId === currentMeetingIdRef.current"));
assert.ok(syncSource.includes("options.showActiveResult === true"));
assert.ok(
  (syncSource.match(/isCurrentSyncSession\(\)\s*&&\s*options\.showActiveResult/g) ?? []).length >= 3,
  "duration, transcript, and final output writes must all verify the originating session generation",
);
assert.ok(syncSource.includes("fetchMeetings(apiBaseUrl, syncCookie)"));
assert.ok(syncSource.includes("fetchAccountUsage(apiBaseUrl, syncCookie)"));
assert.ok(syncSource.includes("const [meetingListResult, accountUsageResult] = await Promise.allSettled"));
assert.ok(
  syncSource.indexOf("if (isCurrentSyncSession()) {", syncSource.indexOf("Promise.allSettled")) >
    syncSource.indexOf("Promise.allSettled"),
  "account and meeting refresh results must re-check the session generation after both requests settle",
);
assert.ok(resetSource.includes("setAutoSyncMessage(null)"));
assert.ok(startSource.includes("setAutoSyncMessage(null)"));
assert.ok(appSource.includes("selectAccountLocalRecordings(pendingRecordings, currentUser?.id)"));
assert.ok(appSource.includes("selectDeviceLegacyRecoveryRecordings(pendingRecordings)"));
assert.ok(appSource.includes("selectAccountLocalRecordings(recordings, userId)"));

assert.deepEqual(
  selectPendingSyncTargets(recordings, { force: true, now, userId: "user-a" }).map((item) => item.meetingId),
  ["oldest", "waiting", "newest"],
  "manual retry should bypass backoff without crossing account ownership",
);

assert.deepEqual(
  selectPendingSyncTargets(recordings, {
    force: true,
    now,
    onlyMeetingId: "deleted-remotely",
    userId: "user-a",
  }),
  [],
  "a durable local deletion fence must block auto-sync and forced manual sync",
);

assert.deepEqual(
  selectPendingSyncTargets(recordings, {
    force: true,
    now,
    onlyMeetingId: "waiting",
    userId: "user-a",
  }).map((item) => item.meetingId),
  ["waiting"],
  "single-meeting retry should not drain unrelated recordings",
);

assert.deepEqual(
  selectPendingSyncTargets(recordings, {
    force: true,
    now,
    onlyMeetingId: "interrupted",
    userId: "user-a",
  }),
  [],
  "an interrupted active recording must be inspected and reclassified before any upload",
);

assert.deepEqual(
  selectPendingSyncTargets(recordings, {
    force: true,
    now,
    onlyMeetingId: "completed",
    userId: "user-a",
  }).map((item) => item.meetingId),
  ["completed"],
  "a completed local archive should only retry when the user explicitly targets it",
);

assert.deepEqual(
  [1, 2, 3, 4, 5, 6, 7, 8].map(pendingRetryDelayMs),
  [15_000, 30_000, 60_000, 120_000, 240_000, 480_000, 900_000, 900_000],
  "retry delay should back off and cap at 15 minutes",
);
assert.equal(pendingRetryDelayMs(1, 60), 60_000, "server Retry-After should extend the first retry delay");
assert.equal(pendingRetryDelayMs(5, 60), 240_000, "exponential backoff should win when it is longer");
assert.equal(pendingRetryDelayMs(1, 3600), 900_000, "server Retry-After should remain capped at 15 minutes");
assert.ok(apiSource.includes("parseRetryAfterSeconds(result.headers)"));
assert.ok(appSource.includes("pendingRetryDelayMs(uploadAttempts, retryAfterSeconds)"));
assert.ok(appSource.includes('recording.activeRecording !== true'));
assert.ok(appSource.includes("{!pendingRecording?.activeRecording || hasInterruptedRecording ? ("));
assert.ok(appSource.includes('label={hasInterruptedRecording ? t("record.recover")'));
assert.ok(appSource.includes("shouldDrainDeferredSync({"));
assert.ok(appSource.includes("const timer = setTimeout(() => autoSyncRequestRef.current(), 0)"));
assert.ok(
  retrySource.indexOf("shouldBlockRecordingSensitiveMutation({") <
    retrySource.indexOf("if (target?.localRecoveryOnly)"),
  "a history retry must be rejected before it can mutate the active recording status",
);
assert.ok(retrySource.includes('"runtime.historySyncBlockedBody"'));
assert.ok(retrySource.includes('"runtime.recordingActionBlockedBody"'));
assert.ok(
  syncSource.indexOf("if (working.realtimeClosePendingAt)") <
    syncSource.indexOf("if (!working.audioUploadedAt)"),
  "a durable pending realtime close must be retried before full-audio upload and finalization",
);
assert.ok(syncSource.includes("await finishRealtimePcmSessionIfPresent({"));
assert.ok(syncSource.includes("realtimeClosePendingAt: undefined"));
assert.ok(
  apiSource.includes('!response.ok || !payload.ok || payload.providerStatus !== "completed"'),
  "HTTP 200 with provider_error must not be accepted as a completed realtime close",
);

console.log(JSON.stringify({
  accountSwitchIsolation: true,
  backoffCapMs: pendingRetryDelayMs(99),
  deviceLegacyRecoveryReadOnly: true,
  ownerlessNeverSyncs: true,
  serverRetryAfterMs: pendingRetryDelayMs(1, 60),
  forcedOrder: selectPendingSyncTargets(recordings, { force: true, now, userId: "user-a" }).map((item) => item.meetingId),
  normalOrder: selectPendingSyncTargets(recordings, { now, userId: "user-a" }).map((item) => item.meetingId),
}, null, 2));

function pending(meetingId, createdAt, overrides = {}) {
  return {
    activeRecording: false,
    createdAt,
    meetingId,
    updatedAt: createdAt,
    uri: `file:///recordings/${meetingId}.m4a`,
    ...overrides,
  };
}
