import type { Metadata } from "next";
import type { ReactNode } from "react";
import { notFound, redirect } from "next/navigation";
import {
  ArrowLeft,
  CheckCircle2,
  ChevronDown,
  FileText,
  FolderKanban,
  Hash,
  Mic,
  PencilLine,
  Share2,
  ShieldCheck,
  UsersRound,
} from "lucide-react";
import Link from "next/link";
import { AppBottomNav } from "@/components/app-bottom-nav";
import { MeetingDetailActions } from "@/components/meeting-detail-actions";
import { MeetingMetadataEditor } from "@/components/meeting-metadata-editor";
import { MeetingSpeakerEditor } from "@/components/meeting-speaker-editor";
import { MeetingSummaryEditor } from "@/components/meeting-summary-editor";
import { MeetingTranscriptSpeakerEditor } from "@/components/meeting-transcript-speaker-editor";
import { applyMeetingMetadataToMarkdown } from "@/lib/meeting-markdown";
import { applyMeetingResultQualityNotice, assessMeetingResultQuality } from "@/lib/meeting-result-quality";
import { getCurrentUser } from "@/lib/server/current-user";
import { isMeetingShareActive, MeetingAccessError, readUserMeetingDetail } from "@/lib/server/meeting-audio-store";

export const metadata: Metadata = {
  title: "会议详情 - OwnMinutes",
};

export const dynamic = "force-dynamic";

