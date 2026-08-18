#!/usr/bin/env node

import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { formatMeetingBilling, getMeetingCostPreview, getMobileByokCoverage } = await jiti.import("../apps/mobile/src/meeting-cost.ts");

const readyHealth = [health("volcano-asr", "ready"), health("volcano-ark", "ready")];
const official = getMeetingCostPreview({ credentials: [], health: readyHealth, officialMinutesRemaining: 60, officialProcessingStatus: "ready", processingMode: "official_quota" });
const lowOfficial = getMeetingCostPreview({ credentials: [], health: readyHealth, officialMinutesRemaining: 5, officialProcessingStatus: "ready", processingMode: "official_quota" });
const officialEnglish = getMeetingCostPreview({ credentials: [], health: readyHealth, officialMinutesRemaining: 60, officialProcessingStatus: "ready", processingMode: "official_quota" }, "en");
const lowOfficialTraditional = getMeetingCostPreview({ credentials: [], health: readyHealth, officialMinutesRemaining: 5, officialProcessingStatus: "ready", processingMode: "official_quota" }, "zh-Hant");
const partialCredentials = [credential("volcano-asr", [], ["VOLCANO_ASR_API_KEY"])];
const partialOfficial = getMeetingCostPreview({ credentials: partialCredentials, health: readyHealth, officialMinutesRemaining: 20, officialProcessingStatus: "ready", processingMode: "official_quota" });
const completeCredentials = [
  credential("volcano-asr", [], ["VOLCANO_ASR_API_KEY"]),
  credential("volcano-ark", ["ARK_CHAT_MODEL"], ["ARK_API_KEY"]),
];
const byok = getMeetingCostPreview({ credentials: completeCredentials, health: readyHealth, officialMinutesRemaining: 0, officialProcessingStatus: "unavailable", processingMode: "byok" });
const byokEnglish = getMeetingCostPreview({ credentials: completeCredentials, health: readyHealth, officialMinutesRemaining: 0, officialProcessingStatus: "unavailable", processingMode: "byok" }, "en");
const unavailable = getMeetingCostPreview({ credentials: partialCredentials, health: readyHealth, officialMinutesRemaining: 0, officialProcessingStatus: "ready", processingMode: "official_quota" });
const unknown = getMeetingCostPreview({ credentials: [], health: readyHealth, officialMinutesRemaining: 60, officialProcessingStatus: "unknown", processingMode: "official_quota" });
const invalidByok = getMeetingCostPreview({ credentials: partialCredentials, health: readyHealth, officialMinutesRemaining: 60, officialProcessingStatus: "ready", processingMode: "byok" });
const actualByok = formatMeetingBilling({ processingRoute: "byok", processedMinutes: 3, officialMinutesCharged: 0 });
const actualOfficial = formatMeetingBilling({ processingRoute: "official_quota", processedMinutes: 3, officialMinutesCharged: 3 });
const actualByokEnglish = formatMeetingBilling({ processingRoute: "byok", processedMinutes: 3, officialMinutesCharged: 0 }, "en");
const actualOfficialTraditional = formatMeetingBilling({ processingRoute: "official_quota", processedMinutes: 3, officialMinutesCharged: 3 }, "zh-Hant");

assert.equal(official.route, "official_quota");
assert.equal(lowOfficial.tone, "attention");
assert.equal(partialOfficial.route, "official_quota");
assert.equal(byok.route, "byok");
assert.equal(unavailable.route, "unavailable");
assert.equal(unknown.route, "unavailable");
assert.match(unknown.detail, /尚未确认/);
assert.equal(invalidByok.route, "unavailable");
assert.equal(actualByok?.detail, "处理 3 分钟，未扣官方分钟。");
assert.equal(actualOfficial?.detail, "处理 3 分钟，扣除 3 官方分钟。");
assert.equal(officialEnglish.detail, "Official minutes are charged by processing time. 60 minutes remain.");
assert.equal(byokEnglish.detail, "Speech recognition and summarization both use BYOK, with no official minutes charged.");
assert.equal(lowOfficialTraditional.detail, "本場按處理時間扣官方分鐘；剩餘 5 分鐘，額度偏低。");
assert.equal(actualByokEnglish?.detail, "3 minutes processed; no official minutes charged.");
assert.equal(actualOfficialTraditional?.label, "實際使用：官方額度");

console.log(JSON.stringify({
  completeByokPreviewIsFree: byok.route === "byok" && byok.detail.includes("不扣官方分钟"),
  lowOfficialQuotaWarns: lowOfficial.route === "official_quota" && lowOfficial.detail.includes("额度偏低"),
  partialConfigurationDoesNotImplicitlyMix: partialOfficial.route === "official_quota" && partialOfficial.detail.includes("扣官方分钟"),
  invalidSelectedByokIsBlocked: invalidByok.route === "unavailable" && invalidByok.detail.includes("切换到官方额度"),
  actualBillingIsExplicit: actualByok?.label.includes("实际使用") && actualOfficial?.detail.includes("扣除 3"),
  exhaustedPartialRouteIsBlocked: unavailable.route === "unavailable",
  credentialCoverageRequiresBoth: getMobileByokCoverage(completeCredentials, readyHealth).complete && !getMobileByokCoverage(partialCredentials, readyHealth).complete,
  unknownServiceNeverAppearsReady: unknown.route === "unavailable" && unknown.tone === "blocked",
  simplifiedChineseRemainsDefault: actualByok?.label === "实际使用：自己的模型" && official.detail.includes("剩余 60 分钟"),
  englishCostCopyIsLocalized: officialEnglish.label === "Expected: official credits" && actualByokEnglish?.label === "Actual use: your models",
  traditionalCostCopyIsLocalized: lowOfficialTraditional.label === "預計使用官方額度" && actualOfficialTraditional?.detail.includes("扣除 3 官方分鐘"),
}, null, 2));

function credential(providerId, configuredFields, configuredSecrets) {
  return { id: providerId, providerId, label: providerId, configuredFields, configuredSecrets, secretPreviews: {}, updatedAt: new Date(0).toISOString() };
}

function health(providerId, status) {
  return { providerId, label: providerId, status, canUseFor: [], liveChecked: false, checks: [], missing: [], nextActions: [], updatedAt: new Date(0).toISOString() };
}
