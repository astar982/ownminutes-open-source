import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { ArrowLeft, CalendarClock, FolderKanban, Mic } from "lucide-react";
import Link from "next/link";
import { AppBottomNav } from "@/components/app-bottom-nav";
import { buildProjectSummaries } from "@/lib/project-summaries";
import { getCurrentUser } from "@/lib/server/current-user";
import { listUserMeetings } from "@/lib/server/meeting-audio-store";

export const metadata: Metadata = {
  title: "项目 - OwnMinutes",
};

export const dynamic = "force-dynamic";

export default async function ProjectsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const meetings = await listUserMeetings(user.id);
  const projects = buildProjectSummaries(meetings);
  const completedProjects = projects.filter((project) => project.completedCount > 0).length;

  return (
    <main className="min-h-screen bg-[#e8ecf1] text-[#121417] sm:py-5">
      <div className="ownminutes-mobile-shell relative mx-auto min-h-screen w-full max-w-[430px] bg-[#f8f7f3] pb-24 shadow-[0_24px_70px_rgba(15,23,42,0.12)] sm:min-h-[860px] sm:overflow-hidden sm:rounded-[28px] sm:border sm:border-[#d8dde4]">
        <header className="sticky top-0 z-20 border-b border-[#e6e0d4] bg-[#f8f7f3]/95 px-5 pb-3 pt-4 backdrop-blur">
          <div className="flex items-center justify-between gap-3">
            <Link className="app-icon-button" href="/meetings" title="返回会议">
              <ArrowLeft className="h-4 w-4" />
            </Link>
            <div className="min-w-0 flex-1">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#738078]">Projects</p>
              <h1 className="mt-1 truncate text-xl font-semibold text-[#111827]">项目目录</h1>
            </div>
            <Link className="app-icon-button app-icon-button-dark" href="/app" title="新会议">
              <Mic className="h-4 w-4" />
            </Link>
          </div>
        </header>

        <div className="space-y-4 px-4 py-4">
          <section className="rounded-lg border border-[#e2ddd2] bg-white p-4 shadow-[0_18px_45px_rgba(15,23,42,0.08)]">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-sm text-[#667085]">知识沉淀</p>
                <h2 className="mt-1 text-2xl font-semibold leading-tight text-[#111827]">按项目管理会议记录。</h2>
              </div>
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[#edf5f0] text-[#157a5a]">
                <FolderKanban className="h-5 w-5" />
              </span>
            </div>
            <p className="mt-4 text-sm leading-6 text-[#667085]">项目会同步到会议详情和 Obsidian Markdown，适合沉淀长期事项、客户项目和产品讨论。</p>

            <div className="mt-5 grid grid-cols-3 gap-2 text-center">
              <Metric label="项目" value={String(projects.length)} />
              <Metric label="有纪要" value={String(completedProjects)} />
              <Metric label="会议" value={String(meetings.length)} />
            </div>
          </section>

          <section className="rounded-lg border border-[#e4e8e5] bg-white p-4 shadow-sm">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h2 className="text-base font-semibold">全部项目</h2>
                <p className="mt-1 text-sm text-[#667085]">{projects.length ? "进入项目后查看关联会议。" : "先在会议详情里设置项目名称。"}</p>
              </div>
              <Link className="text-sm font-semibold text-[#1f6f55]" href="/meetings">
                全部会议
              </Link>
            </div>

            <div className="mt-4 space-y-3">
              {projects.length ? (
                projects.map((project) => (
                  <Link
                    className="block rounded-lg border border-[#e7ece8] bg-[#fbfcfb] p-4 hover:border-[#b9d8c9] hover:bg-[#f6fbf8]"
                    href={`/projects/${encodeURIComponent(project.name)}`}
                    key={project.name}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <h3 className="truncate text-base font-semibold text-[#111827]">{project.name}</h3>
                        <p className="mt-1 flex items-center gap-1.5 text-xs text-[#667085]">
                          <CalendarClock className="h-3.5 w-3.5" />
                          {formatDate(project.lastUpdated)}
                        </p>
                      </div>
                      <span className="rounded-full bg-[#eef6f1] px-2.5 py-1 text-xs font-semibold text-[#1f6f55]">{project.meetingCount} 场</span>
                    </div>

                    <div className="mt-3 grid grid-cols-3 gap-2 text-center">
                      <SmallMetric label="纪要" value={String(project.completedCount)} />
                      <SmallMetric label="分享" value={String(project.publicCount)} />
                      <SmallMetric label="标签" value={String(project.tags.length)} />
                    </div>

                    {project.tags.length ? (
                      <div className="mt-3 flex flex-wrap gap-1.5">
                        {project.tags.slice(0, 6).map((tag) => (
                          <span key={tag} className="rounded-full bg-[#f2f5f1] px-2 py-1 text-[11px] font-semibold text-[#667085]">
                            #{tag}
                          </span>
                        ))}
                      </div>
                    ) : null}
                  </Link>
                ))
              ) : (
                <div className="rounded-lg border border-dashed border-[#ccd3ce] p-5 text-sm leading-6 text-[#667085]">
                  还没有项目。打开任意会议详情，在“项目归档”里填写项目名后，这里会自动生成项目目录。
                </div>
              )}
            </div>
          </section>
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

function SmallMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-white px-2 py-2">
      <p className="text-[11px] text-[#98a2b3]">{label}</p>
      <p className="mt-1 text-sm font-semibold text-[#111827]">{value}</p>
    </div>
  );
}

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "时间未知";
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}
