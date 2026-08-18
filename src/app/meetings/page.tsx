import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { FolderKanban, Mic } from "lucide-react";
import Link from "next/link";
import { AppBottomNav } from "@/components/app-bottom-nav";
import { MeetingHistoryPanel } from "@/components/meeting-history-panel";
import { getCurrentUser } from "@/lib/server/current-user";
import { isMeetingShareActive, listUserMeetings } from "@/lib/server/meeting-audio-store";

export const metadata: Metadata = {
  title: "会议 - OwnMinutes",
};

export const dynamic = "force-dynamic";

export default async function MeetingsPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const params = searchParams ? await searchParams : {};
  const initialProject = typeof params.project === "string" ? params.project : "";
  const meetings = await listUserMeetings(user.id);
  const completedCount = meetings.filter((meeting) => meeting.hasResult).length;
  const publicCount = meetings.filter((meeting) => isMeetingShareActive(meeting.share)).length;
  const projectCount = new Set(meetings.map((meeting) => meeting.metadata.project || "未归档")).size;

  return (
    <main className="min-h-screen bg-[#e8ecf1] text-[#121417] sm:py-5">
      <div className="ownminutes-mobile-shell mx-auto min-h-screen w-full max-w-[430px] bg-[#f8f7f3] pb-24 shadow-[0_24px_70px_rgba(15,23,42,0.12)] sm:min-h-[860px] sm:overflow-hidden sm:rounded-[28px] sm:border sm:border-[#d8dde4]">
        <header className="sticky top-0 z-20 border-b border-[#e6e0d4] bg-[#f8f7f3]/95 px-5 pb-3 pt-5 backdrop-blur" data-primary-tab-header="meetings">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0 flex-1">
              <h1 className="truncate text-2xl font-semibold text-[#111827]">会议记录</h1>
            </div>
            <Link className="app-icon-button app-icon-button-dark" href="/app" title="新会议">
              <Mic className="h-4 w-4" />
            </Link>
          </div>
        </header>

        <div className="space-y-3 px-4 py-3">
          {meetings.length ? <section className="border-y border-[#e1e8e3] bg-white px-4 py-3" data-meetings-summary="compact-v30">
            <div className="grid grid-cols-3 divide-x divide-[#edf1ee] py-1 text-center">
              <Metric label="全部" value={String(meetings.length)} />
              <Metric label="已生成" value={String(completedCount)} />
              <Metric label="已分享" value={String(publicCount)} />
            </div>

            <Link className="mt-3 flex min-h-11 items-center justify-between border-t border-[#edf1ee] pt-3 text-sm font-semibold text-[#1d342a]" href="/projects">
              <span className="inline-flex items-center gap-2">
                <FolderKanban className="h-4 w-4 text-[#157a5a]" />
                按项目查看
              </span>
              <span className="text-[#667085]">{projectCount} 个</span>
            </Link>
          </section> : null}

          <MeetingHistoryPanel meetings={meetings} compact initialProject={initialProject} />
        </div>

        <AppBottomNav active="meetings" />
      </div>
    </main>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 px-2 py-1">
      <p className="text-[11px] font-medium text-[#66766e]">{label}</p>
      <p className="mt-1 text-lg font-semibold text-[#111827]">{value}</p>
    </div>
  );
}