export default async function MeetingDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  let detail;
  try {
    detail = await readUserMeetingDetail(id, user.id);
  } catch (error) {
    if (error instanceof MeetingAccessError && error.status === 404) notFound();
    if (error instanceof MeetingAccessError) redirect("/meetings");
    throw error;
  }

  const result = detail.result;
  const isPublic = isMeetingShareActive(detail.share);
  const actionCount = result?.summary.actionItems.length ?? 0;
  const summaryStatus = getSummaryStatus(detail.processing, Boolean(result), qualityStatusForDetail(detail.qualityStatus), detail.humanReview);
  const projectLabel = detail.metadata.project || "未归档";
  const quality = assessMeetingResultQuality(result);
  const rawMarkdown = detail.obsidianMarkdown || result?.obsidianMarkdown || null;
  const markdown = rawMarkdown ? applyMeetingResultQualityNotice(applyMeetingMetadataToMarkdown(rawMarkdown, detail.metadata), result) : null;
  const speakers = result
    ? Array.from(new Set([...result.transcript.map((segment) => segment.speaker), ...result.summary.speakerViews.map((item) => item.speaker)].filter((speaker) => speaker && speaker !== "System")))
    : [];

  return (
    <main className="min-h-screen bg-[#e8ecf1] text-[#111827] sm:py-5">
      <div className="ownminutes-mobile-shell relative mx-auto min-h-screen w-full max-w-[430px] bg-[#f8f7f3] pb-24 shadow-[0_24px_70px_rgba(15,23,42,0.12)] sm:min-h-[860px] sm:overflow-hidden sm:rounded-[28px] sm:border sm:border-[#d8dde4]">
        <header className="sticky top-0 z-20 border-b border-[#e6e0d4] bg-[#f8f7f3]/95 px-5 pb-3 pt-4 backdrop-blur">
          <div className="flex items-center justify-between gap-3">
            <Link className="app-icon-button" href="/meetings" title="返回会议">
              <ArrowLeft className="h-4 w-4" />
            </Link>
            <div className="min-w-0 flex-1">
              <h1 className="truncate text-xl font-semibold text-[#111827]">会议详情</h1>
            </div>
            <Link className="app-icon-button app-icon-button-dark" href="/app" title="新会议">
              <Mic className="h-4 w-4" />
            </Link>
          </div>
        </header>

        <div className="space-y-3 px-4 py-3" data-meeting-detail-ui="progressive-v30">
          <section className="border-y border-[#e1e8e3] bg-white px-4 py-4" data-meeting-detail-section="summary">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <h2 className="line-clamp-2 text-xl font-semibold leading-7 text-[#111827]">{detail.title}</h2>
                <p className="mt-1 text-sm leading-6 text-[#667085]">{summaryStatus}</p>
              </div>
              <span className={`shrink-0 rounded-full px-3 py-1 text-xs font-semibold ${isPublic ? "bg-[#effaf3] text-[#1f6f55]" : "bg-[#f2f5f1] text-[#667085]"}`}>
                {isPublic ? "已公开" : "私密"}
              </span>
            </div>

            <div className="mt-4 grid grid-cols-3 divide-x divide-[#edf1ee] border-y border-[#edf1ee] py-3 text-center">
              <Metric label="时长" value={formatDuration(detail.durationMs)} />
              <Metric label="转写" value={`${detail.transcriptCount}`} />
              <Metric label="待办" value={`${actionCount}`} />
            </div>

            <div className="mt-3">
              <div className="flex items-center gap-2 text-xs text-[#667085]">
                <FolderKanban className="h-3.5 w-3.5" />
                <span>{projectLabel}</span>
              </div>
              {detail.metadata.tags.length ? (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {detail.metadata.tags.map((tag) => (
                    <span key={tag} className="inline-flex items-center gap-1 rounded-full bg-[#edf5f0] px-2 py-1 text-[11px] font-semibold text-[#1f6f55]">
                      <Hash className="h-3 w-3" />
                      {tag}
                    </span>
                  ))}
                </div>
              ) : null}
            </div>
          </section>

          {result ? (
            <>
              {quality.status !== "verified" ? (
                <section className="border-y border-[#ead28b] bg-[#fff9e8] px-4 py-3" data-meeting-quality="unverified">
                  <p className="text-sm font-semibold text-[#76530a]">结果需要人工复核</p>
                  <p className="mt-1 text-xs leading-5 text-[#7a5a18]">{quality.shareWarningDetail}</p>
                </section>
              ) : null}

              <section className="border-y border-[#e1e8e3] bg-white px-4 py-4" data-meeting-primary-notes="summary-decisions-actions">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h2 className="text-base font-semibold">会议纪要</h2>
                    <p className="mt-1 text-xs text-[#667085]">先确认摘要、决策和待办。</p>
                  </div>
                  <FileText className="h-5 w-5 text-[#1f6f55]" />
                </div>
                <div className="mt-4 space-y-5">
                  <Block title="摘要">
                    <p>{result.summary.summary}</p>
                  </Block>
                  <Block title="决策记录">
                    {result.summary.decisions.length ? result.summary.decisions.map((decision) => (
                      <div key={decision.id} className="border-l-2 border-[#1f6f55] py-1 pl-3">
                        <p className="text-sm font-semibold">{decision.title}</p>
                        <p className="mt-1 text-xs leading-5 text-[#667085]">{decision.detail}</p>
                      </div>
                    )) : <EmptyText>暂无决策记录。</EmptyText>}
                  </Block>
                  <Block title="待办事项">
                    {result.summary.actionItems.length ? result.summary.actionItems.map((item) => (
                      <div key={item.id} className="flex items-start gap-3 border-b border-[#edf1ee] py-2 last:border-b-0">
                        <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-[#1f6f55]" />
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-semibold">{item.task}</p>
                          <p className="mt-1 text-xs text-[#667085]">{item.owner} · {item.due}</p>
                        </div>
                      </div>
                    )) : <EmptyText>暂无待办事项。</EmptyText>}
                  </Block>
                  <details className="group border-t border-[#edf1ee] pt-3" data-meeting-notes-more="true">
                    <summary className="flex cursor-pointer list-none items-center justify-between text-sm font-semibold text-[#1f6f55] [&::-webkit-details-marker]:hidden">
                      更多纪要内容
                      <ChevronDown className="h-4 w-4 transition-transform group-open:rotate-180" />
                    </summary>
                    <div className="mt-4 space-y-5">
                      <ListBlock title="关键主题" items={result.summary.topics} />
                      <SpeakerViewsBlock items={result.summary.speakerViews} />
                      <ListBlock title="风险与阻塞" items={result.summary.risks} />
                      <ListBlock title="未解决问题" items={result.summary.openQuestions} />
                      <ListBlock title="可沉淀知识点" items={result.summary.knowledgePoints} />
                    </div>
                  </details>
                </div>
              </section>

              <DetailDisclosure detail={isPublic ? "已公开，可管理链接与导出" : "私密，可发布链接或导出 Markdown"} icon={<Share2 className="h-5 w-5" />} id="share" title="分享与知识库">
                <MeetingDetailActions embedded hasResult humanReview={detail.humanReview} meetingId={detail.meetingId} meetingTitle={detail.title} markdown={markdown} processing={detail.processing} quality={quality} share={detail.share} />
              </DetailDisclosure>

              <DetailDisclosure detail={`${projectLabel} · ${detail.metadata.tags.length} 个标签`} icon={<FolderKanban className="h-5 w-5" />} id="archive" title="项目与标签">
                <MeetingMetadataEditor embedded meetingId={detail.meetingId} metadata={detail.metadata} title={detail.title} />
              </DetailDisclosure>

              {speakers.length ? (
                <DetailDisclosure detail={`${speakers.length} 个发言人标签，发布前请确认`} icon={<UsersRound className="h-5 w-5" />} id="speakers" title="校正发言人">
                  <MeetingSpeakerEditor embedded meetingId={detail.meetingId} speakers={speakers} />
                </DetailDisclosure>
              ) : null}

              <DetailDisclosure detail="修改摘要、决策、待办和知识点" icon={<PencilLine className="h-5 w-5" />} id="edit" title="编辑会议纪要">
                <MeetingSummaryEditor embedded meetingId={detail.meetingId} summary={result.summary} />
              </DetailDisclosure>

              <DetailDisclosure detail={`${result.transcript.length} 条 · ${detail.share.includeTranscript ? "分享页公开" : "分享页隐藏"}`} icon={<FileText className="h-5 w-5" />} id="transcript" title="逐字稿">
                <MeetingTranscriptSpeakerEditor
                  key={detail.meetingId}
                  meetingId={detail.meetingId}
                  speakers={speakers}
                  transcript={result.transcript}
                />
              </DetailDisclosure>

              <DetailDisclosure detail="检查纪要、分享、Markdown 和项目归档" icon={<ShieldCheck className="h-5 w-5" />} id="output" title="会后输出状态">
                <OutputStatusPanel embedded hasMarkdown={Boolean(markdown)} hasResult isPublic={isPublic} projectLabel={projectLabel} qualityStatus={quality.status} transcriptShared={detail.share.includeTranscript} />
              </DetailDisclosure>
            </>
          ) : (
            <section className="border-y border-[#e1e8e3] bg-white px-4 py-4">
              <h2 className="text-base font-semibold">会议结果尚未生成</h2>
              <p className="mt-2 text-sm leading-6 text-[#667085]">音频已经保存。请回到工作台结束会议并生成纪要后，再进入详情页查看完整内容。</p>
              <div className="mt-4"><MeetingDetailActions embedded hasResult={false} humanReview={detail.humanReview} meetingId={detail.meetingId} meetingTitle={detail.title} markdown={markdown} processing={detail.processing} quality={quality} share={detail.share} /></div>
            </section>
          )}
        </div>

        <AppBottomNav active="meetings" />
      </div>
    </main>
  );
}

