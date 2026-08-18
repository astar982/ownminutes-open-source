#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

const moduleUrl = new URL("../src/lib/meeting-summary-normalizer.ts", import.meta.url);
const imported = await import(`${moduleUrl.href}?case=summary-${Date.now()}`);

const summary = imported.normalizeMeetingSummary({
  summary: "  讨论了上线范围和风险  ",
  topics: [" 上线范围 ", "", null, " 风险复核 "],
  speaker_views: [
    { speaker: "Speaker 1", detail: "负责说明产品边界" },
    { speaker: "", view: "" },
  ],
  decisions: [
    { id: "", title: "先做录音闭环", detail: "", status: "done" },
    { title: "", description: "暂不公开逐字稿", status: "confirmed" },
  ],
  action_items: [
    { owner: "", action: "补充 ASR 验收样本", deadline: "", status: "todo" },
    { assignee: "Speaker 2", task: "", due: "下周", status: "confirmed" },
  ],
  risks: [" 真实 ASR 还未验收 ", ""],
  open_questions: [null, "是否需要先上 TestFlight"],
  knowledge_points: [" BYOK 密钥不得回显 "],
});

const fallback = imported.normalizeMeetingSummary({
  summary: "",
  topics: [],
  speakerViews: [],
  decisions: [],
  actionItems: [],
  risks: [],
  openQuestions: [],
  knowledgePoints: [],
});

const processingSource = fs.readFileSync(path.join(process.cwd(), "src", "lib", "meeting-processing.ts"), "utf8");

const checks = {
  exportedNormalizer: typeof imported.normalizeMeetingSummary === "function",
  trimsSummary: summary.summary === "讨论了上线范围和风险",
  filtersTopicArray: summary.topics.length === 2 && summary.topics[0] === "上线范围",
  supportsSnakeCaseSpeakerViews: summary.speakerViews[0]?.view === "负责说明产品边界",
  fillsDecisionDefaults:
    summary.decisions[0]?.id === "d1" &&
    summary.decisions[0]?.detail === "不确定" &&
    summary.decisions[0]?.status === "candidate" &&
    summary.decisions[1]?.title === "未命名决策" &&
    summary.decisions[1]?.detail === "暂不公开逐字稿" &&
    summary.decisions[1]?.status === "confirmed",
  fillsActionDefaults:
    summary.actionItems[0]?.owner === "不确定" &&
    summary.actionItems[0]?.task === "补充 ASR 验收样本" &&
    summary.actionItems[0]?.due === "不确定" &&
    summary.actionItems[0]?.status === "candidate" &&
    summary.actionItems[1]?.owner === "Speaker 2" &&
    summary.actionItems[1]?.task === "未命名待办" &&
    summary.actionItems[1]?.status === "confirmed",
  filtersStringArrays:
    summary.risks.length === 1 &&
    summary.risks[0] === "真实 ASR 还未验收" &&
    summary.openQuestions.length === 1 &&
    summary.knowledgePoints[0] === "BYOK 密钥不得回显",
  fallbackIsComplete:
    Boolean(fallback.summary) &&
    fallback.topics.length > 0 &&
    fallback.speakerViews.length > 0 &&
    fallback.decisions.length === 0 &&
    fallback.actionItems.length === 0 &&
    fallback.risks.length > 0 &&
    fallback.openQuestions.length > 0 &&
    fallback.knowledgePoints.length > 0,
  arkThinkingDisabled:
    processingSource.includes('thinking: {') &&
    processingSource.includes('type: "disabled"'),
  arkOutputTokensAreBounded:
    processingSource.includes("OWNMINUTES_SUMMARY_MAX_TOKENS") &&
    processingSource.includes("max_tokens: getArkSummaryMaxTokens()") &&
    processingSource.includes("256, 4096, 4096"),
  arkUsageIsParsedSafely:
    processingSource.includes("parseArkSummaryUsage") &&
    processingSource.includes("Number.isSafeInteger") &&
    processingSource.includes("prompt_tokens_details") &&
    processingSource.includes("completion_tokens_details"),
  arkUsageIsRecordedWithoutSecrets:
    processingSource.includes("Ark summary token usage:") &&
    processingSource.includes("inputTokens") &&
    processingSource.includes("outputTokens") &&
    !processingSource.includes("Ark summary token usage: ${input.apiKey}"),
  doesNotLeakSecrets: !JSON.stringify({ summary, fallback }).includes("sk-"),
};

console.log(JSON.stringify({ ok: Object.values(checks).every((value) => value === true), checks }, null, 2));

if (Object.values(checks).some((value) => value !== true)) {
  process.exitCode = 1;
}
