import type { Metadata } from "next";
import { redirect } from "next/navigation";
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  ClipboardCheck,
  ExternalLink,
  Link2,
  Settings2,
  ShieldCheck,
} from "lucide-react";
import Link from "next/link";
import { AppBottomNav } from "@/components/app-bottom-nav";
import { CheckupObsidianSaveButton } from "@/components/checkup-obsidian-save-button";
import {
  buildGoNoGoDecision,
  buildCriticalBlockerEvidenceTemplates,
  buildLaunchReadinessPacks,
  getReadinessStage,
  manualAcceptanceItems,
  type CriticalBlockerEvidenceTemplate,
  type GoNoGoDecision,
  type LaunchReadinessPack,
  type ManualAcceptanceItem,
} from "@/lib/checkup-acceptance";
import { buildProjectSummaries } from "@/lib/project-summaries";
import { getUserProviderHealth } from "@/lib/provider-health";
import { getReleaseReadinessReport, type ReleaseReadinessBlocker, type ReleaseReadinessItem } from "@/lib/release-readiness";
import { getRuntimeSecretDiagnostics } from "@/lib/secret-diagnostics";
import { getUserUsage, listProviderCredentials } from "@/lib/server/auth-repository";
import { getCurrentUser } from "@/lib/server/current-user";
import { isMeetingShareActive, listUserMeetings } from "@/lib/server/meeting-audio-store";

export const metadata: Metadata = {
  title: "验收中心 - OwnMinutes",
};

export const dynamic = "force-dynamic";

type CheckState = "done" | "pending" | "blocked";

type AcceptanceItem = {
  title: string;
  detail: string;
  href: string;
  action: string;
  state: CheckState;
};

