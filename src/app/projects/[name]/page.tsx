import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { ArrowLeft, CheckCircle2, Download, FileText, FolderKanban, Lightbulb, ListChecks, Mic } from "lucide-react";
import Link from "next/link";
import { AppBottomNav } from "@/components/app-bottom-nav";
import { MeetingHistoryPanel } from "@/components/meeting-history-panel";
import { filterMeetingsByProject } from "@/lib/project-summaries";
import { getCurrentUser } from "@/lib/server/current-user";
import { listUserMeetings, readUserMeetingDetail } from "@/lib/server/meeting-audio-store";

export const metadata: Metadata = {
  title: "项目详情 - OwnMinutes",
};

export const dynamic = "force-dynamic";

export default async function ProjectDetailPage({ params }: { params: Promise<{ name: string }> }) {
  const { name } = await params;
  const projectName = decodeProjectName(name);
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const meetings = await listUserMeetings(user.id);
  const projectMeetings = filterMeetingsByProject(meetings, projectName);
  if (!projectMeetings.length) notFound();

  const projectDetails = await Promise.all(projectMeetings.map((meeting) => readUserMeetingDetail(meeting.meetingId, user.id)));
  const completedCount = projectMeetings.filter((meeting) => meeting.hasResult).length;
  const publicCount = projectMeetings.filter((meeting) => meeting.share.visibility === "public").length;
  const transcriptCount = projectMeetings.reduce((sum, meeting) => sum + meeting.transcriptCount, 0);
  const tags = Array.from(new Set(projectMeetings.flatMap((meeting) => meeting.metadata.tags)));
  const summaries = projectDetails
    .filter((meeting) => meeting.result?.summary.summary)
    .map((meeting) => ({ meetingId: meeting.meetingId, title: meeting.title, text: meeting.result?.summary.summary || "" }))
    .slice(0, 3);
  const decisions = projectDetails
    .flatMap((meeting) => meeting.result?.summary.decisions.map((decision) => ({ ...decision, meetingId: meeting.meetingId, meetingTitle: meeting.title })) ?? [])
    .slice(0, 5);
  const actions = projectDetails
    .flatMap((meeting) => meeting.result?.summary.actionItems.map((action) => ({ ...action, meetingId: meeting.meetingId, meetingTitle: meeting.title })) ?? [])
    .slice(0, 5);
  const knowledgePoints = Array.from(new Set(projectDetails.flatMap((meeting) => meeting.result?.summary.knowledgePoints ?? []))).slice(0, 8);

  return (
    <main className="min-h-screen bg-[#e8ecf1] text-[#121417] sm:py-5">
      <div className="ownminutes-mobile-shell relative mx-auto min-h-screen w-full max-w-[430px] bg-[#f8f7f3] pb-24 shadow-[0_24px_70px_rgba(15,23,42,0.12)] sm:min-h-[860px] sm:overflow-hidden sm:rounded-[28px] sm:border sm:border-[#d8dde4]">
        <header className="sticky top-0 z-20 border-b border-[#e6e0d4] bg-[#f8f7f3]/95 px-5 pb-3 pt-4 backdrop-blur">
          <div className="flex items-center justify-between gap-3">
            <Link className="app-icon-button" href="/projects" title="返回项目">
              <ArrowLeft className="h-4 w-4" />
            </Link>
            <div className="min-w-0 flex-1">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#738078]">Project</p>
              <h1 className="mt-1 truncate text-xl font-semibold text-[#111827]">{projectName}</h1>
            </div>
            <Link className="app-icon-button app-icon-button-dark" href="/app" title="新会议">
              <Mic className="h-4 w-4" />
            </Link>
          </div>
        </header>

        <div className="space-y-4 px-4 py-4">
          <section className="rounded-lg border border-[#e2ddd2] bg-white p-4 shadow-[0_18px_45px_rgba(15,23,42,0.08)]">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <p className="text-sm text-[#667085]">项目知识库</p>
                <h2 className="mt-1 line-clamp-2 text-2xl font-semibold leading-tight text-[#111827]">{projectName}</h2>
              </div>
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[#edf5f0] text-[#157a5a]">
                <FolderKanban className="h-5 w-5" />
              </span>
            </div>

            <div className="mt-5 grid grid-cols-3 gap-2 text-center">
              <Metric label="会议" value={String(projectMeetings.length)} />
              <Metric label="纪要" value={String(completedCount)} />
              <Metric label="分享" value={String(publicCount)} />
            </div>

            <div className="mt-4 grid grid-cols-2 gap-2">
              <Link className="app-primary-button" href={`/api/projects/${encodeURIComponent(projectName)}/export`}>
                <Download className="h-4 w-4" />
                导出项目
              </Link>
              <Link className="app-secondary-button" href={`/meetings?project=${encodeURIComponent(projectName)}`}>
                查看会议
              </Link>
            </div>
          </section>

          <section className="grid grid-cols-3 gap-2">
            <InfoTile icon={<FileText className="h-4 w-4" />} label="逐字稿" value={`${transcriptCount}`} />
            <InfoTile icon={<ListChecks className="h-4 w-4" />} label="标签" value={`${tags.length}`} />
            <InfoTile icon={<FolderKanban className="h-4 w-4" />} label="状态" value={completedCount ? "已沉淀" : "待生成"} />
          </section>

          {tags.length ? (
            <section className="rounded-lg border border-[#e4e8e5] bg-white p-4 shadow-sm">
              <h2 className="text-base font-semibold">项目标签</h2>
              <div className="mt-3 flex flex-wrap gap-1.5">
                {tags.map((tag) => (
                  <span key={tag} className="rounded-full bg-[#f2f5f1] px-2 py-1 text-xs font-semibold text-[#667085]">
                    #{tag}
                  </span>
                ))}
              </div>
            </section>
          ) : null}

          <section className="rounded-lg border border-[#d9eadf] bg-white p-4 shadow-sm">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-base font-semibold text-[#111827]">项目知识摘要</h2>
                <p className="mt-1 text-sm leading-6 text-[#667085]">从已生成纪要的会议中自动聚合，便于快速复盘。</p>
              </div>
              <Lightbulb className="h-5 w-5 shrink-0 text-[#1f6f55]" />
            </div>

            <div className="mt-4 space-y-3">
              {summaries.length ? (
                summaries.map((summary) => (
                  <Link className="block rounded-lg bg-[#f7faf8] p-3" href={`/meetings/${summary.meetingId}`} key={summary.meetingId}>
                    <p className="text-sm font-semibold text-[#111827]">{summary.title}</p>
                    <p className="mt-2 line-clamp-3 text-xs leading-5 text-[#667085]">{summary.text}</p>
                  </Link>
                ))
              ) : (
                <EmptyKnowledge>暂无可聚合的会议摘要。先生成正式纪要后，这里会显示项目摘要。</EmptyKnowledge>
              )}
            </div>
          </section>

          <KnowledgePanel title="决策汇总" icon={<CheckCircle2 className="h-4 w-4" />}>
            {decisions.length ? (
              decisions.map((decision) => (
                <Link className="block rounded-lg bg-[#f7faf8] p-3" href={`/meetings/${decision.meetingId}`} key={`${decision.meetingId}-${decision.id}`}>
                  <p className="text-sm font-semibold text-[#111827]">{decision.title}</p>
                  <p className="mt-1 text-xs leading-5 text-[#667085]">{decision.detail}</p>
                  <p className="mt-2 text-[11px] font-semibold text-[#1f6f55]">{decision.meetingTitle}</p>
                </Link>
              ))
            ) : (
              <EmptyKnowledge>暂无决策记录。</EmptyKnowledge>
            )}
          </KnowledgePanel>

          <KnowledgePanel title="待办汇总" icon={<ListChecks className="h-4 w-4" />}>
            {actions.length ? (
              actions.map((action) => (
                <Link className="block rounded-lg bg-[#f7faf8] p-3" href={`/meetings/${action.meetingId}`} key={`${action.meetingId}-${action.id}`}>
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <p className="text-sm font-semibold text-[#111827]">{action.task}</p>
                      <p className="mt-1 text-xs text-[#667085]">{action.owner}</p>
                    </div>
                    <span className="shrink-0 rounded-full bg-white px-2 py-1 text-[11px] font-semibold text-[#44515f]">{action.due}</span>
                  </div>
                  <p className="mt-2 text-[11px] font-semibold text-[#1f6f55]">{action.meetingTitle}</p>
                </Link>
              ))
            ) : (
              <EmptyKnowledge>暂无待办事项。</EmptyKnowledge>
            )}
          </KnowledgePanel>

          <section className="rounded-lg border border-[#e4e8e5] bg-white p-4 shadow-sm">
            <h2 className="text-base font-semibold text-[#111827]">可沉淀知识点</h2>
            <div className="mt-3 flex flex-wrap gap-2">
              {knowledgePoints.length ? (
                knowledgePoints.map((point) => (
                  <span className="rounded-full bg-[#eef6f1] px-3 py-2 text-xs font-semibold text-[#1f6f55]" key={point}>
                    {point}
                  </span>
                ))
              ) : (
                <span className="text-sm text-[#667085]">暂无知识点。</span>
              )}
            </div>
          </section>

          <MeetingHistoryPanel compact meetings={projectMeetings} />
        </div>

        <AppBottomNav active="meetings" />
      </div>
    </main>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-[#e1e8e2] bg-[#fbfcfb] px-2 py-3">
      <p className="text-[11px] font-medium text-[#66766e]">{label}</p>
      <p className="mt-1 text-lg font-semibold text-[#111827]">{value}</p>
    </div>
  );
}

function InfoTile({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="rounded-lg border border-[#e4e8e5] bg-white p-3 shadow-sm">
      <div className="text-[#1f6f55]">{icon}</div>
      <p className="mt-3 text-xs text-[#667085]">{label}</p>
      <p className="mt-1 truncate text-sm font-semibold">{value}</p>
    </div>
  );
}

function KnowledgePanel({ title, icon, children }: { title: string; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="rounded-lg border border-[#e4e8e5] bg-white p-4 shadow-sm">
      <div className="flex items-center gap-2">
        <span className="text-[#1f6f55]">{icon}</span>
        <h2 className="text-base font-semibold text-[#111827]">{title}</h2>
      </div>
      <div className="mt-3 space-y-3">{children}</div>
    </section>
  );
}

function EmptyKnowledge({ children }: { children: React.ReactNode }) {
  return <p className="rounded-lg bg-[#f7faf8] p-3 text-sm leading-6 text-[#667085]">{children}</p>;
}

function decodeProjectName(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
