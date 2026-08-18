#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  deleteMeetingWithConfirmation,
  isMeetingDeletionBlocked,
} from "../apps/mobile/src/meeting-deletion.ts";

const appSource = readFileSync("apps/mobile/App.tsx", "utf8");
const dangerLabelIndex = appSource.indexOf('t("meetings.danger")');
const precedingMeetingToolsGateIndex = appSource.lastIndexOf("{showMeetingTools ? (", dangerLabelIndex);
const precedingMeetingToolsGateCloseIndex = appSource.indexOf(") : null}", precedingMeetingToolsGateIndex);
assert.ok(dangerLabelIndex >= 0);
assert.ok(
  precedingMeetingToolsGateCloseIndex >= 0 && precedingMeetingToolsGateCloseIndex < dangerLabelIndex,
  "Delete meeting must remain visible without expanding More tools.",
);
assert.equal(isMeetingDeletionBlocked({
  currentMeetingId: "meeting-current",
  recordingLifecycleBusy: true,
  targetMeetingId: "meeting-current",
}), true);
assert.equal(isMeetingDeletionBlocked({
  currentMeetingId: "meeting-current",
  recordingLifecycleBusy: false,
  targetMeetingId: "meeting-current",
}), false);
assert.equal(isMeetingDeletionBlocked({
  currentMeetingId: "meeting-current",
  recordingLifecycleBusy: true,
  targetMeetingId: "meeting-interrupted",
}), false);

const committedThenRetried = await runScenario({
  deleteOutcomes: [transportError("response lost"), { meetingId: "meeting-1", ok: true }],
  history: ["meeting-1"],
});
assert.equal(committedThenRetried.resolution.status, "deleted");
assert.equal(committedThenRetried.resolution.confirmedBy, "retry");
assert.equal(committedThenRetried.deleteCalls, 2);

const committedWithBothResponsesLost = await runScenario({
  deleteOutcomes: [transportError("timeout 1"), transportError("timeout 2")],
  history: [],
});
assert.equal(committedWithBothResponsesLost.resolution.status, "deleted");
assert.equal(committedWithBothResponsesLost.resolution.confirmedBy, "history");
assert.equal(committedWithBothResponsesLost.resolution.deletion.cleanupPending, true);

const eventualHistoryDelay = await runScenario({
  deleteOutcomes: [transportError("timeout 1"), transportError("timeout 2")],
  history: ["meeting-1"],
});
assert.equal(eventualHistoryDelay.resolution.status, "pending_confirmation");

const deterministicRejection = await runScenario({
  deleteOutcomes: [httpError(403), httpError(403)],
  history: ["meeting-1"],
});
assert.equal(deterministicRejection.resolution.status, "failed");

const retryableHttpRejection = await runScenario({
  deleteOutcomes: [httpError(429), httpError(408)],
  history: ["meeting-1"],
});
assert.equal(retryableHttpRejection.resolution.status, "pending_confirmation");

const historyAlsoUnavailable = await runScenario({
  deleteOutcomes: [transportError("timeout 1"), transportError("timeout 2")],
  historyError: transportError("history timeout"),
});
assert.equal(historyAlsoUnavailable.resolution.status, "pending_confirmation");

console.log(JSON.stringify({
  deterministic4xxIsFailure: deterministicRejection.resolution.status === "failed",
  eventualHistoryDelayStaysPending: eventualHistoryDelay.resolution.status === "pending_confirmation",
  idempotentRetryConfirmsDeletion: committedThenRetried.resolution.status === "deleted",
  lostResponsesUseHistoryConfirmation: committedWithBothResponsesLost.resolution.status === "deleted",
  retryable4xxStaysPending: retryableHttpRejection.resolution.status === "pending_confirmation",
  unavailableHistoryStaysPending: historyAlsoUnavailable.resolution.status === "pending_confirmation",
  deleteActionIsVisibleWithoutExpandingMoreTools:
    precedingMeetingToolsGateCloseIndex >= 0 && precedingMeetingToolsGateCloseIndex < dangerLabelIndex,
  interruptedRecordingIndexCannotPermanentlyBlockHistoryDeletion:
    !isMeetingDeletionBlocked({
      currentMeetingId: "meeting-current",
      recordingLifecycleBusy: true,
      targetMeetingId: "meeting-interrupted",
    }) &&
    !isMeetingDeletionBlocked({
      currentMeetingId: "meeting-current",
      recordingLifecycleBusy: false,
      targetMeetingId: "meeting-current",
    }),
}, null, 2));

async function runScenario({ deleteOutcomes, history = [], historyError }) {
  let deleteCalls = 0;
  const resolution = await deleteMeetingWithConfirmation({
    meetingId: "meeting-1",
    async listMeetingIds() {
      if (historyError) throw historyError;
      return history;
    },
    async requestDelete() {
      const outcome = deleteOutcomes[deleteCalls];
      deleteCalls += 1;
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
  });
  return { deleteCalls, resolution };
}

function httpError(status) {
  return Object.assign(new Error(`HTTP ${status}`), { status });
}

function transportError(message) {
  return new Error(message);
}
