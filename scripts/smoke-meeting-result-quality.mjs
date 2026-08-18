#!/usr/bin/env node

import { readFileSync } from "node:fs";
import ts from "typescript";

const moduleUrl = new URL("../src/lib/meeting-result-quality.ts", import.meta.url);
const transcriptQualityUrl = new URL("../src/lib/transcript-quality.ts", import.meta.url);
const source = readFileSync(moduleUrl, "utf8")
  .replace('from "./transcript-quality"', `from "${transcriptQualityUrl.href}"`);
const transpiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022,
    verbatimModuleSyntax: false,
  },
}).outputText;
const dataUrl = `data:text/javascript;base64,${Buffer.from(transpiled).toString("base64")}`;
const imported = await import(`${dataUrl}#meeting-result-quality-${Date.now()}`);

const baseResult = {
  meetingId: "quality-smoke",
  title: "质量标识烟测",
  generatedAt: "2026-07-04T00:00:00.000Z",
  provider: "volcano",
  adapter: "volcano-file-asr",
  transcript: [
    {
      id: "seg-1",
      speaker: "Speaker 1",
      timestamp: "00:01",
      text: "我们确认本次会议的上线范围，并安排下周验证真实语音识别效果。",
    },
  ],
  summary: {
    summary: "本次会议确认上线范围，并安排真实语音识别验证。",
    topics: ["上线范围"],
    speakerViews: [{ speaker: "Speaker 1", view: "确认上线范围和验证安排。" }],
    decisions: [],
    actionItems: [],
    risks: [],
    openQuestions: [],
    knowledgePoints: ["真实 ASR 验收需要单独记录证据。"],
  },
  obsidianMarkdown: "# 质量标识烟测",
  diagnostics: ["Using user BYOK Volcano ASR configuration.", "Using user BYOK Ark summary configuration."],
};

const verified = imported.assessMeetingResultQuality(baseResult);
const mock = imported.assessMeetingResultQuality({ ...baseResult, provider: "mock", diagnostics: [] });
const fallback = imported.assessMeetingResultQuality({ ...baseResult, adapter: "volcano-file-asr-fallback" });
const missingArk = imported.assessMeetingResultQuality({
  ...baseResult,
  diagnostics: ["ARK_API_KEY or ARK_CHAT_MODEL is missing; using deterministic local meeting summary."],
});
const placeholder = imported.assessMeetingResultQuality({
  ...baseResult,
  transcript: [{ id: "final-fallback-1", speaker: "System", timestamp: "00:00", text: "音频已保存，等待正式识别配置完成。" }],
});
const placeholderSummary = imported.assessMeetingResultQuality({
  ...baseResult,
  summary: { ...baseResult.summary, summary: "无相关会议内容" },
});
const missing = imported.assessMeetingResultQuality(null);
const unverifiedMarkdown = imported.applyMeetingResultQualityNotice("---\ntype: meeting\n---\n\n# 未验证会议", { ...baseResult, adapter: "volcano-file-asr-fallback" });
const verifiedMarkdown = imported.applyMeetingResultQualityNotice("# 已验证会议", baseResult);
const idempotentMarkdown = imported.applyMeetingResultQualityNotice(unverifiedMarkdown, { ...baseResult, adapter: "volcano-file-asr-fallback" });

const serialized = JSON.stringify({ verified, mock, fallback, missingArk, placeholder, placeholderSummary, missing, unverifiedMarkdown, verifiedMarkdown, idempotentMarkdown });
const checks = {
  exportsQualityFunction: typeof imported.assessMeetingResultQuality === "function" && typeof imported.applyMeetingResultQualityNotice === "function",
  verifiedResultPasses: verified.status === "verified" && verified.canTreatAsFormal === true && verified.reasons.length === 0,
  mockProviderWarns: mock.status === "unverified" && mock.reasons.includes("mock provider"),
  fallbackAdapterWarns: fallback.status === "unverified" && fallback.reasons.includes("fallback adapter"),
  missingArkWarns: missingArk.status === "unverified" && missingArk.reasons.includes("unverified diagnostics"),
  placeholderWarns:
    placeholder.status === "unverified" &&
    placeholder.shareWarningDetail.includes("尚未通过正式识别验收") &&
    placeholder.markdownNotice.includes("请勿作为正式会议事实归档"),
  placeholderSummaryWarns:
    placeholderSummary.status === "unverified" &&
    placeholderSummary.reasons.includes("placeholder meeting summary") &&
    imported.isPlaceholderMeetingSummary("无法生成会议纪要") === true &&
    imported.isPlaceholderMeetingSummary(baseResult.summary.summary) === false,
  missingWarns: missing.status === "unverified" && missing.reasons.includes("missing meeting result"),
  unverifiedMarkdownGetsNotice:
    unverifiedMarkdown.includes("---\n\n> 质量提示") &&
    unverifiedMarkdown.includes("尚未通过正式识别验收") &&
    unverifiedMarkdown.includes("# 未验证会议"),
  verifiedMarkdownUnchanged: verifiedMarkdown === "# 已验证会议",
  markdownNoticeIsIdempotent: idempotentMarkdown === unverifiedMarkdown,
  doesNotLeakSecrets: !serialized.includes("sk-") && !serialized.includes("AKL"),
};

console.log(JSON.stringify({ ok: Object.values(checks).every(Boolean), checks }, null, 2));

if (Object.values(checks).some((value) => value !== true)) {
  process.exitCode = 1;
}
