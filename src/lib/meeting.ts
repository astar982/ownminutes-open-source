export type MeetingStatus = "idle" | "requesting" | "recording" | "paused" | "processing" | "complete";

export type TranscriptSegment = {
  id: string;
  speaker: string;
  timestamp: string;
  text: string;
};

export type ActionItem = {
  id: string;
  owner: string;
  task: string;
  due: string;
  status: "candidate" | "confirmed";
};

export type Decision = {
  id: string;
  title: string;
  detail: string;
  status: "candidate" | "confirmed";
};

export const demoTranscript: TranscriptSegment[] = [
  {
    id: "t1",
    speaker: "Speaker 1",
    timestamp: "00:12",
    text: "今天先确认 OwnMinutes 第一版的边界，不做完整会议软件，先把录音、转写、纪要、分享和Obsidian沉淀跑通。",
  },
  {
    id: "t2",
    speaker: "Speaker 2",
    timestamp: "01:06",
    text: "实时阶段只需要给出草稿摘要和待办候选，正式纪要等会议结束后再基于完整音频重新处理。",
  },
  {
    id: "t3",
    speaker: "Speaker 1",
    timestamp: "02:18",
    text: "发言人识别第一版先支持Speaker 1、Speaker 2，结束后允许用户把发言人改成真实姓名。",
  },
  {
    id: "t4",
    speaker: "Speaker 2",
    timestamp: "03:41",
    text: "Obsidian不是简单导出一个文件，要把会议、决策、待办和项目时间线都结构化沉淀下来。",
  },
  {
    id: "t5",
    speaker: "Speaker 1",
    timestamp: "05:03",
    text: "分享页默认展示摘要、决策和待办，逐字稿需要单独控制是否公开。",
  },
];

export const demoActions: ActionItem[] = [
  {
    id: "a1",
    owner: "产品",
    task: "确认实时录音工作台的MVP字段和状态流转",
    due: "本周",
    status: "candidate",
  },
  {
    id: "a2",
    owner: "技术",
    task: "设计音频流、转写任务、会后总结任务的数据结构",
    due: "本周",
    status: "candidate",
  },
];

export const demoDecisions: Decision[] = [
  {
    id: "d1",
    title: "采用混合处理架构",
    detail: "会议中实时转写和草稿总结，会议结束后重新处理完整音频并生成正式纪要。",
    status: "confirmed",
  },
  {
    id: "d2",
    title: "第一版不做完整会议软件",
    detail: "优先做点击录音、会议总结、分享链接和Obsidian沉淀。",
    status: "confirmed",
  },
];

export function formatDuration(totalSeconds: number) {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts = hours > 0 ? [hours, minutes, seconds] : [minutes, seconds];

  return parts.map((value) => String(value).padStart(2, "0")).join(":");
}

export function buildObsidianMarkdown(params: {
  title: string;
  date: string;
  shareUrl: string;
  transcript: TranscriptSegment[];
  actions: ActionItem[];
  decisions: Decision[];
}) {
  const transcript = params.transcript
    .map((segment) => `- **${segment.timestamp} ${segment.speaker}**：${segment.text}`)
    .join("\n");

  const actions = params.actions
    .map((item) => `| ${item.task} | ${item.owner} | ${item.due} | ${item.status === "confirmed" ? "已确认" : "候选"} |`)
    .join("\n");

  const decisions = params.decisions.map((item) => `- **${item.title}**：${item.detail}`).join("\n");

  return `---
type: meeting
project: OwnMinutes
date: ${params.date}
tags:
  - meeting
  - ownminutes
share_url: ${params.shareUrl}
---

# ${params.title}

## 会议摘要

本次会议确认 OwnMinutes 第一版以实时录音工作台为核心，会议中生成转写草稿和阶段摘要，会议结束后产出正式纪要、分享链接和Obsidian知识库沉淀。

## 决策记录

${decisions}

## 待办事项

| 事项 | 负责人 | 截止时间 | 状态 |
|---|---|---|---|
${actions}

## 风险与阻塞

- 单设备混合录音下，实时说话人识别准确率有限，需要会后校正。
- 逐字稿可能包含敏感信息，分享页需要单独控制公开范围。
- Obsidian沉淀需要模板、标签和项目归档规则，避免变成无结构文件堆。

## 可沉淀知识点

- 实时摘要是草稿，不应直接作为正式事实来源。
- 正式纪要应基于完整音频、说话人识别和用户确认生成。

## 逐字稿

${transcript}
`;
}
