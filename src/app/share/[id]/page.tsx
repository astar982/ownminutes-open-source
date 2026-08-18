import { BookOpenCheck, CheckCircle2, Clock3, Download, FileText, Link2, ListChecks, ShieldCheck, UsersRound } from "lucide-react";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { SharePageActions } from "@/components/share-page-actions";
import { formatDuration } from "@/lib/meeting";
import { assessMeetingResultQuality } from "@/lib/meeting-result-quality";
import { resolveMeetingSharePresentation } from "@/lib/meeting-share-presentation";
import { getCurrentUser } from "@/lib/server/current-user";
import { isMeetingShareActive, readMeetingShareSnapshot } from "@/lib/server/meeting-audio-store";
import { recordMeetingShareViewBestEffort } from "@/lib/server/meeting-share-analytics";
import { isCanonicalMeetingId } from "@/lib/server/meeting-write-lock";

type SharePageProps = {
  params: Promise<{ id: string }>;
};

export async function generateMetadata({ params }: SharePageProps): Promise<Metadata> {
  const { id } = await params;
  if (!isCanonicalMeetingId(id)) return privateShareMetadata();
  const { access, result } = await readMeetingShareSnapshot(id);
  const isDemo = id === "demo-meeting";

  if ((!access.exists && !isDemo) || (access.exists && (!isMeetingShareActive(access.share) || access.humanReview.status !== "confirmed"))) {
    return privateShareMetadata();
  }

  const title = isDemo ? "OwnMinutes 产品方案讨论" : result?.title || "会议纪要";
  const description = truncateDescription(
    isDemo
      ? "这是一份 OwnMinutes 产品演示会议纪要。"
      : result?.summary.summary || "这是一份由 OwnMinutes 生成并经会议所有者确认的公开会议纪要。",
  );

  return {
    title: `${title} - OwnMinutes 会议纪要`,
    description,
    openGraph: {
      title: `${title} - OwnMinutes 会议纪要`,
      description,
      type: "article",
    },
    twitter: {
      card: "summary",
      title: `${title} - OwnMinutes 会议纪要`,
      description,
    },
  };
}

