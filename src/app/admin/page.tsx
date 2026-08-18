import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { ArrowLeft, BarChart3, CircleDollarSign, Gauge, KeyRound, Link2, ShieldAlert, TrendingUp, UsersRound } from "lucide-react";
import Link from "next/link";
import { AdminEntitlementStatusControl } from "@/components/admin-entitlement-status-control";
import { AdminPlanGrantControl } from "@/components/admin-plan-grant-control";
import { getReadinessStage } from "@/lib/checkup-acceptance";
import { getReleaseReadinessReport } from "@/lib/release-readiness";
import { getRuntimeSecretDiagnostics } from "@/lib/secret-diagnostics";
import { getAdminCommercialMetrics, getAdminFunnel, getAdminGrowthMetrics, getAdminMetrics, listAdminBillingOrders, listAdminEntitlementGrants, listAdminUsers } from "@/lib/server/auth-repository";
import { getCurrentUser } from "@/lib/server/current-user";
import { getMeetingShareAnalyticsSummary } from "@/lib/server/meeting-audio-store";
import { getAccountDeletionCleanupDiagnostics } from "@/lib/server/account-deletion-cleanup-worker";
import { getLegacyDeletionCleanupDiagnostics } from "@/lib/server/legacy-deletion-cleanup";

export const metadata: Metadata = {
  title: "后台 - OwnMinutes",
};

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if (user.role !== "admin") redirect("/account");

  const [adminMetrics, commercialMetrics, growthMetrics, funnel, users, entitlementGrants, billingOrders, shareAnalytics, deletionCleanup, accountDeletionCleanup, secretDiagnostics] = await Promise.all([
    getAdminMetrics(),
    getAdminCommercialMetrics(),
    getAdminGrowthMetrics(),
    getAdminFunnel(),
    listAdminUsers(),
    listAdminEntitlementGrants(8),
    listAdminBillingOrders(8),
    getMeetingShareAnalyticsSummary(),
    getLegacyDeletionCleanupDiagnostics(10),
    getAccountDeletionCleanupDiagnostics(10),
    getRuntimeSecretDiagnostics(),
  ]);
  const releaseReadiness = getReleaseReadinessReport(secretDiagnostics);
  const readinessStage = getReadinessStage(releaseReadiness.summary);
  const criticalBlockers = releaseReadiness.blockers.filter((blocker) => blocker.priority === "critical").slice(0, 4);
  const metrics = [
    { label: "注册用户", value: String(adminMetrics.activeUsers), icon: UsersRound },
    { label: "历史账号", value: String(adminMetrics.totalUsers), icon: BarChart3 },
    { label: "官方分钟", value: `${adminMetrics.officialMinutesUsed}/${adminMetrics.officialMinutesTotal}`, icon: CircleDollarSign },
    { label: "Provider 配置", value: String(adminMetrics.totalProviderCredentials), icon: KeyRound },
    { label: "分享访问", value: String(shareAnalytics.totalShareViews), icon: Link2 },
    {
      label: "手工清理",
      value: String(
        deletionCleanup.unresolvedOwnedCount +
        deletionCleanup.catalogBackfillBlockerCount +
        accountDeletionCleanup.deadLetteredCount,
      ),
      icon: ShieldAlert,
    },
  ];
  const maxFunnelValue = Math.max(...funnel.map((item) => item.value), 1);

  return (
    <main className="min-h-screen bg-[#f3f5f2] text-[#111827]">
      <div className="mx-auto w-full max-w-[1180px] px-4 py-5 sm:px-6 lg:px-8">
        <Link className="inline-flex items-center gap-2 text-sm font-semibold text-[#1f6f55]" href="/app">
          <ArrowLeft className="h-4 w-4" />
          返回工作台
        </Link>

        <header className="mt-5 flex flex-col gap-4 border-b border-[#d9ded8] pb-5 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <p className="text-sm font-semibold uppercase tracking-[0.12em] text-[#1f6f55]">admin MVP</p>
            <h1 className="mt-2 text-3xl font-semibold tracking-normal">运营后台</h1>
            <p className="mt-2 max-w-2xl text-sm leading-6 text-[#667085]">
              当前后台读取本机账号、Provider 配置和额度数据，用于验证用户量、配置转化和会员路径。正式商用版需要迁移到 PostgreSQL 和权限系统。
            </p>
          </div>
          <Link className="primary-action" href="/pricing">
            查看定价
          </Link>
        </header>

        <section className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
          {metrics.map((metric) => {
            const Icon = metric.icon;
            return (
              <div key={metric.label} className="rounded-lg border border-[#d9ded8] bg-white p-4 shadow-sm">
                <div className="flex items-center gap-2 text-sm text-[#667085]">
                  <Icon className="h-4 w-4 text-[#1f6f55]" />
                  {metric.label}
                </div>
                <p className="mt-3 text-2xl font-semibold">{metric.value}</p>
              </div>
            );
          })}
        </section>

        {deletionCleanup.releaseBlocked ? (
          <section className="mt-5 rounded-lg border border-[#e7b5ae] bg-[#fff4f1] p-5 shadow-sm">
            <div className="flex items-start gap-3">
              <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-[#9f3124]" />
              <div>
                <h2 className="text-base font-semibold text-[#9f3124]">生产发布已被历史录音清理阻断</h2>
                <p className="mt-1 text-sm leading-6 text-[#76514c]">
                  有 {deletionCleanup.unresolvedOwnedCount} 条 owner-linked 记录和 {deletionCleanup.catalogBackfillBlockerCount} 条 catalog 前缀阻断需要人工核对；最早发现时间为 {deletionCleanup.oldestDetectedAt || "未知"}。后台只展示不可逆引用，不展示原始账号或会议标识。
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {deletionCleanup.inventory.map((item) => (
                    <span key={item.meetingRef} className="rounded-md bg-white px-2 py-1 font-mono text-xs text-[#76514c]">
                      {item.meetingRef} · {item.state}
                    </span>
                  ))}
                </div>
                <p className="mt-3 text-xs leading-5 text-[#76514c]">按 docs/legacy-meeting-deletion-cleanup-runbook.md 处理；禁止猜测或清理相似前缀。</p>
              </div>
            </div>
          </section>
        ) : null}

        {accountDeletionCleanup.releaseBlocked ? (
          <section className="mt-5 rounded-lg border border-[#e7b5ae] bg-[#fff4f1] p-5 shadow-sm">
            <div className="flex items-start gap-3">
              <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-[#9f3124]" />
              <div>
                <h2 className="text-base font-semibold text-[#9f3124]">账号删除清理队列需要人工处理</h2>
                <p className="mt-1 text-sm leading-6 text-[#76514c]">
                  dead-letter {accountDeletionCleanup.deadLetteredCount}，过期 claim {accountDeletionCleanup.expiredClaimCount}，超时可运行任务 {accountDeletionCleanup.overdueRunnableCount}。后台只展示不可逆账号引用。
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  {accountDeletionCleanup.inventory.map((item) => (
                    <span key={item.accountRef} className="rounded-md bg-white px-2 py-1 font-mono text-xs text-[#76514c]">
                      {item.accountRef} · {item.state} · attempt {item.attempt}
                    </span>
                  ))}
                </div>
                <p className="mt-3 text-xs leading-5 text-[#76514c]">按 docs/account-deletion-cleanup-runbook.md 诊断和显式 replay；不要直接删除 cleanup job。</p>
              </div>
            </div>
          </section>
        ) : null}

        <section className="mt-5 grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
          <div className="rounded-lg border border-[#d9ded8] bg-white p-5 shadow-sm">
            <div className="flex items-start justify-between gap-4">
              <div>
                <h2 className="text-lg font-semibold">商业路径摘要</h2>
                <p className="mt-1 text-sm leading-6 text-[#667085]">判断 OwnMinutes 的免费获客、BYOK 控成本和会员省心路径是否跑通。</p>
              </div>
              <TrendingUp className="h-5 w-5 text-[#1f6f55]" />
            </div>

            <div className="mt-4 grid gap-3 md:grid-cols-5">
              <CommercialCard label="配置模型转化" value={`${commercialMetrics.conversionRates.providerSetup}%`} detail={`${commercialMetrics.configuredProviderUsers}/${commercialMetrics.activeUsers} 个活跃用户`} />
              <CommercialCard label="完成首场会议" value={`${commercialMetrics.conversionRates.activation}%`} detail={`${commercialMetrics.activatedUsers}/${commercialMetrics.activeUsers} 个活跃用户`} />
              <CommercialCard label="付费路径占比" value={`${commercialMetrics.conversionRates.paid}%`} detail={`${commercialMetrics.payingUsers}/${commercialMetrics.activeUsers} 个活跃用户`} />
              <CommercialCard label="分享访问" value={`${shareAnalytics.totalShareViews}`} detail={`${shareAnalytics.publicShares} 个公开链接，${shareAnalytics.viewedShares} 个被打开`} />
              <CommercialCard label="分享带来注册" value={`${growthMetrics.shareAttributedRegistrations}`} detail={`${growthMetrics.shareAttributedProviderUsers} 个配置模型，${growthMetrics.shareAttributedActivatedUsers} 个完成首场会议`} />
            </div>

            <div className="mt-4 grid gap-3 md:grid-cols-3">
              <PathCard label="BYOK 免费" value={commercialMetrics.byokOnlyUsers} detail="已配置模型且仍在 Free，用于验证低成本口碑获客。" />
              <PathCard label="官方额度" value={commercialMetrics.officialOnlyUsers} detail="未配置模型，后续适合引导 Plus / Pro。" />
              <PathCard label="混合模式" value={commercialMetrics.hybridUsers} detail="已配置模型且开通 Plus/Pro，说明省心能力有价值。" />
            </div>

            <div className="mt-4 grid gap-3 md:grid-cols-3">
              <PathCard label="分享后配置模型" value={growthMetrics.shareAttributedProviderUsers} detail={`${growthMetrics.shareConversionRates.providerSetup}% 的分享注册用户完成 BYOK 配置。`} />
              <PathCard label="分享后首场会议" value={growthMetrics.shareAttributedActivatedUsers} detail={`${growthMetrics.shareConversionRates.activation}% 的分享注册用户完成会议处理。`} />
              <PathCard label="分享后付费" value={growthMetrics.shareAttributedPayingUsers} detail={`${growthMetrics.shareConversionRates.paid}% 的分享注册用户进入会员或买包路径。`} />
            </div>
          </div>

          <div className="rounded-lg border border-[#d9ded8] bg-white p-5 shadow-sm">
            <div className="flex items-center gap-2 text-sm font-semibold text-[#1f6f55]">
              <Gauge className="h-4 w-4" />
              方案结构
            </div>
            <div className="mt-4 space-y-3">
              <PlanMeter label="Free" value={commercialMetrics.freeUsers} total={commercialMetrics.activeUsers} />
              <PlanMeter label="Plus" value={commercialMetrics.plusUsers} total={commercialMetrics.activeUsers} />
              <PlanMeter label="Pro" value={commercialMetrics.proUsers} total={commercialMetrics.activeUsers} />
            </div>
            <p className="mt-4 rounded-md bg-[#fbfcfb] px-3 py-2 text-xs leading-5 text-[#667085]">
              剩余官方额度池：<span className="font-semibold text-[#111827]">{commercialMetrics.officialMinutesRemaining}</span> 分钟。正式商用前应把这里接入订单、IAP 和成本核算。
            </p>
          </div>
        </section>

        <section className="mt-5 grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
          <div className="rounded-lg border border-[#ead28b] bg-[#fffdf5] p-5 shadow-sm">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <h2 className="text-lg font-semibold">上线风险</h2>
                <p className="mt-1 text-sm leading-6 text-[#76530a]">
                  当前阶段：{readinessStage.label}。本地 MVP 可测不等于 TestFlight 或公开商用可上架。
                </p>
              </div>
              <span className="w-fit rounded-md bg-white px-3 py-2 text-xs font-semibold text-[#76530a]">
                {releaseReadiness.summary.criticalBlocked} 个 critical blocker
              </span>
            </div>

            <div className="mt-4 grid gap-3 md:grid-cols-4">
              <RiskMetric label="MVP" value={releaseReadiness.summary.mvpReady ? "Ready" : "No"} tone={releaseReadiness.summary.mvpReady ? "ready" : "blocked"} />
              <RiskMetric label="TestFlight" value={releaseReadiness.summary.testflightReady ? "Ready" : "Blocked"} tone={releaseReadiness.summary.testflightReady ? "ready" : "blocked"} />
              <RiskMetric label="商用" value={releaseReadiness.summary.commercialReady ? "Ready" : "Blocked"} tone={releaseReadiness.summary.commercialReady ? "ready" : "blocked"} />
              <RiskMetric label="阻塞项" value={`${releaseReadiness.summary.blocked}/${releaseReadiness.summary.total}`} tone="warning" />
            </div>

            <div className="mt-4 grid gap-3 md:grid-cols-2">
              {criticalBlockers.map((blocker) => (
                <div key={blocker.id} className="rounded-md border border-[#ead28b] bg-white p-3">
                  <p className="text-sm font-semibold text-[#111827]">{blocker.title}</p>
                  <p className="mt-1 text-xs leading-5 text-[#76530a]">{blocker.nextAction}</p>
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-lg border border-[#d9ded8] bg-white p-5 shadow-sm">
            <h2 className="text-lg font-semibold">运营下一步</h2>
            <p className="mt-2 text-sm leading-6 text-[#667085]">
              后台可以继续看用户量、配置转化和人工权益，但正式外测前必须先清理上线风险。
            </p>
            <div className="mt-4 grid gap-2">
              <Link className="secondary-action w-full justify-center" href="/checkup">
                打开验收中心
              </Link>
              <Link className="primary-action w-full justify-center" href="/settings">
                配置模型
              </Link>
            </div>
          </div>
        </section>

        <section className="mt-5 grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
          <div className="rounded-lg border border-[#d9ded8] bg-white p-5 shadow-sm">
            <h2 className="text-lg font-semibold">获客转化漏斗</h2>
            <div className="mt-4 space-y-3">
              {funnel.map((item) => (
                <div key={item.label}>
                  <div className="flex items-center justify-between text-sm">
                    <span className="font-semibold">{item.label}</span>
                    <span className="font-mono text-[#667085]">{item.value}</span>
                  </div>
                  <div className="mt-2 h-2 overflow-hidden rounded-full bg-[#edf0ed]">
                    <div className="h-full rounded-full bg-[#1f6f55]" style={{ width: `${Math.max(8, Math.round((item.value / maxFunnelValue) * 100))}%` }} />
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-lg border border-[#d9ded8] bg-white p-5 shadow-sm">
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-lg font-semibold">最近权益发放</h2>
              <span className="rounded-md bg-[#eef6f1] px-2 py-1 text-xs font-semibold text-[#1f6f55]">{entitlementGrants.length} 权益 / {billingOrders.length} 订单</span>
            </div>
            {entitlementGrants.length === 0 ? (
              <p className="mt-4 rounded-md bg-[#fbfcfb] px-3 py-3 text-sm leading-6 text-[#667085]">还没有人工权益发放记录。后续每次后台发放都会进入账本，便于退款、撤销和 IAP 对账。</p>
            ) : (
              <div className="mt-4 space-y-3">
                {entitlementGrants.map((grant) => (
                  <div key={grant.id} className="rounded-md border border-[#e1e6e0] bg-[#fbfcfb] p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <p className="truncate text-sm font-semibold text-[#111827]">{grant.userName}</p>
                        <p className="mt-1 truncate font-mono text-xs text-[#667085]">{grant.userEmail}</p>
                      </div>
                      <span className={`shrink-0 rounded-md px-2 py-1 text-xs font-semibold ${grant.status === "active" ? "bg-[#eef6f1] text-[#1f6f55]" : grant.status === "refunded" ? "bg-[#fff4f1] text-[#9f3124]" : "bg-[#fff9e8] text-[#76530a]"}`}>
                        {grant.status.toUpperCase()}
                      </span>
                    </div>
                    <p className="mt-2 text-xs leading-5 text-[#667085]">
                      {grant.source === "admin_manual" ? "后台人工发放" : grant.source} · {grant.previousPlan.toUpperCase()} → {grant.plan.toUpperCase()} · {grant.officialMinutesTotal} 分钟
                    </p>
                    <p className="mt-1 text-xs leading-5 text-[#667085]">原因：{grant.reason || "未填写"}</p>
                    {grant.billingOrderId ? <p className="mt-1 font-mono text-[11px] text-[#98a2b3]">订单：{grant.billingOrderId}</p> : null}
                    {grant.status !== "active" ? (
                      <p className="mt-1 text-xs leading-5 text-[#667085]">
                        处理：{grant.statusReason || "未填写"} · {grant.statusUpdatedAt ? formatDateTime(grant.statusUpdatedAt) : "时间未知"}
                      </p>
                    ) : null}
                    <p className="mt-1 text-xs text-[#98a2b3]">{formatDateTime(grant.createdAt)}</p>
                    <AdminEntitlementStatusControl grantId={grant.id} status={grant.status} />
                  </div>
                ))}
              </div>
            )}
            <p className="mt-4 rounded-md border border-[#ead28b] bg-[#fff9e8] px-3 py-2 text-xs leading-5 text-[#76530a]">
              这是 IAP 前的运营账本，不代表真实支付已接通。后续仍需 Apple IAP、退款撤销和自动权益回收。
            </p>
          </div>
        </section>

        <section className="mt-5 rounded-lg border border-[#d9ded8] bg-white shadow-sm">
          <div className="flex flex-col gap-2 border-b border-[#e6ebe5] p-5 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="text-lg font-semibold">用户明细</h2>
              <p className="mt-1 text-sm text-[#667085]">用于判断注册质量、方案选择、模型配置和首场会议完成情况。</p>
            </div>
            <span className="w-fit rounded-md bg-[#eef6f1] px-2 py-1 text-xs font-semibold text-[#1f6f55]">{users.length} 个账号</span>
          </div>

          <div className="overflow-x-auto">
            <table className="min-w-[1180px] w-full border-collapse text-left">
              <thead>
                <tr className="border-b border-[#edf0ed] bg-[#fbfcfb] text-xs font-semibold text-[#667085]">
                  <th className="px-4 py-3">用户</th>
                  <th className="px-4 py-3">方案</th>
                  <th className="px-4 py-3">额度</th>
                  <th className="px-4 py-3">会议</th>
                  <th className="px-4 py-3">Provider</th>
                  <th className="px-4 py-3">最后活跃</th>
                  <th className="px-4 py-3">状态</th>
                  <th className="px-4 py-3">人工权益</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#edf0ed]">
                {users.map((item) => (
                  <tr key={item.id} className="text-sm">
                    <td className="px-4 py-3">
                      <p className="font-semibold text-[#111827]">{item.name}</p>
                      <p className="mt-1 font-mono text-xs text-[#667085]">{item.email}</p>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`rounded-md px-2 py-1 text-xs font-semibold ${item.plan === "free" ? "bg-[#f2f5f1] text-[#667085]" : "bg-[#eef6f1] text-[#1f6f55]"}`}>
                        {item.plan.toUpperCase()}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <p className="font-semibold">{item.officialMinutesRemaining} 分钟</p>
                      <p className="mt-1 text-xs text-[#667085]">已用 {item.officialMinutesUsed} / {item.officialMinutesTotal}</p>
                    </td>
                    <td className="px-4 py-3 font-mono text-sm">{item.meetingFinalizeCount}</td>
                    <td className="px-4 py-3 font-mono text-sm">{item.providerCredentialCount}</td>
                    <td className="px-4 py-3 text-xs text-[#667085]">{formatDateTime(item.lastSeenAt || item.createdAt)}</td>
                    <td className="px-4 py-3">
                      <span className={`rounded-md px-2 py-1 text-xs font-semibold ${item.status === "active" ? "bg-[#eef6f1] text-[#1f6f55]" : "bg-[#fff1ed] text-[#9f3124]"}`}>
                        {item.status === "active" ? "活跃" : "已删除"}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      {item.status === "active" ? <AdminPlanGrantControl currentPlan={item.plan} userId={item.id} /> : <span className="text-xs text-[#98a2b3]">不可操作</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </main>
  );
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

function CommercialCard({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="rounded-md border border-[#e1e6e0] bg-[#fbfcfb] p-3">
      <p className="text-xs font-semibold text-[#667085]">{label}</p>
      <p className="mt-2 text-2xl font-semibold text-[#111827]">{value}</p>
      <p className="mt-1 text-xs leading-5 text-[#667085]">{detail}</p>
    </div>
  );
}

function PathCard({ label, value, detail }: { label: string; value: number; detail: string }) {
  return (
    <div className="rounded-md border border-[#e1e6e0] bg-white p-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-semibold text-[#111827]">{label}</p>
        <span className="rounded-md bg-[#eef6f1] px-2 py-1 text-xs font-semibold text-[#1f6f55]">{value}</span>
      </div>
      <p className="mt-2 text-xs leading-5 text-[#667085]">{detail}</p>
    </div>
  );
}

function PlanMeter({ label, value, total }: { label: string; value: number; total: number }) {
  const ratio = total > 0 ? Math.round((value / total) * 100) : 0;

  return (
    <div>
      <div className="flex items-center justify-between text-sm">
        <span className="font-semibold text-[#111827]">{label}</span>
        <span className="font-mono text-xs text-[#667085]">{value} / {total}</span>
      </div>
      <div className="mt-2 h-2 overflow-hidden rounded-full bg-[#edf0ed]">
        <div className="h-full rounded-full bg-[#1f6f55]" style={{ width: `${ratio}%` }} />
      </div>
    </div>
  );
}

function RiskMetric({ label, tone, value }: { label: string; tone: "ready" | "warning" | "blocked"; value: string }) {
  const valueClass = tone === "ready" ? "text-[#1f6f55]" : tone === "warning" ? "text-[#76530a]" : "text-[#9f3124]";

  return (
    <div className="rounded-md border border-[#e1e6e0] bg-white p-3">
      <p className="text-xs font-semibold text-[#667085]">{label}</p>
      <p className={`mt-2 text-lg font-semibold ${valueClass}`}>{value}</p>
    </div>
  );
}
