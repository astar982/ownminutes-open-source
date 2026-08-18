#!/usr/bin/env node

import { createRequire } from "node:module";
import { join } from "node:path";

delete process.env.S3_BUCKET;
delete process.env.R2_BUCKET;
delete process.env.VOLCANO_TOS_BUCKET;
Object.assign(process.env, {
  OWNMINUTES_AUTH_REPOSITORY: "local",
  OWNMINUTES_MEETING_WRITE_LOCK: "process",
});

const require = createRequire(import.meta.url);
const jiti = require("jiti")(join(process.cwd(), "scripts", "finalization-state-race-loader.cjs"), {
  interopDefault: true,
  alias: { "@": join(process.cwd(), "src") },
});
const stateStore = jiti("../src/lib/server/meeting-finalization-state.ts");
const { getMeetingObjectStore, buildMeetingObjectKey, isMissingMeetingObjectError } = jiti("../src/lib/server/meeting-object-store.ts");
const { markMeetingDeleted } = jiti("../src/lib/server/meeting-write-lock.ts");

const timestamp = Date.now();
const meetingId = `finalization-state-race-${timestamp}`;
const deletedMeetingId = `finalization-state-deleted-${timestamp}`;
const ownerUserId = `state-owner-${timestamp}`;
const objectStore = getMeetingObjectStore();

try {
  const queuedA = await stateStore.queueMeetingFinalization({
    meetingId,
    ownerUserId,
    title: "Run A",
    jobId: "job-a",
    processingOperationKey: "operation-a",
    audioRevision: "a".repeat(64),
  });
  const processingA = await stateStore.startMeetingFinalization({
    meetingId,
    ownerUserId,
    title: "Run A",
    leaseMs: 60_000,
    processingOperationKey: queuedA.processingOperationKey,
    audioRevision: queuedA.audioRevision,
  });
  const completedA = await stateStore.completeMeetingFinalization({
    state: processingA,
    resultGeneratedAt: new Date().toISOString(),
    qualityStatus: "verified",
  });

  const queuedB = await stateStore.queueMeetingFinalization({
    meetingId,
    ownerUserId,
    title: "Run B",
    jobId: "job-b",
    processingOperationKey: "operation-b",
    audioRevision: "b".repeat(64),
  });
  const processingB = await stateStore.startMeetingFinalization({
    meetingId,
    ownerUserId,
    title: "Run B",
    leaseMs: 60_000,
    processingOperationKey: queuedB.processingOperationKey,
    audioRevision: queuedB.audioRevision,
  });

  await stateStore.refreshMeetingFinalizationLease({
    meetingId,
    ownerUserId,
    leaseMs: 120_000,
    jobId: processingA.jobId,
    processingOperationKey: processingA.processingOperationKey,
    audioRevision: processingA.audioRevision,
  });
  await stateStore.failMeetingFinalization({
    state: processingA,
    code: "stale-a-failure",
    message: "Run A failed late.",
    retryable: true,
  });
  await stateStore.completeMeetingFinalization({
    state: processingA,
    resultGeneratedAt: completedA.resultGeneratedAt,
    qualityStatus: "unverified",
  });
  const afterStaleA = await stateStore.readMeetingFinalizationState(meetingId);

  const completedB = await stateStore.completeMeetingFinalization({
    state: processingB,
    resultGeneratedAt: new Date().toISOString(),
    qualityStatus: "verified",
  });
  await stateStore.failMeetingFinalization({
    state: processingA,
    code: "older-run-late-failure",
    message: "An older run cannot downgrade B.",
    retryable: false,
  });
  const finalState = await stateStore.readMeetingFinalizationState(meetingId);

  const deletedQueued = await stateStore.queueMeetingFinalization({
    meetingId: deletedMeetingId,
    ownerUserId,
    title: "Deleted run",
    jobId: "job-deleted",
    processingOperationKey: "operation-deleted",
    audioRevision: "d".repeat(64),
  });
  await markMeetingDeleted(deletedMeetingId, ownerUserId);
  await objectStore.deletePrefix(buildMeetingObjectKey(deletedMeetingId, "prefix"));
  const deletedWriteRejected = await stateStore.failMeetingFinalization({
    state: deletedQueued,
    code: "late-after-delete",
    message: "Must not resurrect processing.json.",
    retryable: false,
  }).then(
    () => false,
    (error) => Number(error?.status) === 410 && error?.code === "meeting_deleted",
  );
  const deletedProjectionMissing = await objectStore.getText(buildMeetingObjectKey(deletedMeetingId, "processing")).then(
    () => false,
    (error) => isMissingMeetingObjectError(error),
  );

  const summary = {
    completedA: completedA.status === "completed" && completedA.processingOperationKey === "operation-a",
    completedB: completedB.status === "completed" && completedB.processingOperationKey === "operation-b",
    deletedProjectionMissing,
    deletedWriteRejected,
    forceRevisionBStarted:
      processingB.status === "processing" &&
      processingB.jobId === "job-b" &&
      processingB.processingOperationKey === "operation-b" &&
      processingB.audioRevision === "b".repeat(64),
    staleARejected:
      afterStaleA?.status === "processing" &&
      afterStaleA.jobId === "job-b" &&
      afterStaleA.processingOperationKey === "operation-b",
    staleFailureCannotDowngradeCompletedB:
      finalState?.status === "completed" &&
      finalState.jobId === "job-b" &&
      finalState.processingOperationKey === "operation-b" &&
      finalState.qualityStatus === "verified",
  };
  console.log(JSON.stringify(summary, null, 2));
  if (Object.values(summary).some((value) => value !== true)) process.exitCode = 1;
} finally {
  await objectStore.deletePrefix(buildMeetingObjectKey(meetingId, "prefix")).catch(() => undefined);
  await objectStore.deletePrefix(buildMeetingObjectKey(deletedMeetingId, "prefix")).catch(() => undefined);
}
