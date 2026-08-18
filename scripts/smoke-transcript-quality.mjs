#!/usr/bin/env node

import { readFileSync } from "node:fs";

const moduleUrl = new URL("../src/lib/transcript-quality.ts", import.meta.url);
const imported = await import(`${moduleUrl.href}?case=transcript-quality-${Date.now()}`);
const meetingProcessingSource = readFileSync("src/lib/meeting-processing.ts", "utf8");
const meetingContentLocaleSource = readFileSync("src/lib/meeting-content-locale.ts", "utf8");

const usable = imported.diagnoseTranscriptQuality([
  {
    id: "seg-1",
    speaker: "Speaker 1",
    timestamp: "00:01",
    text: "我们今天确认上线范围，并安排下周验证真实 ASR。",
  },
]);

const empty = imported.diagnoseTranscriptQuality([]);

const placeholder = imported.diagnoseTranscriptQuality([
  {
    id: "final-fallback-1",
    speaker: "System",
    timestamp: "00:00",
    text: "音频已保存，等待正式识别配置完成。",
  },
]);

const shortText = imported.diagnoseTranscriptQuality([
  {
    id: "seg-short",
    speaker: "Speaker 1",
    timestamp: "00:01",
    text: "嗯",
  },
]);

const diagnostic = imported.formatTranscriptQualityDiagnostic(placeholder);

const serialized = JSON.stringify({ usable, empty, placeholder, shortText, diagnostic });
const checks = {
  exportsQualityFunctions:
    typeof imported.diagnoseTranscriptQuality === "function" &&
    typeof imported.formatTranscriptQualityDiagnostic === "function",
  usableTranscriptPasses:
    usable.status === "usable" &&
    usable.usableSegments === 1 &&
    usable.totalCharacters >= 8 &&
    usable.reasons.length === 0,
  emptyTranscriptFails:
    empty.status === "empty" &&
    empty.usableSegments === 0 &&
    empty.reasons.includes("no transcript segments"),
  placeholderTranscriptFails:
    placeholder.status === "empty" &&
    placeholder.reasons.includes("placeholder transcript text") &&
    diagnostic.includes("Transcript quality empty"),
  shortTranscriptLowConfidence:
    shortText.status === "low_confidence" &&
    shortText.reasons.includes("too little transcript text"),
  meetingProcessingUsesQualityGate:
    meetingProcessingSource.includes('import {') &&
    meetingProcessingSource.includes('from "@/lib/transcript-quality"') &&
    meetingProcessingSource.includes("const transcriptQuality = diagnoseTranscriptQuality(transcript)") &&
    meetingProcessingSource.includes("formatTranscriptQualityDiagnostic(transcriptQuality)") &&
    meetingProcessingSource.includes('input.transcriptQuality.status !== "usable"') &&
    meetingProcessingSource.includes("Transcript quality is not usable enough for model summarization"),
  meetingProcessingRejectsPlaceholderSummary:
    meetingProcessingSource.includes("isPlaceholderMeetingSummary(normalized.summary)") &&
    meetingProcessingSource.includes("non-actionable placeholder summary") &&
    meetingContentLocaleSource.includes("即使逐字稿是闲聊、与标题不一致") &&
    meetingContentLocaleSource.includes("不得返回‘无相关会议内容’") &&
    meetingProcessingSource.includes("non-actionable placeholder summary/i"),
  doesNotLeakSecrets:
    !serialized.includes("sk-") &&
    !serialized.includes("AKL"),
};

console.log(JSON.stringify({ ok: Object.values(checks).every(Boolean), checks }, null, 2));

if (Object.values(checks).some((value) => value !== true)) {
  process.exitCode = 1;
}