function qualityStatusForDetail(value: "verified" | "unverified") {
  return value;
}

function getSummaryStatus(
  processing: { status: "queued" | "processing" | "completed" | "failed"; attempt: number } | null,
  hasResult: boolean,
  qualityStatus: "verified" | "unverified",
  humanReview: { status: "pending" | "confirmed"; needsReconfirmation: boolean },
) {
  if (hasResult && humanReview.status !== "confirmed") return humanReview.needsReconfirmation ? "内容已变化，请重新人工确认" : "纪要已生成，待人工确认";
  if (hasResult) return qualityStatus === "verified" ? "纪要已人工确认" : "未验证纪要已人工确认";
  if (processing?.status === "queued") return processing.attempt > 0 ? `正式纪要等待重试（第 ${processing.attempt} 次）` : "正式纪要已排队";
  if (processing?.status === "processing") return `正式纪要处理中（第 ${processing.attempt} 次）`;
  if (processing?.status === "failed") return "纪要处理失败，音频仍已保存，可重新生成";
  return "等待生成正式纪要";
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 px-2">
      <p className="text-[11px] font-medium text-[#66766e]">{label}</p>
      <p className="mt-1 truncate text-sm font-semibold text-[#111827]">{value}</p>
    </div>
  );
}

function DetailDisclosure({ children, detail, icon, id, title }: { children: ReactNode; detail: string; icon: ReactNode; id: string; title: string }) {
  return (
    <details className="group border-y border-[#e1e8e3] bg-white" data-meeting-disclosure={id}>
      <summary className="flex min-h-16 cursor-pointer list-none items-center gap-3 px-4 py-3 [&::-webkit-details-marker]:hidden">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[#eef6f1] text-[#1f6f55]">{icon}</span>
        <span className="min-w-0 flex-1">
          <strong className="block text-sm text-[#111827]">{title}</strong>
          <span className="mt-1 block truncate text-xs leading-5 text-[#667085]" title={detail}>{detail}</span>
        </span>
        <ChevronDown className="h-5 w-5 shrink-0 text-[#7a8981] transition-transform group-open:rotate-180" />
      </summary>
      <div className="border-t border-[#edf1ee] px-4 py-4">{children}</div>
    </details>
  );
}

function OutputStatusPanel({
  embedded = false,
  hasMarkdown,
  hasResult,
  isPublic,
  projectLabel,
  qualityStatus,
  transcriptShared,
}: {
  embedded?: boolean;
  hasMarkdown: boolean;
  hasResult: boolean;
  isPublic: boolean;
  projectLabel: string;
  qualityStatus: "verified" | "unverified";
  transcriptShared: boolean;
}) {
  const items = [
    {
      label: "正式纪要",
      detail: hasResult ? "摘要、决策、待办和逐字稿已生成。" : "结束会议并生成纪要后可验收。",
      ready: hasResult,
    },
    {
      label: "分享链接",
      detail: isPublic ? (transcriptShared ? "分享页公开，逐字稿也公开。" : "分享页公开，逐字稿默认隐藏。") : "发布后可给外部查看。",
      ready: isPublic,
    },
    {
      label: "结果质量",
      detail: qualityStatus === "verified" ? "结果已通过质量判断，可作为正式纪要继续验收。" : "当前结果尚未通过正式识别验收，导出和知识库会带质量提示。",
      ready: qualityStatus === "verified",
    },
    {
      label: "Obsidian Markdown",
      detail: hasMarkdown ? "可下载或复制到知识库。" : "生成正式纪要后输出 Markdown。",
      ready: hasMarkdown,
    },
    {
      label: "项目归档",
      detail: projectLabel === "未归档" ? "建议补项目名，便于形成长期知识库。" : `已归档到 ${projectLabel}。`,
      ready: projectLabel !== "未归档",
    },
  ];

  return (
    <section className={embedded ? "" : "rounded-lg border border-[#d9eadf] bg-white p-4 shadow-sm"}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-[#111827]">会后输出状态</h2>
          <p className="mt-1 text-sm leading-6 text-[#667085]">最终验收重点看这四项是否能跑通。</p>
        </div>
        <CheckCircle2 className="h-5 w-5 shrink-0 text-[#1f6f55]" />
      </div>
      <div className="mt-4 grid gap-2">
        {items.map((item) => (
          <div key={item.label} className="rounded-lg border border-[#e6ece8] bg-[#fbfdfb] p-3">
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm font-semibold text-[#111827]">{item.label}</p>
              <span className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${item.ready ? "bg-[#effaf3] text-[#1f6f55]" : "bg-[#fff8e6] text-[#946200]"}`}>
                {item.ready ? "已就绪" : "待处理"}
              </span>
            </div>
            <p className="mt-2 text-xs leading-5 text-[#667085]">{item.detail}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

function EmptyText({ children }: { children: ReactNode }) {
  return <p className="rounded-lg bg-[#f7faf8] p-3 text-sm text-[#667085]">{children}</p>;
}

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h3 className="text-sm font-semibold text-[#111827]">{title}</h3>
      <div className="mt-2 text-sm leading-7 text-[#344054]">{children}</div>
    </section>
  );
}

function ListBlock({ title, items }: { title: string; items: string[] }) {
  if (!items.length) return null;

  return (
    <Block title={title}>
      <ul className="space-y-2">
        {items.map((item) => (
          <li key={item} className="rounded-lg bg-[#f7faf8] px-3 py-2">
            {item}
          </li>
        ))}
      </ul>
    </Block>
  );
}

function SpeakerViewsBlock({ items }: { items: Array<{ speaker: string; view: string }> }) {
  return (
    <Block title="发言人观点">
      {items.length ? (
        <div className="space-y-2">
          {items.map((item, index) => (
            <div key={`${item.speaker}-${index}`} className="rounded-lg bg-[#f7faf8] p-3">
              <div className="flex items-center gap-2 text-sm font-semibold text-[#1f6f55]">
                <UsersRound className="h-4 w-4" />
                {item.speaker}
              </div>
              <p className="mt-1 text-sm leading-6 text-[#475467]">{item.view}</p>
            </div>
          ))}
        </div>
      ) : (
        <EmptyText>暂无发言人观点。</EmptyText>
      )}
    </Block>
  );
}

function formatDuration(durationMs: number) {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}