export default async function CheckupPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (user.role !== "admin") redirect("/account");

  const [providerHealth, meetings, providerCredentials, usage, secretDiagnostics] = await Promise.all([
    getUserProviderHealth(user.id),
    listUserMeetings(user.id),
    listProviderCredentials(user.id),
    getUserUsage(user.id),
    getRuntimeSecretDiagnostics(),
  ]);
  const releaseReadiness = getReleaseReadinessReport(secretDiagnostics);
  const goNoGoDecision = buildGoNoGoDecision(releaseReadiness);
  const readinessStage = getReadinessStage(releaseReadiness.summary);
  const launchReadinessPacks = buildLaunchReadinessPacks(releaseReadiness);
  const blockerEvidenceTemplates = buildCriticalBlockerEvidenceTemplates(releaseReadiness);
  const projects = buildProjectSummaries(meetings);
  const completedMeetings = meetings.filter((meeting) => meeting.hasResult);
  const sharedMeetings = meetings.filter((meeting) => isMeetingShareActive(meeting.share));
  const hasFileAsr = providerHealth.some((item) => item.status === "ready" && item.canUseFor.includes("file_asr"));
  const hasSummary = providerHealth.some((item) => item.status === "ready" && item.canUseFor.includes("summary"));
  const blockedItems = releaseReadiness.blockers;
  const summaryModelBlocker = blockedItems.find((item) => item.id === "summary-model");
  const criticalBlockers = blockedItems.filter((item) => item.priority === "critical");
  const automationItems = releaseReadiness.groups.find((group) => group.id === "acceptance")?.items ?? [];
  const automationReadyCount = automationItems.filter((item) => item.status === "ready").length;
  const acceptanceItems: AcceptanceItem[] = [
    {
      title: "配置自己的模型",
      detail: hasFileAsr && hasSummary
        ? summaryModelBlocker
          ? "账号级会后识别和总结模型已有可用配置；生产 summary-model 仍以 release readiness 为准。"
          : "账号级会后识别和总结模型已有可用配置，生产 summary-model 门禁已通过。"
        : "至少需要一个会后 ASR 和一个账号级总结模型，才能开始验收真实会议质量；生产门禁仍以 release readiness 为准。",
      href: "/settings",
      action: "去配置",
      state: hasFileAsr && hasSummary ? "done" : providerCredentials.length > 0 ? "pending" : "blocked",
    },
    {
      title: "录制 1 分钟测试会议",
      detail: meetings.length > 0 ? `当前账号已有 ${meetings.length} 场会议。` : "先录一段真实语音，检查麦克风、计时、音量和分片同步。",
      href: "/app",
      action: "开始录音",
      state: meetings.length > 0 ? "done" : "pending",
    },
    {
      title: "生成正式会议纪要",
      detail: completedMeetings.length > 0 ? `已有 ${completedMeetings.length} 场会议生成纪要。` : "结束会议后需要看到摘要、决策、待办和 Markdown。",
      href: "/meetings",
      action: "看会议",
      state: completedMeetings.length > 0 ? "done" : meetings.length > 0 ? "pending" : "blocked",
    },
    {
      title: "发布分享链接",
      detail: sharedMeetings.length > 0 ? `已有 ${sharedMeetings.length} 场会议公开分享。` : "分享页默认公开摘要、决策和待办，逐字稿默认隐藏。",
      href: "/meetings",
      action: "去发布",
      state: sharedMeetings.length > 0 ? "done" : completedMeetings.length > 0 ? "pending" : "blocked",
    },
    {
      title: "沉淀到项目知识库",
      detail: projects.length > 0 ? `已形成 ${projects.length} 个项目目录，可导出项目级 Markdown。` : "给会议设置项目和标签后，项目目录会自动聚合。",
      href: "/projects",
      action: "看项目",
      state: projects.length > 0 ? "done" : completedMeetings.length > 0 ? "pending" : "blocked",
    },
    {
      title: "确认上线阻塞",
      detail: releaseReadiness.summary.blocked > 0 ? `仍有 ${releaseReadiness.summary.blocked} 个上线阻塞项。` : "当前 release readiness 没有阻塞项。",
      href: "/api/release/readiness",
      action: "看报告",
      state: releaseReadiness.summary.blocked > 0 ? "blocked" : "done",
    },
  ];
  const doneCount = acceptanceItems.filter((item) => item.state === "done").length;
  const pendingCount = acceptanceItems.filter((item) => item.state === "pending").length;
  const blockedCount = acceptanceItems.filter((item) => item.state === "blocked").length;
  const nextAcceptanceItem = acceptanceItems.find((item) => item.state !== "done");
  const nextReadinessItem = blockedItems[0] ?? releaseReadiness.groups.flatMap((group) => group.items).find((item) => item.status === "warning");

  return (
    <main className="min-h-screen bg-[#e8ecf1] text-[#121816] sm:py-5">
      <div className="ownminutes-mobile-shell relative mx-auto min-h-screen w-full max-w-[430px] bg-[#f8f7f3] pb-24 shadow-[0_24px_70px_rgba(15,23,42,0.12)] sm:min-h-[860px] sm:overflow-hidden sm:rounded-[28px] sm:border sm:border-[#d8dde4]">
        <header className="sticky top-0 z-20 border-b border-[#e6e0d4] bg-[#f8f7f3]/95 px-5 pb-3 pt-4 backdrop-blur">
          <div className="flex items-center justify-between gap-3">
            <Link className="app-icon-button" href="/app" title="返回录音">
              <ArrowLeft className="h-4 w-4" />
            </Link>
            <div className="min-w-0 flex-1">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#738078]">Checkup</p>
              <h1 className="mt-1 truncate text-xl font-semibold text-[#111827]">验收中心</h1>
            </div>
            <Link className="app-icon-button app-icon-button-dark" href="/settings" title="模型设置">
              <Settings2 className="h-4 w-4" />
            </Link>
          </div>
        </header>

        <div className="space-y-4 px-4 py-4">
          <section className="rounded-lg border border-[#e2ddd2] bg-white p-4 shadow-[0_18px_45px_rgba(15,23,42,0.08)]">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-sm text-[#667085]">MVP 状态</p>
                <h2 className="mt-1 text-2xl font-semibold leading-tight text-[#111827]">按真实使用链路验收。</h2>
              </div>
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[#edf5f0] text-[#157a5a]">
                <ClipboardCheck className="h-5 w-5" />
              </span>
            </div>
            <p className="mt-4 text-sm leading-6 text-[#667085]">
              这里不是营销页，只显示当前账号能不能完成录音、识别、纪要、分享和 Obsidian 沉淀，以及上线还差什么。
            </p>
            <Link className="app-primary-button mt-4 min-h-10 px-4 py-2 text-sm" href="/api/checkup/acceptance.md">
              导出验收单
            </Link>
            <CheckupObsidianSaveButton />
            <div className="mt-5 grid grid-cols-3 gap-2 text-center">
              <HeroMetric label="完成" value={String(doneCount)} />
              <HeroMetric label="待处理" value={String(pendingCount)} />
              <HeroMetric label="阻塞" value={String(blockedCount)} />
            </div>
          </section>

          <section className="rounded-lg border border-[#d8e2dd] bg-white p-4 shadow-sm" data-readiness-stage={readinessStage.id}>
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[#667085]">当前阶段</p>
                <h2 className="mt-1 text-lg font-semibold text-[#111827]">{readinessStage.label}</h2>
                <p className="mt-2 text-sm leading-6 text-[#667085]">{readinessStage.detail}</p>
              </div>
              <span className={stageBadgeClass(readinessStage.tone)}>
                {releaseReadiness.summary.mvpReady ? "MVP Ready" : "待补齐"}
              </span>
            </div>
            <div className="mt-4 grid grid-cols-3 gap-2 text-center">
              <SmallMetric label="MVP" value={releaseReadiness.summary.mvpReady ? "是" : "否"} />
              <SmallMetric label="TestFlight" value={releaseReadiness.summary.testflightReady ? "是" : "否"} />
              <SmallMetric label="商用" value={releaseReadiness.summary.commercialReady ? "是" : "否"} />
            </div>
          </section>

          {summaryModelBlocker ? (
            <section className="rounded-lg border border-[#f3d2a1] bg-[#fffaf0] p-4 shadow-sm" data-summary-production-gate="blocked">
              <div className="flex items-start gap-3">
                <AlertTriangle className="mt-1 h-5 w-5 shrink-0 text-[#b54708]" />
                <div className="min-w-0">
                  <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[#b54708]">总结模型生产门禁</p>
                  <h2 className="mt-1 text-base font-semibold text-[#111827]">账号级可用不等于生产就绪</h2>
                  <p className="mt-2 text-sm leading-6 text-[#76530a]">
                    `/settings` 的 Provider health 只说明当前账号可能调用总结模型；是否能公开上线，必须看 `summary-model` blocker 的 JSON-only、幻觉处理、重试和人工复核等生产证据。
                    生产 summary-model 仍以 release readiness 为准。
                  </p>
                  <p className="mt-2 text-sm font-semibold leading-6 text-[#76530a]">下一步：{summaryModelBlocker.nextAction}</p>
                </div>
              </div>
            </section>
          ) : (
            <section className="rounded-lg border border-[#c7ead9] bg-[#f0fdf5] p-4 shadow-sm" data-summary-production-gate="ready">
              <div className="flex items-start gap-3">
                <CheckCircle2 className="mt-1 h-5 w-5 shrink-0 text-[#167052]" />
                <div className="min-w-0">
                  <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[#167052]">总结模型生产门禁</p>
                  <h2 className="mt-1 text-base font-semibold text-[#111827]">summary-model 已通过 release readiness</h2>
                  <p className="mt-2 text-sm leading-6 text-[#475467]">仍需在最终人工验收中抽样检查摘要、决策、待办和 Obsidian Markdown 是否严格基于逐字稿。</p>
                </div>
              </div>
            </section>
          )}

          <GoNoGoCard decision={goNoGoDecision} />

          <section className="rounded-lg border border-[#e4e8e5] bg-white p-4 shadow-sm">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0 flex-1">
                <h2 className="text-base font-semibold text-[#111827]">当前账号</h2>
                <p className="mt-1 truncate text-sm text-[#667085]">{user.email}</p>
              </div>
              <span className="rounded-full bg-[#eef6f1] px-3 py-1 text-xs font-semibold text-[#1f6f55]">{user.plan.toUpperCase()}</span>
            </div>
            <div className="mt-4 grid grid-cols-3 gap-2 text-center">
              <SmallMetric label="会议" value={String(meetings.length)} />
              <SmallMetric label="纪要" value={String(completedMeetings.length)} />
              <SmallMetric label="剩余额度" value={`${usage.officialMinutesRemaining}`} />
            </div>
          </section>

          <section className="rounded-lg border border-[#d9eadf] bg-[#effaf3] p-4 shadow-sm">
            <div className="flex items-start gap-3">
              <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white text-[#1f6f55]">
                <ShieldCheck className="h-4 w-4" />
              </span>
              <div className="min-w-0">
                <p className="text-xs font-semibold text-[#1f6f55]">推荐下一步</p>
                {nextAcceptanceItem ? (
                  <>
                    <h2 className="mt-1 text-base font-semibold text-[#111827]">{nextAcceptanceItem.title}</h2>
                    <p className="mt-1 text-sm leading-6 text-[#475467]">{nextAcceptanceItem.detail}</p>
                    <Link className="app-primary-button mt-3 min-h-10 px-4 py-2 text-sm" href={nextAcceptanceItem.href}>
                      {nextAcceptanceItem.action}
                    </Link>
                  </>
                ) : nextReadinessItem ? (
                  <>
                    <h2 className="mt-1 text-base font-semibold text-[#111827]">{nextReadinessItem.title}</h2>
                    <p className="mt-1 text-sm leading-6 text-[#475467]">{nextReadinessItem.nextAction}</p>
                    <Link className="app-primary-button mt-3 min-h-10 px-4 py-2 text-sm" href="/api/release/readiness" target="_blank">
                      查看报告
                    </Link>
                  </>
                ) : (
                  <>
                    <h2 className="mt-1 text-base font-semibold text-[#111827]">可以进入最终人工验收</h2>
                    <p className="mt-1 text-sm leading-6 text-[#475467]">当前账号链路和 readiness 没有剩余待处理项。</p>
                  </>
                )}
              </div>
            </div>
          </section>

          <section className="rounded-lg border border-[#f0d1c9] bg-[#fff8f6] p-4 shadow-sm">
            <div className="flex items-start gap-3">
              <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white text-[#9f3124]">
                <AlertTriangle className="h-4 w-4" />
              </span>
              <div className="min-w-0">
                <p className="text-xs font-semibold text-[#9f3124]">首要上线阻塞</p>
                <h2 className="mt-1 text-base font-semibold text-[#111827]">{releaseReadiness.nextAction.title}</h2>
                <p className="mt-1 text-sm leading-6 text-[#6b4b44]">{releaseReadiness.nextAction.detail}</p>
                <p className="mt-3 rounded-lg bg-white px-3 py-2 text-xs leading-5 text-[#6b4b44]">{releaseReadiness.nextAction.nextAction}</p>
                {releaseReadiness.nextAction.runbook ? (
                  <RunbookPath label={releaseReadiness.nextAction.runbook.label} path={releaseReadiness.nextAction.runbook.path} />
                ) : null}
              </div>
            </div>
          </section>

          <section className="rounded-lg border border-[#f0d1c9] bg-white p-4 shadow-sm">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h2 className="text-base font-semibold text-[#111827]">关键阻塞处理顺序</h2>
                <p className="mt-1 text-sm text-[#667085]">这些项不解决，不能进入公开商用或 App Store 正式上架。</p>
              </div>
              <AlertTriangle className="h-5 w-5 text-[#9f3124]" />
            </div>
            <div className="mt-4 space-y-3">
              {criticalBlockers.length ? (
                criticalBlockers.map((item, index) => <CriticalBlockerCard index={index + 1} item={item} key={item.id} />)
              ) : (
                <p className="rounded-lg bg-[#effaf3] p-3 text-sm leading-6 text-[#1f6f55]">当前没有关键阻塞，可以进入最终人工验收。</p>
              )}
            </div>
          </section>

          <section className="rounded-lg border border-[#d8e2dd] bg-white p-4 shadow-sm">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h2 className="text-base font-semibold text-[#111827]">上线准备包</h2>
                <p className="mt-1 text-sm text-[#667085]">把外部账号、基础设施、验收证据和本地命令按推进顺序合并。</p>
              </div>
              <ClipboardCheck className="h-5 w-5 text-[#1f6f55]" />
            </div>
            <div className="mt-4 space-y-3">
              {launchReadinessPacks.map((pack) => (
                <LaunchReadinessPackCard key={pack.id} pack={pack} />
              ))}
            </div>
          </section>

          <section className="rounded-lg border border-[#ead9a4] bg-[#fffdf5] p-4 shadow-sm">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h2 className="text-base font-semibold text-[#111827]">证据采集模板</h2>
                <p className="mt-1 text-sm text-[#76530a]">拿到外部资源后，按这里逐项填写，避免只说“已配置”但没有可复查证据。</p>
              </div>
              <ClipboardCheck className="h-5 w-5 text-[#946200]" />
            </div>
            <div className="mt-4 space-y-3">
              {blockerEvidenceTemplates.length ? (
                blockerEvidenceTemplates.map((template) => <CriticalEvidenceTemplateCard key={template.id} template={template} />)
              ) : (
                <p className="rounded-lg bg-[#effaf3] p-3 text-sm leading-6 text-[#1f6f55]">当前没有 critical blocker 证据模板。</p>
              )}
            </div>
          </section>

          <section className="rounded-lg border border-[#e4e8e5] bg-white p-4 shadow-sm">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h2 className="text-base font-semibold text-[#111827]">验收清单</h2>
                <p className="mt-1 text-sm text-[#667085]">按顺序处理，最后再做真实录音验收。</p>
              </div>
              <ShieldCheck className="h-5 w-5 text-[#1f6f55]" />
            </div>
            <div className="mt-4 space-y-3">
              {acceptanceItems.map((item) => (
                <AcceptanceRow item={item} key={item.title} />
              ))}
            </div>
          </section>

          <section className="rounded-lg border border-[#d9eadf] bg-white p-4 shadow-sm">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h2 className="text-base font-semibold text-[#111827]">人工验收脚本</h2>
                <p className="mt-1 text-sm text-[#667085]">最终验收按这个脚本走，避免只看界面感觉。</p>
              </div>
              <CheckCircle2 className="h-5 w-5 text-[#1f6f55]" />
            </div>
            <div className="mt-4 space-y-3">
              {manualAcceptanceItems.map((item) => (
                <ManualAcceptanceRow item={item} key={item.title} />
              ))}
            </div>
          </section>

          <section className="rounded-lg border border-[#e4e8e5] bg-white p-4 shadow-sm">
            <div className="flex items-center justify-between gap-3">
              <div>
                <h2 className="text-base font-semibold text-[#111827]">自动化验收</h2>
                <p className="mt-1 text-sm text-[#667085]">
                  {automationReadyCount} / {automationItems.length} 个 smoke 已就绪。
                </p>
              </div>
              <ClipboardCheck className="h-5 w-5 text-[#1f6f55]" />
            </div>
            <div className="mt-4 space-y-2">
              {automationItems.length ? (
                automationItems.map((item) => <AutomationRow item={item} key={item.id} />)
              ) : (
                <p className="rounded-lg bg-[#fff8f6] p-3 text-sm leading-6 text-[#9f3124]">release readiness 尚未配置自动化验收分组。</p>
              )}
            </div>
          </section>

          <section className="rounded-lg border border-[#e4e8e5] bg-white p-4 shadow-sm">
            <h2 className="text-base font-semibold text-[#111827]">上线阻塞</h2>
            <p className="mt-1 text-sm text-[#667085]">
              {releaseReadiness.summary.criticalBlocked} 个关键阻塞，{releaseReadiness.summary.blocked} 个总阻塞。
            </p>
            <div className="mt-4 space-y-2">
              {blockedItems.length ? (
                blockedItems.map((item) => <BlockedRow item={item} key={item.id} />)
              ) : (
                <p className="rounded-lg bg-[#effaf3] p-3 text-sm leading-6 text-[#1f6f55]">当前没有 blocked 项。下一步做真实会议压测和公开部署验收。</p>
              )}
            </div>
            <Link className="app-secondary-button mt-4 w-full" href="/api/release/readiness" target="_blank">
              查看完整 readiness JSON
              <ExternalLink className="h-4 w-4" />
            </Link>
          </section>
        </div>

        <AppBottomNav active="account" />
      </div>
    </main>
  );
}

function LaunchReadinessPackCard({ pack }: { pack: LaunchReadinessPack }) {
  return (
    <div className="rounded-lg border border-[#e7ece8] bg-[#fbfcfb] p-3" data-launch-pack-id={pack.id}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-[#111827]">{pack.title}</p>
          <p className="mt-1 text-xs leading-5 text-[#667085]">{pack.purpose}</p>
        </div>
        <span className="shrink-0 rounded-lg bg-white px-2 py-1 text-[11px] font-semibold text-[#1f6f55]">{pack.blockers.length} 项</span>
      </div>
      <div className="mt-3 rounded-lg bg-white px-3 py-2">
        <p className="text-[11px] font-semibold text-[#667085]">需要准备</p>
        <ul className="mt-1 space-y-1 text-xs leading-5 text-[#475467]">
          {pack.externalMaterials.map((item) => (
            <li key={item}>- {item}</li>
          ))}
        </ul>
      </div>
      <div className="mt-3 space-y-2">
        {pack.blockers.length ? (
          pack.blockers.map((item) => (
            <div className="rounded-lg bg-[#fff8f6] px-3 py-2" key={item.id}>
              <p className="text-xs font-semibold text-[#9f3124]">{item.title}</p>
              <p className="mt-1 text-xs leading-5 text-[#6b4b44]">{item.nextAction}</p>
              <p className="mt-2 break-all rounded-lg bg-[#111827] px-2 py-1.5 font-mono text-[11px] leading-5 text-white" data-pack-command={item.id}>
                {item.verificationCommand ?? "npm run smoke:release"}
              </p>
            </div>
          ))
        ) : (
          <p className="rounded-lg bg-[#effaf3] px-3 py-2 text-xs leading-5 text-[#1f6f55]">当前没有关联阻塞。</p>
        )}
      </div>
    </div>
  );
}

function CriticalEvidenceTemplateCard({ template }: { template: CriticalBlockerEvidenceTemplate }) {
  return (
    <div className="rounded-lg border border-[#ead9a4] bg-white p-3" data-evidence-template-id={template.id}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-[#111827]">{template.title}</p>
          <p className="mt-1 text-xs leading-5 text-[#76530a]">负责人：{template.owner}</p>
        </div>
        <span className="shrink-0 rounded-full bg-[#fff9e8] px-2 py-1 text-[11px] font-semibold text-[#946200]">证据模板</span>
      </div>
      <div className="mt-3 rounded-lg bg-[#fff9e8] px-3 py-2 text-xs leading-5 text-[#6f5422]">
        <p className="font-semibold text-[#8a6114]">建议存放</p>
        <p className="mt-1">{template.evidenceLocation}</p>
      </div>
      <div className="mt-3 rounded-lg bg-[#fbfcfb] px-3 py-2">
        <p className="text-[11px] font-semibold text-[#667085]">必填字段</p>
        <ul className="mt-1 space-y-1 text-xs leading-5 text-[#475467]">
          {template.requiredFields.map((field) => (
            <li key={field}>- {field}</li>
          ))}
        </ul>
      </div>
      <p className="mt-3 rounded-lg bg-[#111827] px-3 py-2 font-mono text-[11px] leading-5 text-white" data-evidence-command={template.id}>
        {template.verificationCommand}
      </p>
      <p className="mt-2 break-all rounded-lg bg-[#f7faf8] px-3 py-2 font-mono text-[11px] leading-5 text-[#475467]">{template.runbookPath}</p>
    </div>
  );
}

function AcceptanceRow({ item }: { item: AcceptanceItem }) {
  return (
    <div className="rounded-lg border border-[#e7ece8] bg-[#fbfcfb] p-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <StateIcon state={item.state} />
            <p className="text-sm font-semibold text-[#111827]">{item.title}</p>
          </div>
          <p className="mt-2 text-xs leading-5 text-[#667085]">{item.detail}</p>
        </div>
        <Link className="shrink-0 rounded-lg bg-white px-3 py-1.5 text-xs font-semibold text-[#1f6f55] shadow-sm" href={item.href}>
          {item.action}
        </Link>
      </div>
    </div>
  );
}

function GoNoGoCard({ decision }: { decision: GoNoGoDecision }) {
  const isNoGo = decision.status === "NO-GO";
  const isGo = decision.status === "GO";
  const cardClass = isGo
    ? "border-[#bfe7cf] bg-[#effaf3]"
    : isNoGo
      ? "border-[#f0d1c9] bg-[#fff8f6]"
      : "border-[#ead9a4] bg-[#fff9e8]";
  const iconClass = isGo ? "text-[#1f6f55]" : isNoGo ? "text-[#9f3124]" : "text-[#946200]";
  const badgeClass = isGo ? "bg-[#1f6f55] text-white" : isNoGo ? "bg-[#9f3124] text-white" : "bg-[#946200] text-white";

  return (
    <section className={`rounded-lg border p-4 shadow-sm ${cardClass}`}>
      <div className="flex items-start gap-3">
        <span className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white ${iconClass}`}>
          {isGo ? <CheckCircle2 className="h-4 w-4" /> : <AlertTriangle className="h-4 w-4" />}
        </span>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-xs font-semibold uppercase tracking-[0.12em] text-[#667085]">Go/No-Go 判定</p>
            <span className={`rounded-full px-2.5 py-1 text-[11px] font-semibold ${badgeClass}`}>当前结论：{decision.status}</span>
          </div>
          <h2 className="mt-2 text-base font-semibold text-[#111827]">{decision.title}</h2>
          <p className="mt-1 text-sm leading-6 text-[#475467]">{decision.detail}</p>
          <p className="mt-3 rounded-lg bg-white px-3 py-2 text-xs leading-5 text-[#475467]">
            <span className="font-semibold text-[#111827]">允许范围：</span>
            {decision.allowedScope}
          </p>
          <div className="mt-3 rounded-lg bg-white px-3 py-2">
            <p className="text-xs font-semibold text-[#111827]">必须补齐的证据</p>
            <ul className="mt-2 space-y-1.5 text-xs leading-5 text-[#667085]">
              {decision.requiredEvidence.map((item) => (
                <li key={item}>- {item}</li>
              ))}
            </ul>
          </div>
        </div>
      </div>
    </section>
  );
}

function ManualAcceptanceRow({ item }: { item: ManualAcceptanceItem }) {
  return (
    <div className="rounded-lg border border-[#e0ebe4] bg-[#fbfdfb] p-3">
      <p className="text-sm font-semibold text-[#111827]">{item.title}</p>
      <div className="mt-3 grid gap-2">
        <div className="rounded-lg bg-white px-3 py-2">
          <p className="text-[11px] font-semibold text-[#667085]">操作</p>
          <p className="mt-1 text-xs leading-5 text-[#475467]">{item.action}</p>
        </div>
        <div className="rounded-lg bg-[#effaf3] px-3 py-2">
          <p className="text-[11px] font-semibold text-[#1f6f55]">通过标准</p>
          <p className="mt-1 text-xs leading-5 text-[#2f5f4e]">{item.pass}</p>
        </div>
        <div className="rounded-lg bg-[#fff9e8] px-3 py-2">
          <p className="text-[11px] font-semibold text-[#8a6114]">证据建议</p>
          <p className="mt-1 text-xs leading-5 text-[#6f5422]">{item.evidence}</p>
        </div>
      </div>
    </div>
  );
}

function AutomationRow({ item }: { item: ReleaseReadinessItem }) {
  return (
    <div className="rounded-lg border border-[#e7ece8] bg-[#fbfcfb] p-3">
      <div className="flex items-start gap-2">
        <StateIcon state={item.status === "ready" ? "done" : item.status === "blocked" ? "blocked" : "pending"} />
        <div className="min-w-0">
          <p className="text-sm font-semibold text-[#111827]">{item.title}</p>
          <p className="mt-1 text-xs leading-5 text-[#667085]">{item.detail}</p>
          <p className="mt-2 rounded-lg bg-white px-3 py-2 text-xs leading-5 text-[#475467]">{item.evidence}</p>
        </div>
      </div>
    </div>
  );
}

function BlockedRow({ item }: { item: ReleaseReadinessBlocker }) {
  return (
    <div className="rounded-lg border border-[#f0d1c9] bg-[#fff8f6] p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-semibold text-[#9f3124]">{item.groupTitle}</p>
          <p className="mt-1 text-sm font-semibold text-[#111827]">{item.title}</p>
        </div>
        <span className="shrink-0 rounded-lg bg-white px-2 py-1 text-[11px] font-semibold text-[#9f3124]">{priorityLabel(item.priority)}</span>
      </div>
      <p className="mt-2 text-xs leading-5 text-[#6b4b44]">{item.nextAction}</p>
      {item.runbook ? <RunbookPath label={item.runbook.label} path={item.runbook.path} /> : null}
    </div>
  );
}

function CriticalBlockerCard({ index, item }: { index: number; item: ReleaseReadinessBlocker }) {
  const verificationCommand = item.verificationCommand ?? "npm run smoke:release";

  return (
    <div
      className="rounded-lg border border-[#f0d1c9] bg-[#fff8f6] p-3"
      data-blocker-id={item.id}
      data-verification-command={verificationCommand}
    >
      <div className="flex items-start gap-3">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[#9f3124] text-xs font-semibold text-white">{index}</span>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-xs font-semibold text-[#9f3124]">{item.groupTitle}</p>
              <p className="mt-1 text-sm font-semibold text-[#111827]">{item.title}</p>
            </div>
            <span className="shrink-0 rounded-lg bg-white px-2 py-1 text-[11px] font-semibold text-[#9f3124]">{priorityLabel(item.priority)}</span>
          </div>
          <p className="mt-2 text-xs leading-5 text-[#6b4b44]">{item.detail}</p>
          <div className="mt-3 rounded-lg bg-white px-3 py-2 text-xs leading-5 text-[#475467]">
            <p className="font-semibold text-[#111827]">下一步</p>
            <p className="mt-1">{item.nextAction}</p>
          </div>
          <div className="mt-2 rounded-lg bg-[#fff9e8] px-3 py-2 text-xs leading-5 text-[#6f5422]">
            <p className="font-semibold text-[#8a6114]">验收证据</p>
            <p className="mt-1">{item.acceptanceEvidence}</p>
          </div>
          <div className="mt-2 rounded-lg bg-[#111827] px-3 py-2">
            <p className="text-[11px] font-semibold text-white/64">本地验证命令</p>
            <p className="mt-1 break-all font-mono text-[11px] leading-5 text-white">{verificationCommand}</p>
          </div>
          {item.runbook ? <RunbookPath label={item.runbook.label} path={item.runbook.path} /> : null}
        </div>
      </div>
    </div>
  );
}

function RunbookPath({ label, path }: { label: string; path: string }) {
  return (
    <div className="mt-2 rounded-lg bg-white px-3 py-2 text-xs leading-5 text-[#6b4b44]">
      <p className="font-semibold">{label}</p>
      <p className="mt-1 break-all font-mono text-[11px] text-[#8a6a62]">{path}</p>
    </div>
  );
}

function priorityLabel(priority: ReleaseReadinessBlocker["priority"]) {
  if (priority === "critical") return "关键";
  if (priority === "high") return "高";
  return "中";
}

function stageBadgeClass(tone: "done" | "pending" | "blocked") {
  if (tone === "done") return "shrink-0 rounded-full bg-[#1f6f55] px-3 py-1 text-xs font-semibold text-white";
  if (tone === "blocked") return "shrink-0 rounded-full bg-[#9f3124] px-3 py-1 text-xs font-semibold text-white";
  return "shrink-0 rounded-full bg-[#fff4d6] px-3 py-1 text-xs font-semibold text-[#946200]";
}

function StateIcon({ state }: { state: CheckState }) {
  if (state === "done") return <CheckCircle2 className="h-4 w-4 text-[#1f6f55]" />;
  if (state === "blocked") return <AlertTriangle className="h-4 w-4 text-[#9f3124]" />;
  return <Link2 className="h-4 w-4 text-[#946200]" />;
}

function HeroMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-[#e1e8e2] bg-[#fbfcfb] px-2 py-3">
      <p className="text-[11px] font-medium text-[#66766e]">{label}</p>
      <p className="mt-1 text-lg font-semibold text-[#111827]">{value}</p>
    </div>
  );
}

function SmallMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-[#f7faf8] px-2 py-3">
      <p className="text-[11px] text-[#98a2b3]">{label}</p>
      <p className="mt-1 truncate text-sm font-semibold text-[#111827]" title={value}>
        {value}
      </p>
    </div>
  );
}
