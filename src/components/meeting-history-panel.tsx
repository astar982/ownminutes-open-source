"use client";

import type { MeetingListItem } from "@/lib/server/meeting-audio-store";
import { ChevronRight, Clock3, ExternalLink, Eye, EyeOff, FileText, FolderKanban, ListChecks, Mic, Search, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

type MeetingFilter = "all" | "completed" | "shared" | "draft";

type MeetingGroup = {
  id: string;
  label: string;
  meetings: MeetingListItem[];
};

const filters: Array<{ id: MeetingFilter; label: string }> = [
  { id: "all", label: "全部" },
  { id: "completed", label: "已生成" },
  { id: "shared", label: "已分享" },
  { id: "draft", label: "未生成" },
];

export function MeetingHistoryPanel({
  compact = false,
  initialProject = "",
  meetings,
}: {
  compact?: boolean;
  initialProject?: string;
  meetings: MeetingListItem[];
}) {
  const router = useRouter();
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<MeetingFilter>("all");
  const [projectFilter, setProjectFilter] = useState(initialProject);

  const filteredMeetings = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    const project = projectFilter.trim();

    return meetings.filter((meeting) => {
      const meetingProject = meeting.metadata.project || "未归档";
      const matchesQuery =
        !keyword ||
        meeting.title.toLowerCase().includes(keyword) ||
        meeting.meetingId.toLowerCase().includes(keyword) ||
        (meeting.metadata.project || "").toLowerCase().includes(keyword) ||
        meeting.metadata.tags.some((tag) => tag.toLowerCase().includes(keyword));
      const matchesFilter =
        filter === "all" ||
        (filter === "completed" && meeting.hasResult) ||
        (filter === "shared" && isShareActive(meeting.share)) ||
        (filter === "draft" && !meeting.hasResult);
      const matchesProject = !project || meetingProject === project;

      return matchesQuery && matchesFilter && matchesProject;
    });
  }, [filter, meetings, projectFilter, query]);

  const groupedMeetings = useMemo(() => groupMeetingsByDate(filteredMeetings), [filteredMeetings]);

  async function updateShare(
    meeting: MeetingListItem,
    visibility: "private" | "public",
    includeTranscript = meeting.share.includeTranscript,
    expiresAt = meeting.share.expiresAt,
  ) {
    if (!confirmShareChange(meeting, visibility, includeTranscript)) return;

    setUpdatingId(meeting.meetingId);
    setMessage(null);

    try {
      const response = await fetch(`/api/meetings/${meeting.meetingId}/share`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          visibility,
          includeTranscript,
          expiresAt,
          confirmUnverified: visibility === "public" && meeting.qualityStatus !== "verified",
        }),
      });
      const payload = await response.json();

      if (!response.ok || !payload.ok) {
        setMessage(payload.error || "分享设置更新失败。");
        return;
      }

      setMessage(visibility === "public" ? "分享链接已发布。" : "分享链接已撤销。");
      router.refresh();
    } catch {
      setMessage("分享设置请求失败。");
    } finally {
      setUpdatingId(null);
    }
  }

  return (
    <section className={compact ? "border-y border-[#e1e8e3] bg-white px-4 py-4" : "mt-5 rounded-lg border border-[#d9ded8] bg-white p-5 shadow-sm"} data-meeting-history-ui={compact ? "compact-list-v30" : "full"}>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className={compact ? "text-base font-semibold" : "text-lg font-semibold"}>{meetings.length ? "会议历史" : "还没有会议"}</h2>
          {meetings.length ? <p className="mt-1 text-sm text-[#667085]">{filteredMeetings.length} / {meetings.length} 场会议</p> : null}
        </div>
        {!compact ? (
          <Link className="primary-action w-fit" href="/app">
            新会议
          </Link>
        ) : null}
      </div>

      {message ? <p className="mt-4 rounded-md border border-[#b9d8c9] bg-[#effaf3] px-3 py-2 text-sm font-medium text-[#1f6f55]">{message}</p> : null}

      {meetings.length ? <div className="mt-4 space-y-3">
        <label className="flex h-11 items-center gap-2 rounded-full bg-[#f3f6f4] px-4 text-sm text-[#344054]">
          <Search className="h-4 w-4 text-[#7b8580]" />
          <input
            className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-[#98a2b3]"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索标题、项目或标签"
            type="search"
            value={query}
          />
        </label>

        {projectFilter ? (
          <button
            className="inline-flex w-fit items-center gap-2 rounded-lg border border-[#b9d8c9] bg-[#effaf3] px-3 py-2 text-xs font-semibold text-[#1f6f55]"
            onClick={() => setProjectFilter("")}
            type="button"
          >
            项目：{projectFilter}
            <X className="h-3.5 w-3.5" />
          </button>
        ) : null}

        <div className="grid grid-cols-4 gap-1 rounded-lg bg-[#f1f4f2] p-1">
          {filters.map((item) => (
            <button
              className={`h-9 rounded-md text-xs font-semibold ${filter === item.id ? "bg-white text-[#111827] shadow-sm" : "text-[#667085]"}`}
              key={item.id}
              onClick={() => setFilter(item.id)}
              type="button"
            >
              {item.label}
            </button>
          ))}
        </div>
      </div> : null}

      <div className="mt-4 space-y-3">
        {filteredMeetings.length ? (
          groupedMeetings.map((group) => (
            <div key={group.id} className="space-y-2">
              <div className="flex items-center justify-between px-1">
                <p className="text-xs font-semibold text-[#667085]">{group.label}</p>
                <p className="text-xs text-[#98a2b3]">{group.meetings.length} 场</p>
              </div>
              {group.meetings.map((meeting) => {
                const isPublic = isShareActive(meeting.share);
                const busy = updatingId === meeting.meetingId;
                if (compact) {
                  return <CompactMeetingRow isPublic={isPublic} key={meeting.meetingId} meeting={meeting} />;
                }
                return (
                  <article key={meeting.meetingId} className="rounded-md border border-[#e1e6e0] bg-[#fbfcfb] p-4">
                    <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                      <Link className="min-w-0" href={`/meetings/${meeting.meetingId}`}>
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <div className="flex flex-wrap items-center gap-2">
                              <h3 className="truncate text-base font-semibold text-[#111827]">{meeting.title}</h3>
                              <span className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${isPublic ? "bg-[#eef6f1] text-[#1f6f55]" : "bg-[#f2f5f1] text-[#667085]"}`}>
                                {isPublic ? "已公开" : "私密"}
                              </span>
                            </div>
                            <p className="mt-1 font-mono text-xs text-[#667085]">{meeting.meetingId}</p>
                            <div className="mt-3 flex items-center gap-2 text-xs text-[#667085]">
                              <Clock3 className="h-3.5 w-3.5 text-[#8a938c]" />
                              <span>{formatDuration(meeting.durationMs)}</span>
                              <span className="h-1 w-1 rounded-full bg-[#c9d1ca]" />
                              <span>{meetingProcessingLabel(meeting)}</span>
                            </div>
                          </div>
                          <span className="shrink-0 rounded-lg bg-[#f4f7f5] px-3 py-2 text-center">
                            <span className="block text-sm font-semibold text-[#111827]">{meeting.transcriptCount}</span>
                            <span className="block text-[10px] font-medium text-[#667085]">转写</span>
                          </span>
                        </div>

                        <div className="mt-3 flex flex-wrap gap-2 text-xs text-[#667085]">
                          <span>{meeting.totalChunks} 个分片</span>
                          <span>{meeting.transcriptCount} 条转写</span>
                          <span>{meeting.share.includeTranscript ? "逐字稿公开" : "逐字稿隐藏"}</span>
                          {meeting.share.expiresAt ? <span>过期：{formatDate(meeting.share.expiresAt)}</span> : null}
                        </div>

                        {meeting.metadata.project || meeting.metadata.tags.length ? (
                          <div className="mt-3 flex flex-wrap gap-1.5 text-[11px] font-semibold">
                            {meeting.metadata.project ? (
                              <span className="inline-flex items-center gap-1 rounded-full bg-[#eef6f1] px-2 py-1 text-[#1f6f55]">
                                <FolderKanban className="h-3 w-3" />
                                {meeting.metadata.project}
                              </span>
                            ) : null}
                            {meeting.metadata.tags.map((tag) => (
                              <span key={tag} className="rounded-full bg-[#f2f5f1] px-2 py-1 text-[#667085]">
                                #{tag}
                              </span>
                            ))}
                          </div>
                        ) : null}
                      </Link>

                      <div className="flex flex-wrap gap-2">
                        <Link className="primary-action" href={`/meetings/${meeting.meetingId}`}>
                          <ListChecks className="h-4 w-4" />
                          详情
                        </Link>
                        <button className="secondary-action" disabled={busy || !meeting.hasResult} type="button" onClick={() => void updateShare(meeting, isPublic ? "private" : "public", false, undefined)}>
                          {isPublic ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                          {isPublic ? "撤销" : "发布"}
                        </button>
                        <Link className={`secondary-action ${isPublic ? "" : "pointer-events-none opacity-50"}`} href={`/share/${meeting.meetingId}`}>
                          <ExternalLink className="h-4 w-4" />
                          分享页
                        </Link>
                        <button
                          className="secondary-action"
                          disabled={busy || !isPublic}
                          type="button"
                          onClick={() => void updateShare(meeting, "public", !meeting.share.includeTranscript)}
                        >
                          <FileText className="h-4 w-4" />
                          {meeting.share.includeTranscript ? "隐藏" : "逐字稿"}
                        </button>
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          ))
        ) : meetings.length ? (
          <div className="rounded-lg border border-dashed border-[#ccd3ce] p-5 text-sm leading-6 text-[#667085]">
            没有匹配的会议。可以换一个关键词或筛选条件。
          </div>
        ) : (
          <div className="flex min-h-48 flex-col items-center justify-center border-t border-[#edf1ee] py-8 text-center" data-meetings-empty-state="focused">
            <span className="flex h-12 w-12 items-center justify-center rounded-full bg-[#eef6f1] text-[#157a5a]"><Mic className="h-5 w-5" /></span>
            <Link className="mt-5 inline-flex min-h-11 items-center justify-center rounded-lg bg-[#157a5a] px-5 text-sm font-semibold text-white" href="/app">录制会议</Link>
          </div>
        )}
      </div>
    </section>
  );
}

function confirmShareChange(meeting: MeetingListItem, visibility: "private" | "public", includeTranscript: boolean) {
  if (visibility !== "public") return true;
  if (meeting.humanReview.status !== "confirmed") {
    window.alert("请先打开会议详情，核对逐字稿、发言人、纪要和待办，并确认当前版本。");
    return false;
  }
  const qualityWarning =
    meeting.qualityStatus !== "verified"
      ? "\n\n质量提示：当前结果尚未通过正式识别验收。发布前请确认已经人工复核，并明确同意分享未验证内容。"
      : "";

  if (includeTranscript) {
    return window.confirm(`确认公开分享并包含逐字稿？拥有链接的人可以查看摘要、发言人观点、决策、待办和逐字稿。${qualityWarning}`);
  }

  return window.confirm(`确认发布分享链接？拥有链接的人可以查看摘要、发言人观点、决策和待办，逐字稿默认隐藏。${qualityWarning}`);
}

function meetingProcessingLabel(meeting: MeetingListItem) {
  if (meeting.hasResult && meeting.humanReview.status !== "confirmed") return meeting.humanReview.needsReconfirmation ? "内容已更新，待重新确认" : "纪要已生成，待人工确认";
  if (meeting.hasResult) return meeting.qualityStatus === "verified" ? "纪要已确认" : "未验证纪要已人工确认";
  if (meeting.processing?.status === "queued") return meeting.processing.attempt > 0 ? `等待重试 · 第 ${meeting.processing.attempt} 次` : "纪要已排队";
  if (meeting.processing?.status === "processing") return `纪要处理中 · 第 ${meeting.processing.attempt} 次`;
  if (meeting.processing?.status === "failed") return "纪要处理失败，可重试";
  return "未生成纪要";
}

function groupMeetingsByDate(meetings: MeetingListItem[]): MeetingGroup[] {
  const now = new Date();
  const todayStart = startOfLocalDay(now).getTime();
  const yesterdayStart = todayStart - 24 * 60 * 60 * 1000;
  const weekStart = todayStart - 6 * 24 * 60 * 60 * 1000;
  const groupMap = new Map<string, MeetingGroup>();

  for (const meeting of meetings) {
    const updatedAt = new Date(meeting.updatedAt);
    const timestamp = Number.isNaN(updatedAt.getTime()) ? 0 : updatedAt.getTime();
    const bucket =
      timestamp >= todayStart
        ? { id: "today", label: "今天" }
        : timestamp >= yesterdayStart
          ? { id: "yesterday", label: "昨天" }
          : timestamp >= weekStart
            ? { id: "this-week", label: "本周" }
            : { id: "earlier", label: "更早" };
    const existing = groupMap.get(bucket.id);

    if (existing) {
      existing.meetings.push(meeting);
    } else {
      groupMap.set(bucket.id, { ...bucket, meetings: [meeting] });
    }
  }

  return ["today", "yesterday", "this-week", "earlier"]
    .map((id) => groupMap.get(id))
    .filter((group): group is MeetingGroup => Boolean(group));
}

function startOfLocalDay(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function CompactMeetingRow({ isPublic, meeting }: { isPublic: boolean; meeting: MeetingListItem }) {
  return (
    <article className="border-b border-[#edf1ee] last:border-b-0" data-meeting-list-row="compact">
      <Link className="flex min-h-20 items-center gap-3 py-3" href={`/meetings/${meeting.meetingId}`}>
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[#eef6f1] text-[#1f6f55]">
          <FileText className="h-5 w-5" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-2">
            <strong className="truncate text-sm text-[#111827]">{meeting.title}</strong>
            <span className={`shrink-0 text-[11px] font-semibold ${isPublic ? "text-[#1f6f55]" : "text-[#7a8580]"}`}>{isPublic ? "已公开" : "私密"}</span>
          </span>
          <span className="mt-1 flex min-w-0 items-center gap-2 text-xs text-[#667085]">
            <Clock3 className="h-3.5 w-3.5 shrink-0" />
            <span>{formatDuration(meeting.durationMs)}</span>
            <span className="h-1 w-1 shrink-0 rounded-full bg-[#c9d1ca]" />
            <span className="truncate">{meetingProcessingLabel(meeting)}</span>
          </span>
          {meeting.metadata.project ? <span className="mt-1 block truncate text-xs text-[#1f6f55]">{meeting.metadata.project}</span> : null}
        </span>
        <ChevronRight className="h-5 w-5 shrink-0 text-[#88958e]" />
      </Link>
    </article>
  );
}

function isShareActive(share: MeetingListItem["share"]) {
  if (share.visibility !== "public") return false;
  if (!share.expiresAt) return false;

  const expiresAt = new Date(share.expiresAt);
  if (Number.isNaN(expiresAt.getTime())) return false;

  return expiresAt.getTime() > Date.now();
}

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "未知";

  return date.toLocaleDateString("zh-CN");
}

function formatDuration(durationMs: number) {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}
