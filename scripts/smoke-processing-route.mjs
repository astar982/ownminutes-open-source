#!/usr/bin/env node

import assert from "node:assert/strict";
const {
  buildMeetingUsageNote,
  calculateMeetingUsage,
  getByokCoverage,
  isUserProcessingMode,
  parseMeetingUsage,
  selectMeetingProcessingRoute,
} = await import("../src/lib/processing-route.ts");

const none = getByokCoverage([]);
const partial = getByokCoverage([credential("volcano-asr", [], ["VOLCANO_ASR_API_KEY"])]);
const invalidLegacy = getByokCoverage([credential("volcano-asr", ["VOLCANO_ASR_APP_ID"], [])]);
const complete = getByokCoverage([
  credential("volcano-asr", [], ["VOLCANO_ASR_API_KEY"]),
  credential("volcano-ark", ["ARK_CHAT_MODEL"], ["ARK_API_KEY"]),
]);
const byokUsage = calculateMeetingUsage({ durationMs: 121_000, route: "byok" });
const hybridUsage = calculateMeetingUsage({ durationMs: 121_000, route: "hybrid" });
const note = buildMeetingUsageNote({ meetingId: "route-smoke", resultGeneratedAt: "2026-07-13T00:00:00.000Z", route: "byok", ...byokUsage });
const parsed = parseMeetingUsage({ minutes: 0, note });
const legacy = parseMeetingUsage({ minutes: 3, note: "Finalized meeting:legacy" });

assert.equal(selectMeetingProcessingRoute(none), "official_quota");
assert.equal(selectMeetingProcessingRoute(partial), "hybrid");
assert.equal(selectMeetingProcessingRoute(invalidLegacy), "official_quota");
assert.equal(selectMeetingProcessingRoute(complete), "byok");
assert.equal(isUserProcessingMode("official_quota"), true);
assert.equal(isUserProcessingMode("byok"), true);
assert.equal(isUserProcessingMode("hybrid"), false);
assert.deepEqual(byokUsage, { processedMinutes: 3, officialMinutesCharged: 0 });
assert.deepEqual(hybridUsage, { processedMinutes: 3, officialMinutesCharged: 3 });
assert.deepEqual(parsed, { processingRoute: "byok", processedMinutes: 3, officialMinutesCharged: 0 });
assert.deepEqual(legacy, { processingRoute: "official_quota", processedMinutes: 3, officialMinutesCharged: 3 });

console.log(JSON.stringify({
  completeByokIsFree: complete.complete && byokUsage.officialMinutesCharged === 0,
  incompleteLegacyAuthIsNotByok: !invalidLegacy.complete && selectMeetingProcessingRoute(invalidLegacy) === "official_quota",
  legacyEventsRemainReadable: legacy.processingRoute === "official_quota" && legacy.officialMinutesCharged === 3,
  legacyPartialCoverageRemainsReadable: partial.hasAny && !partial.complete && selectMeetingProcessingRoute(partial) === "hybrid",
  userCannotSelectHybrid: !isUserProcessingMode("hybrid"),
  usageNoteRoundTrips: parsed.processingRoute === "byok" && parsed.processedMinutes === 3 && parsed.officialMinutesCharged === 0,
}, null, 2));

function credential(providerId, configuredFields, configuredSecrets) {
  return { providerId, configuredFields, configuredSecrets };
}