export default async function SharePage({ params }: SharePageProps) {
  const { id } = await params;
  if (!isCanonicalMeetingId(id)) notFound();
  const user = await getCurrentUser();
  const { access, durationMs, result } = await readMeetingShareSnapshot(id);
  const canViewPrivate = Boolean(access.ownerUserId && user?.id === access.ownerUserId);
  const isPublic = isMeetingShareActive(access.share) && access.humanReview.status === "confirmed";
  const isDemo = id === "demo-meeting";

  if (!access.exists && !isDemo) {
    return <PrivateShareNotice id={id} />;
  }

  if (!isPublic && !canViewPrivate && access.hasChunks) {
    return <PrivateShareNotice id={id} />;
  }

  if (isPublic && !isDemo) {
    // Access truth was established by the snapshot above. Analytics is
    // intentionally best-effort and cannot turn a readable share into a 500.
    await recordMeetingShareViewBestEffort(id);
  }

  const { actions, decisions, displayDurationMs, speakerViews, summary, title, transcript } =
    resolveMeetingSharePresentation({ durationMs, isDemo, result });
  const quality = assessMeetingResultQuality(result);
  const canShowTranscript = access.share.includeTranscript || canViewPrivate || isDemo;
  const exportHref = isPublic ? `/api/share/${id}/markdown` : `/api/meetings/${id}/export`;

  return (
    <main className="min-h-screen bg-[#e8ecf1] text-[#171713] sm:py-5">
      <div className="ownminutes-mobile-shell mx-auto min-h-screen w-full max-w-[430px] bg-[#f8f7f3] shadow-[0_28px_90px_rgba(23,31,27,0.12)] sm:min-h-[860px] sm:overflow-hidden sm:rounded-[28px] sm:border sm:border-[#d8dde4]">
        <div className="px-4 pb-8 pt-4">
          <header className="overflow-hidden rounded-lg border border-[#e2ddd2] bg-white p-4 shadow-[0_18px_45px_rgba(15,23,42,0.08)]">
            <div className="flex items-center justify-between gap-3">
              <p className="inline-flex min-w-0 items-center gap-2 text-xs font-semibold text-[#667085]">
                <Link2 className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate font-mono">share/{id}</span>
              </p>
              <span className={`rounded-full px-3 py-1.5 text-xs font-semibold ${isPublic ? "bg-[#effaf3] text-[#1f6f55]" : "bg-[#f2f5f1] text-[#667085]"}`}>
                {isPublic ? quality.publishLabel : "私密预览"}
              </span>
            </div>

            <h1 className="mt-5 text-[26px] font-semibold leading-8 tracking-normal text-[#111827]">{title}</h1>
            <p className="mt-3 text-sm leading-6 text-[#667085]">
              {isPublic ? "这是一份公开分享的会议纪要。" : "这是会议所有者预览的私密会议纪要。发布后，拥有链接的人可查看公开内容。"}
            </p>

            <div className="mt-5 grid grid-cols-3 gap-2">
              <Metric icon={<Clock3 className="h-4 w-4" />} label="时长" value={formatDuration(Math.round(displayDurationMs / 1000))} />
              <Metric icon={<FileText className="h-4 w-4" />} label="转写" value={`${transcript.length} 条`} />
              <Metric icon={<CheckCircle2 className="h-4 w-4" />} label="决策" value={`${decisions.length} 个`} />
            </div>

            <SharePageActions exportHref={exportHref} isPublic={isPublic} />

            {isPublic ? (
              <a
                className="mt-3 inline-flex min-h-11 w-full items-center justify-center rounded-lg bg-[#175743] px-4 text-sm font-semibold text-white hover:bg-[#123f32]"
                href={`/register?source=share&shareId=${encodeURIComponent(id)}`}
              >
                免费注册，记录我的会议
              </a>
            ) : null}
          </header>

          <div className="mt-4 space-y-4">
            {quality.status !== "verified" ? (
              <section className="rounded-lg border border-[#f5c2b8] bg-[#fff5f2] p-4 shadow-[0_14px_34px_rgba(127,29,29,0.08)]">
                <div className="flex items-start gap-3">
                    <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-white text-[#b42318]">
                    <ShieldCheck className="h-5 w-5" />
                  </span>
                  <div className="min-w-0">
                    <h2 className="text-base font-semibold text-[#7a271a]">{quality.shareWarningTitle}</h2>
                    <p className="mt-1 text-sm leading-6 text-[#9f3f2d]">{quality.shareWarningDetail}</p>
                  </div>
                </div>
              </section>
            ) : null}

            <section className="rounded-lg border border-[#e2ddd2] bg-white p-4 shadow-sm">
              <SectionTitle icon={<BookOpenCheck className="h-4 w-4" />}>会议摘要</SectionTitle>
              <div className="mt-3 space-y-3 text-[15px] leading-7 text-[#29251d]">
                {summary ? (
                  <p>{summary}</p>
                ) : isDemo ? (
                  <>
                    <p>
                      本次会议确认 OwnMinutes 第一版采用实时会议记录器形态：用户点击开始录音后，系统实时记录转写草稿和阶段摘要；会议结束后再基于完整音频生成正式纪要。
                    </p>
                    <p>
                      产品边界明确为会议内容沉淀系统，不在第一版追求完整会议软件能力。核心输出包括详细纪要、分享链接和结构化 Obsidian Markdown。
                    </p>
                  </>
                ) : (
                  <EmptyShareState>本次会议暂无摘要。</EmptyShareState>
                )}
              </div>
            </section>

            {speakerViews.length ? (
              <section className="rounded-lg border border-[#e2ddd2] bg-white p-4 shadow-sm">
                <SectionTitle icon={<UsersRound className="h-4 w-4" />}>发言人观点</SectionTitle>
                <div className="mt-3 space-y-2.5">
                  {speakerViews.map((item, index) => (
                    <article key={`${item.speaker}-${index}`} className="rounded-lg bg-[#f7faf8] p-3.5">
                      <h3 className="text-sm font-semibold text-[#1f6f55]">{item.speaker}</h3>
                      <p className="mt-1 text-sm leading-6 text-[#5f6b63]">{item.view}</p>
                    </article>
                  ))}
                </div>
              </section>
            ) : null}

            <section className="rounded-lg border border-[#e2ddd2] bg-white p-4 shadow-sm">
              <SectionTitle icon={<CheckCircle2 className="h-4 w-4" />}>决策记录</SectionTitle>
              <div className="mt-3 space-y-2.5">
                {decisions.length ? (
                  decisions.map((decision) => (
                    <article key={decision.id} className="rounded-lg bg-[#f7faf8] p-3.5">
                      <h3 className="text-sm font-semibold text-[#111827]">{decision.title}</h3>
                      <p className="mt-1 text-sm leading-6 text-[#5f6b63]">{decision.detail}</p>
                    </article>
                  ))
                ) : (
                  <EmptyShareState>本次会议没有记录需要公开的决策。</EmptyShareState>
                )}
              </div>
            </section>

            <section className="rounded-lg border border-[#e2ddd2] bg-white p-4 shadow-sm">
              <SectionTitle icon={<ListChecks className="h-4 w-4" />}>待办事项</SectionTitle>
              <div className="mt-3 space-y-2.5">
                {actions.length ? (
                  actions.map((item) => (
                    <article key={item.id} className="rounded-lg border border-[#e4e8e3] bg-white p-3.5">
                      <p className="text-sm font-semibold text-[#111827]">{item.task}</p>
                      <p className="mt-1 text-xs text-[#6f756e]">
                        {item.owner} / {item.due}
                      </p>
                    </article>
                  ))
                ) : (
                  <EmptyShareState>本次会议没有记录需要公开的待办。</EmptyShareState>
                )}
              </div>
            </section>

            {canShowTranscript ? (
              <section className="rounded-lg border border-[#e2ddd2] bg-white p-4 shadow-sm">
                <div className="flex items-center justify-between gap-3">
                  <SectionTitle icon={<FileText className="h-4 w-4" />}>{isPublic ? "公开逐字稿" : "逐字稿预览"}</SectionTitle>
                  <a className="inline-flex h-9 items-center gap-2 rounded-full border border-[#d7ddd7] bg-white px-3 text-xs font-semibold text-[#344054]" href={exportHref}>
                    <Download className="h-4 w-4" />
                    导出
                  </a>
                </div>
                <div className="mt-3 space-y-2.5">
                  {transcript.length ? (
                    transcript.slice(0, 12).map((segment) => (
                      <article key={segment.id} className="rounded-lg bg-[#fbfaf6] p-3.5">
                        <div className="flex justify-between gap-3 text-sm">
                          <strong className="text-[#1f6f55]">{segment.speaker}</strong>
                          <span className="font-mono text-xs text-[#7b8580]">{segment.timestamp}</span>
                        </div>
                        <p className="mt-2 text-sm leading-6 text-[#29251d]">{segment.text}</p>
                      </article>
                    ))
                  ) : (
                    <EmptyShareState>本次会议暂无可公开的逐字稿。</EmptyShareState>
                  )}
                </div>
              </section>
            ) : (
              <section className="rounded-lg border border-[#e2ddd2] bg-white p-4 shadow-sm">
                <SectionTitle icon={<ShieldCheck className="h-4 w-4" />}>逐字稿未公开</SectionTitle>
                <p className="mt-2 text-sm leading-6 text-[#5f6b63]">会议所有者没有公开逐字稿。当前链接只展示摘要、发言人观点、决策和待办。</p>
              </section>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}

function privateShareMetadata(): Metadata {
  return {
    title: "会议纪要尚未公开 - OwnMinutes",
    description: "这份会议纪要尚未公开，或当前链接没有查看权限。",
    robots: {
      index: false,
      follow: false,
    },
    openGraph: {
      title: "会议纪要尚未公开 - OwnMinutes",
      description: "这份会议纪要尚未公开，或当前链接没有查看权限。",
      type: "article",
    },
  };
}

function PrivateShareNotice({ id }: { id: string }) {
  return (
    <main className="min-h-screen bg-[#e8ecf1] text-[#171713] sm:py-5">
      <div className="ownminutes-mobile-shell mx-auto flex min-h-screen w-full max-w-[430px] flex-col justify-center bg-[#f8f7f3] px-4 py-6 shadow-[0_28px_90px_rgba(23,31,27,0.12)] sm:min-h-[720px] sm:rounded-[28px] sm:border sm:border-[#d8dde4]">
        <section className="rounded-lg border border-[#e2ddd2] bg-white p-5 shadow-[0_18px_44px_rgba(23,31,27,0.08)]">
          <p className="inline-flex items-center gap-2 text-xs font-semibold text-[#6f756e]">
            <Link2 className="h-3.5 w-3.5" />
            <span className="font-mono">share/{id}</span>
          </p>
          <span className="mt-5 flex h-12 w-12 items-center justify-center rounded-lg bg-[#fff7e6] text-[#9a5b13]">
            <ShieldCheck className="h-6 w-6" />
          </span>
          <h1 className="mt-4 text-2xl font-semibold leading-8 tracking-normal">这份会议纪要尚未公开</h1>
          <p className="mt-3 text-sm leading-6 text-[#5f6b63]">
            会议所有者还没有发布分享链接，或当前账号没有查看权限。请让会议所有者在 OwnMinutes 工作台中发布分享。
          </p>
        </section>
      </div>
    </main>
  );
}

function Metric({ icon, label, value }: { icon: ReactNode; label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-lg border border-[#e1e8e2] bg-[#fbfcfb] px-3 py-2.5 text-[#111827]">
      <div className="flex items-center gap-1.5 text-[#66766e]">
        {icon}
        <span className="text-[11px] font-medium">{label}</span>
      </div>
      <p className="mt-1 truncate text-sm font-semibold" title={value}>
        {value}
      </p>
    </div>
  );
}

function SectionTitle({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <div className="flex items-center gap-2 text-base font-semibold text-[#111827]">
      <span className="text-[#1f6f55]">{icon}</span>
      {children}
    </div>
  );
}

function EmptyShareState({ children }: { children: ReactNode }) {
  return <p className="rounded-lg bg-[#f7faf8] px-3.5 py-3 text-sm leading-6 text-[#667085]">{children}</p>;
}

function truncateDescription(value: string) {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= 120) return normalized;
  return `${normalized.slice(0, 117)}...`;
}
