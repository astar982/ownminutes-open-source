#!/usr/bin/env node

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  DEFAULT_MEETING_CONTENT_LOCALE,
  getMeetingContentCopy,
  resolveMeetingContentLocale,
} from "../src/lib/meeting-content-locale.ts";
import { normalizeMeetingSummary } from "../src/lib/meeting-summary-normalizer.ts";
import { buildNoSpeechMeetingSummary } from "../src/lib/no-speech-summary.ts";
import { meetingResultHasNoSpeech } from "../apps/mobile/src/meeting-diagnostics.ts";

assert.equal(DEFAULT_MEETING_CONTENT_LOCALE, "zh-Hans");
assert.equal(resolveMeetingContentLocale(null), "zh-Hans");
assert.equal(resolveMeetingContentLocale("fr-FR,fr;q=0.9"), "zh-Hans");
assert.equal(resolveMeetingContentLocale("en"), "en");
assert.equal(resolveMeetingContentLocale("en-US,en;q=0.9"), "en");
assert.equal(resolveMeetingContentLocale("zh-TW,zh;q=0.9"), "zh-Hant");
assert.equal(resolveMeetingContentLocale("zh-Hans"), "zh-Hans");
assert.equal(resolveMeetingContentLocale("en;q=0,zh-Hant;q=0.8"), "zh-Hant");

const englishCopy = getMeetingContentCopy("en");
const simplifiedCopy = getMeetingContentCopy("zh-Hans");
const traditionalCopy = getMeetingContentCopy("zh-Hant");
assert.match(englishCopy.summarySystemPrompt, /every human-readable field in English/i);
assert.match(simplifiedCopy.summarySystemPrompt, /简体中文/);
assert.match(traditionalCopy.summarySystemPrompt, /繁體中文/);
assert.equal(meetingResultHasNoSpeech([englishCopy.asrNoSpeechDiagnostic]), true);
assert.equal(meetingResultHasNoSpeech([simplifiedCopy.asrNoSpeechDiagnostic]), true);
assert.equal(meetingResultHasNoSpeech([traditionalCopy.asrNoSpeechDiagnostic]), true);

const englishNoSpeech = buildNoSpeechMeetingSummary("en");
const simplifiedNoSpeech = buildNoSpeechMeetingSummary();
const traditionalNoSpeech = buildNoSpeechMeetingSummary("zh-Hant");
assert.match(englishNoSpeech.summary, /No usable speech/i);
assert.match(simplifiedNoSpeech.summary, /未检测到可用人声/);
assert.match(traditionalNoSpeech.summary, /未偵測到可用人聲/);
assert.equal(englishNoSpeech.decisions.length, 0);
assert.equal(traditionalNoSpeech.actionItems.length, 0);

const englishFallback = normalizeMeetingSummary({}, "en");
const traditionalFallback = normalizeMeetingSummary({}, "zh-Hant");
assert.match(englishFallback.summary, /no usable transcript/i);
assert.equal(englishFallback.speakerViews[0]?.view, "Unknown");
assert.match(traditionalFallback.summary, /沒有可用逐字稿/);
assert.equal(traditionalFallback.speakerViews[0]?.view, "不確定");

const englishPartial = normalizeMeetingSummary(
  {
    summary: "Actual discussion",
    decisions: [{ title: "", detail: "" }],
    actionItems: [{ owner: "", task: "", due: "" }],
  },
  "en",
);
assert.equal(englishPartial.decisions[0]?.title, "Untitled decision");
assert.equal(englishPartial.decisions[0]?.detail, "Unknown");
assert.equal(englishPartial.actionItems[0]?.owner, "Unknown");
assert.equal(englishPartial.actionItems[0]?.task, "Untitled action item");

const routeSource = readFileSync("src/app/api/meetings/[id]/finalize/route.ts", "utf8");
const finalizerSource = readFileSync("src/lib/server/meeting-finalizer.ts", "utf8");
const queueSource = readFileSync("src/lib/server/finalization-queue.ts", "utf8");
const processingSource = readFileSync("src/lib/meeting-processing.ts", "utf8");
const meetingStoreSource = readFileSync("src/lib/server/meeting-audio-store.ts", "utf8");
const migrationSource = readFileSync("db/migrations/0012_meeting_finalization_content_locale.sql", "utf8");

assert.ok(routeSource.includes('request.headers.get("accept-language")'));
assert.ok(routeSource.includes("contentLocale"));
assert.ok(finalizerSource.includes("contentLocale"));
assert.ok(queueSource.includes("content_locale"));
assert.ok(queueSource.includes("contentLocale: job.contentLocale"));
assert.ok(processingSource.includes("copy.summarySystemPrompt"));
assert.ok(processingSource.includes("output_language: copy.outputLanguage"));
assert.ok(processingSource.includes("contentLocale?: MeetingContentLocale"));
assert.ok(meetingStoreSource.includes("contentLocale: result.contentLocale"));
assert.ok(migrationSource.includes("default 'zh-Hans'"));
assert.ok(migrationSource.includes("'en', 'zh-Hans', 'zh-Hant'"));

console.log(
  JSON.stringify(
    {
      defaultLocale: DEFAULT_MEETING_CONTENT_LOCALE,
      supportedLocales: ["en", "zh-Hans", "zh-Hant"],
      acceptLanguagePropagation: true,
      durableQueueLocale: true,
      localizedPromptAndFallbacks: true,
      legacyResultCompatibility: true,
    },
    null,
    2,
  ),
);
