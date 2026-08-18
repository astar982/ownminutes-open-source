import { isMeetingShareActive, type MeetingDetail, type MeetingListItem } from "@/lib/server/meeting-audio-store";

export type ProjectSummary = {
  name: string;
  completedCount: number;
  lastUpdated: string;
  meetingCount: number;
  publicCount: number;
  tags: string[];
};

export function getMeetingProjectName(meeting: Pick<MeetingListItem, "metadata">) {
  return meeting.metadata.project || "未归档";
}

export function filterMeetingsByProject<T extends Pick<MeetingListItem, "metadata">>(meetings: T[], projectName: string) {
  return meetings.filter((meeting) => getMeetingProjectName(meeting) === projectName);
}

export function buildProjectSummaries(meetings: MeetingListItem[]): ProjectSummary[] {
  const projects = new Map<string, ProjectSummary>();

  for (const meeting of meetings) {
    const name = getMeetingProjectName(meeting);
    const existing =
      projects.get(name) ??
      ({
        name,
        completedCount: 0,
        lastUpdated: meeting.updatedAt,
        meetingCount: 0,
        publicCount: 0,
        tags: [],
      } satisfies ProjectSummary);
    const tagSet = new Set(existing.tags.map((tag) => tag.toLowerCase()));

    existing.meetingCount += 1;
    if (meeting.hasResult) existing.completedCount += 1;
    if (isMeetingShareActive(meeting.share)) existing.publicCount += 1;
    if (meeting.updatedAt > existing.lastUpdated) existing.lastUpdated = meeting.updatedAt;

    for (const tag of meeting.metadata.tags) {
      const key = tag.toLowerCase();
      if (tagSet.has(key)) continue;
      tagSet.add(key);
      existing.tags.push(tag);
    }

    projects.set(name, existing);
  }

  return [...projects.values()].sort((left, right) => right.lastUpdated.localeCompare(left.lastUpdated));
}

export function buildProjectMarkdown(projectName: string, meetings: MeetingDetail[]) {
  const now = new Date().toISOString();
  const tags = collectTags(meetings);
  const completedCount = meetings.filter((meeting) => meeting.hasResult).length;
  const publicCount = meetings.filter((meeting) => isMeetingShareActive(meeting.share)).length;
  const meetingLines = meetings
    .map((meeting) => {
      const date = formatDate(meeting.updatedAt);
      const status = meeting.hasResult ? "已生成纪要" : "未生成纪要";
      return `- [[${safeWikiLink(meeting.title)}]] - ${date} - ${status} - ${meeting.transcriptCount} 条转写`;
    })
    .join("\n");
  const summaries = meetings
    .filter((meeting) => meeting.result)
    .map((meeting) => {
      const decisions = meeting.result?.summary.decisions.map((decision) => `  - ${decision.title}：${decision.detail}`).join("\n") || "  - 暂无决策";
      const actions = meeting.result?.summary.actionItems.map((item) => `  - ${item.task}（${item.owner}，${item.due}）`).join("\n") || "  - 暂无待办";

      return `### ${meeting.title}

- 日期：${formatDate(meeting.updatedAt)}
- 分享：${isMeetingShareActive(meeting.share) ? "已公开" : "私密"}
- 逐字稿：${meeting.transcriptCount} 条

摘要：
${meeting.result?.summary.summary || "暂无摘要"}

决策：
${decisions}

待办：
${actions}`;
    })
    .join("\n\n");
  const projectSummaries = meetings
    .filter((meeting) => meeting.result?.summary.summary)
    .map((meeting) => `- [[${safeWikiLink(meeting.title)}]]：${meeting.result?.summary.summary}`)
    .join("\n");
  const decisionLines = meetings
    .flatMap((meeting) =>
      meeting.result?.summary.decisions.map((decision) => `- [[${safeWikiLink(meeting.title)}]]：${decision.title} - ${decision.detail}`) ?? [],
    )
    .join("\n");
  const actionLines = meetings
    .flatMap((meeting) =>
      meeting.result?.summary.actionItems.map((item) => `- [ ] ${item.task}（${item.owner}，${item.due}） - [[${safeWikiLink(meeting.title)}]]`) ?? [],
    )
    .join("\n");
  const knowledgeLines = collectKnowledgePoints(meetings)
    .map((point) => `- ${point}`)
    .join("\n");

  return `---
type: project-meeting-index
project: ${escapeFrontmatterValue(projectName)}
date: ${now.slice(0, 10)}
tags:
  - ownminutes
  - project
${tags.map((tag) => `  - ${escapeFrontmatterValue(tag)}`).join("\n")}
---

# ${projectName}

## 项目概览

- 会议总数：${meetings.length}
- 已生成纪要：${completedCount}
- 已公开分享：${publicCount}
- 最近更新：${meetings[0] ? formatDate(meetings[0].updatedAt) : "暂无"}

## 项目知识摘要

${projectSummaries || "暂无项目摘要。"}

## 决策汇总

${decisionLines || "暂无决策记录。"}

## 待办汇总

${actionLines || "暂无待办事项。"}

## 可沉淀知识点

${knowledgeLines || "暂无知识点。"}

## 会议索引

${meetingLines || "暂无会议。"}

## 会议摘要汇总

${summaries || "暂无已生成纪要的会议。"}
`;
}

function collectTags(meetings: MeetingDetail[]) {
  const seen = new Set<string>();
  const tags: string[] = [];

  for (const meeting of meetings) {
    for (const tag of meeting.metadata.tags) {
      const key = tag.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      tags.push(tag);
    }
  }

  return tags;
}

function collectKnowledgePoints(meetings: MeetingDetail[]) {
  const seen = new Set<string>();
  const points: string[] = [];

  for (const meeting of meetings) {
    for (const point of meeting.result?.summary.knowledgePoints ?? []) {
      const trimmed = point.trim();
      const key = trimmed.toLowerCase();
      if (!trimmed || seen.has(key)) continue;
      seen.add(key);
      points.push(trimmed);
    }
  }

  return points;
}

function safeWikiLink(value: string) {
  return value.replace(/[\[\]|#^]/g, "-").trim() || "未命名会议";
}

function escapeFrontmatterValue(value: string) {
  return value.replace(/\n/g, " ").trim();
}

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "时间未知";
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}
