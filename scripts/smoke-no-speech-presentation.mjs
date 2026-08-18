#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createJiti } from "jiti";
import { buildNoSpeechMeetingSummary } from "../src/lib/no-speech-summary.ts";

const jiti = createJiti(import.meta.url);
const { meetingResultHasNoSpeech, toUserFacingMeetingDiagnostic } = await jiti.import(
  "../apps/mobile/src/meeting-diagnostics.ts",
);

const diagnostics = [
  "火山会后识别未检测到可用人声；本地音频已保留。",
  "Transcript quality empty: 0/0 usable segments, 0 chars.",
  "Transcript quality is not usable enough for model summarization; using deterministic local meeting summary.",
];
const summary = buildNoSpeechMeetingSummary();
const visibleDiagnostic = toUserFacingMeetingDiagnostic(diagnostics, "zh-Hans");
const englishDiagnostic = toUserFacingMeetingDiagnostic(diagnostics, "en");
const traditionalDiagnostic = toUserFacingMeetingDiagnostic(diagnostics, "zh-Hant");

assert.equal(meetingResultHasNoSpeech(diagnostics), true);
assert.equal(visibleDiagnostic, "本次录音未检测到可用人声。音频已安全保留，可检查麦克风后重新生成。");
assert.equal(englishDiagnostic, "No usable speech was detected in this recording. The audio is safely preserved; check the microphone and try generating notes again.");
assert.equal(traditionalDiagnostic, "本次錄音未偵測到可用人聲。音訊已安全保留，可檢查麥克風後重新產生。");
assert.ok(!visibleDiagnostic.includes("Transcript"));
assert.ok(!summary.summary.includes("配置"));
assert.ok(!summary.summary.includes("模型"));
assert.equal(summary.decisions.length, 0);
assert.equal(summary.actionItems.length, 0);

const appSource = readFileSync("apps/mobile/App.tsx", "utf8");
assert.ok(appSource.includes("meetingResultHasNoSpeech(finalized.result.diagnostics)"));
assert.ok(appSource.includes("diagnostic: visibleDiagnostic"));
assert.ok(appSource.includes("toUserFacingMeetingDiagnostic(ack.diagnostic, locale)"));
assert.ok(appSource.includes("toUserFacingMeetingDiagnostic(finalized.result.diagnostics, locale)"));
assert.ok(!appSource.includes('finalized.result?.diagnostics.join("；")'));

console.log(JSON.stringify({
  noSpeechDetected: true,
  rawEnglishDiagnosticHidden: true,
  localizedInAllSupportedLanguages: Boolean(englishDiagnostic && traditionalDiagnostic),
  summary: summary.summary,
  visibleDiagnostic,
}, null, 2));
