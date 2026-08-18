import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { getFirstRunGuide } = await jiti.import("../apps/mobile/src/first-run.ts");

const officialTrial = getFirstRunGuide({
  hasCompletedMeeting: false,
  hasProviderConfig: false,
  hasReadyProvider: false,
  officialProcessingStatus: "ready",
  officialMinutesRemaining: 60,
  processingMode: "official_quota",
});
const unavailableOfficialTrial = getFirstRunGuide({
  hasCompletedMeeting: false,
  hasProviderConfig: false,
  hasReadyProvider: false,
  officialProcessingStatus: "unavailable",
  officialMinutesRemaining: 60,
  processingMode: "official_quota",
});
const exhausted = getFirstRunGuide({
  hasCompletedMeeting: false,
  hasProviderConfig: false,
  hasReadyProvider: false,
  officialProcessingStatus: "unavailable",
  officialMinutesRemaining: 0,
  processingMode: "official_quota",
});
const incompleteByok = getFirstRunGuide({
  hasCompletedMeeting: false,
  hasProviderConfig: true,
  hasReadyProvider: false,
  officialProcessingStatus: "unavailable",
  officialMinutesRemaining: 0,
  processingMode: "byok",
});
const readyByok = getFirstRunGuide({
  hasCompletedMeeting: false,
  hasProviderConfig: true,
  hasReadyProvider: true,
  officialProcessingStatus: "unavailable",
  officialMinutesRemaining: 0,
  processingMode: "byok",
});
const completed = getFirstRunGuide({
  hasCompletedMeeting: true,
  hasProviderConfig: false,
  hasReadyProvider: false,
  officialProcessingStatus: "ready",
  officialMinutesRemaining: 59,
  processingMode: "official_quota",
});
const englishOfficialTrial = getFirstRunGuide({
  hasCompletedMeeting: false,
  hasProviderConfig: false,
  hasReadyProvider: false,
  officialProcessingStatus: "ready",
  officialMinutesRemaining: 60,
  processingMode: "official_quota",
}, "en");
const traditionalExhausted = getFirstRunGuide({
  hasCompletedMeeting: false,
  hasProviderConfig: false,
  hasReadyProvider: false,
  officialProcessingStatus: "unavailable",
  officialMinutesRemaining: 0,
  processingMode: "official_quota",
}, "zh-Hant");

const officialWithReadyByok = getFirstRunGuide({
  hasCompletedMeeting: false,
  hasProviderConfig: true,
  hasReadyProvider: true,
  officialProcessingStatus: "ready",
  officialMinutesRemaining: 60,
  processingMode: "official_quota",
});
const invalidSelectedByok = getFirstRunGuide({
  hasCompletedMeeting: false,
  hasProviderConfig: false,
  hasReadyProvider: false,
  officialProcessingStatus: "ready",
  officialMinutesRemaining: 60,
  processingMode: "byok",
});
const unknownOfficialTrial = getFirstRunGuide({
  hasCompletedMeeting: false,
  hasProviderConfig: false,
  hasReadyProvider: false,
  officialProcessingStatus: "unknown",
  officialMinutesRemaining: 60,
  processingMode: "official_quota",
});

assert.equal(officialTrial?.primaryAction, "start");
assert.equal(officialTrial?.secondaryAction, undefined);
assert.equal(unavailableOfficialTrial?.primaryAction, "check");
assert.equal(unavailableOfficialTrial?.secondaryAction, "configure");
assert.equal(exhausted?.primaryAction, "configure");
assert.equal(exhausted?.secondaryAction, "plans");
assert.equal(incompleteByok?.primaryAction, "configure");
assert.equal(incompleteByok?.secondaryAction, "check");
assert.equal(readyByok?.primaryAction, "start");
assert.equal(readyByok?.secondaryAction, undefined);
assert.equal(completed, null);
assert.equal(officialTrial?.title, "先免费试用 60 分钟");
assert.equal(englishOfficialTrial?.title, "Try 60 free minutes first");
assert.equal(englishOfficialTrial?.primaryLabel, "Start a short meeting");
assert.equal(traditionalExhausted?.title, "正式紀要暫不可用");
assert.equal(traditionalExhausted?.secondaryLabel, "查看官方額度");
assert.equal(officialWithReadyByok?.primaryAction, "start");
assert.equal(officialWithReadyByok?.title, "先免费试用 60 分钟");
assert.equal(invalidSelectedByok?.primaryAction, "configure");
assert.equal(invalidSelectedByok?.secondaryAction, "check");
assert.equal(unknownOfficialTrial?.primaryAction, "start");
assert.equal(unknownOfficialTrial?.tone, "attention");
assert.match(unknownOfficialTrial?.detail ?? "", /本机/);

console.log(JSON.stringify({
  completedGuideHidden: completed === null,
  exhaustedRoutesToRecovery: exhausted?.primaryAction === "configure" && exhausted.secondaryAction === "plans",
  incompleteByokRoutesToSetup: incompleteByok?.primaryAction === "configure" && incompleteByok.secondaryAction === "check",
  officialTrialStartsWithoutSetup: officialTrial?.primaryAction === "start" && officialTrial.secondaryAction === undefined,
  unavailableOfficialTrialDoesNotOverpromise: unavailableOfficialTrial?.primaryAction === "check" && unavailableOfficialTrial.secondaryAction === "configure",
  unknownOfficialTrialAllowsSafeLocalRecording: unknownOfficialTrial?.primaryAction === "start" && unknownOfficialTrial.tone === "attention",
  readyByokStartsTest: readyByok?.primaryAction === "start" && readyByok.secondaryAction === undefined,
  officialSelectionIgnoresReadyByok: officialWithReadyByok?.title === "先免费试用 60 分钟",
  invalidByokDoesNotFallbackToOfficial: invalidSelectedByok?.primaryAction === "configure" && invalidSelectedByok.secondaryAction === "check",
  simplifiedChineseRemainsDefault: officialTrial?.eyebrow === "首次使用" && officialTrial.title === "先免费试用 60 分钟",
  englishGuideIsLocalized: englishOfficialTrial?.eyebrow === "First meeting" && englishOfficialTrial.title === "Try 60 free minutes first",
  traditionalGuideIsLocalized: traditionalExhausted?.eyebrow === "需要選擇處理方式" && traditionalExhausted.title === "正式紀要暫不可用",
}, null, 2));
