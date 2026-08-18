import { NextResponse } from "next/server";
import type { ActionItem, Decision, TranscriptSegment } from "@/lib/meeting";
import { assessMeetingResultQuality } from "@/lib/meeting-result-quality";
import type { MeetingResult } from "@/lib/meeting-processing";
import { isMeetingShareActive, readMeetingShareSnapshot } from "@/lib/server/meeting-audio-store";
import { isCanonicalMeetingId } from "@/lib/server/meeting-write-lock";

export const runtime = "nodejs";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!isCanonicalMeetingId(id)) {
    return NextResponse.json({ ok: false, error: "这份会议纪要尚未公开。" }, { status: 404 });
  }
  const { access, result } = await readMeetingShareSnapshot(id);

  if (!access.exists || !isMeetingShareActive(access.share) || access.humanReview.status !== "confirmed") {
    return NextResponse.json({ ok: false, error: "这份会议纪要尚未公开。" }, { status: 404 });
  }

  if (!result) {
    return NextResponse.json({ ok: false, error: "当前会议还没有可导出的 Markdown。" }, { status: 404 });
  }

  const markdown = buildPublicShareMarkdown({
    result,
    includeTranscript: access.share.includeTranscript,
  });
  const filename = `${safeFilename(result.title || id)}-public.md`;

  return new Response(markdown, {
    headers: {
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
      "Content-Type": "text/markdown; charset=utf-8",
    },
  });
}

function buildPublicShareMarkdown(input: { result: MeetingResult; includeTranscript: boolean }) {
  const { result } = input;
  const quality = assessMeetingResultQuality(result);
  const decisions = formatDecisions(result.summary.decisions);
  const actions = formatActions(result.summary.actionItems);
  const speakerViews = formatSpeakerViews(result.summary.speakerViews);
  const risks = formatList(result.summary.risks);
  const openQuestions = formatList(result.summary.openQuestions);
  const knowledgePoints = formatList(result.summary.knowledgePoints);
  const transcript = input.includeTranscript ? formatTranscript(result.transcript) : "逐字稿未公开。当前分享只包含摘要、发言人观点、决策和待办。";
  const qualityNotice = quality.status === "verified" ? "" : `${quality.markdownNotice}\n\n`;

  return `${qualityNotice}# ${result.title}

分享链接：/share/${result.meetingId}
生成时间：${result.generatedAt}

## 会议摘要

${result.summary.summary || "暂无会议摘要。"}

## 发言人观点

${speakerViews || "- 暂无发言人观点。"}

## 决策记录

${decisions || "- 暂无决策记录。"}

## 待办事项

${actions || "- 暂无待办事项。"}

## 风险与阻塞

${risks || "- 暂无风险记录。"}

## 未解决问题

${openQuestions || "- 暂无未解决问题。"}

## 可沉淀知识点

${knowledgePoints || "- 暂无可沉淀知识点。"}

## 逐字稿

${transcript}
`;
}

function formatDecisions(decisions: Decision[]) {
  return decisions.map((decision) => `- **${decision.title}**：${decision.detail}`).join("\n");
}

function formatActions(actions: ActionItem[]) {
  return actions
    .map((item) => `- ${item.task}（负责人：${item.owner}；截止：${item.due}；状态：${item.status === "confirmed" ? "已确认" : "候选"}）`)
    .join("\n");
}

function formatSpeakerViews(speakerViews: MeetingResult["summary"]["speakerViews"]) {
  return speakerViews.map((item) => `- **${item.speaker}**：${item.view}`).join("\n");
}

function formatList(items: string[]) {
  return items.map((item) => `- ${item}`).join("\n");
}

function formatTranscript(transcript: TranscriptSegment[]) {
  return transcript.map((segment) => `- **${segment.timestamp} ${segment.speaker}**：${segment.text}`).join("\n") || "暂无逐字稿。";
}

function safeFilename(value: string) {
  return value.replace(/[\\/:*?"<>|]/g, "-").slice(0, 80) || "ownminutes-meeting";
}
