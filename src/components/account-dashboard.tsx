"use client";

import type { AccountEntitlements } from "@/lib/account-entitlements";
import { AppBottomNav } from "@/components/app-bottom-nav";
import type { BillingPlan } from "@/lib/billing-plans";
import { billingPlans } from "@/lib/billing-plans";
import type { ProviderHealthResult } from "@/lib/provider-health";
import type { ProviderCredentialSummary, SafeUser, UserUsageSummary } from "@/lib/server/auth-repository";
import type { MeetingListItem } from "@/lib/server/meeting-audio-store";
import {
  ArrowRight,
  CheckCircle2,
  ChevronDown,
  CreditCard,
  Download,
  FileText,
  KeyRound,
  LockKeyhole,
  LogOut,
  RefreshCw,
  Trash2,
  UserRound,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, type ReactNode, useState } from "react";
import { deleteBrowserRecordingsForUser } from "@/lib/browser-recording-store";

type AccountDashboardProps = {
  entitlements: AccountEntitlements;
  meetings: MeetingListItem[];
  providerCredentials: ProviderCredentialSummary[];
  providerHealth: ProviderHealthResult[];
  simulatedPlanChangesEnabled: boolean;
  usage: UserUsageSummary;
  user: SafeUser;
};

export function AccountDashboard({
  entitlements,
  meetings,
  providerCredentials,
  providerHealth: initialProviderHealth,
  simulatedPlanChangesEnabled,
  usage,
  user,
}: AccountDashboardProps) {
  const router = useRouter();
  const [changingPlan, setChangingPlan] = useState<string | null>(null);
  const [planMessage, setPlanMessage] = useState<string | null>(null);
  const [providerHealth, setProviderHealth] = useState(initialProviderHealth);
  const [checkingHealth, setCheckingHealth] = useState(false);
  const [changingPassword, setChangingPassword] = useState(false);
  const [passwordForm, setPasswordForm] = useState({ confirmPassword: "", currentPassword: "", newPassword: "" });
  const [passwordMessage, setPasswordMessage] = useState<string | null>(null);
  const completedMeetings = meetings.filter((meeting) => meeting.hasResult).length;
  const publicMeetings = meetings.filter((meeting) => meeting.share.visibility === "public").length;
  const usedRatio = usage.officialMinutesTotal > 0 ? Math.min(100, Math.round((usage.officialMinutesUsed / usage.officialMinutesTotal) * 100)) : 0;
  const readyProviders = providerHealth.filter((item) => item.status === "ready").length;

  async function changePlan(planId: BillingPlan["id"]) {
    if (!simulatedPlanChangesEnabled) {
      setPlanMessage("Plus / Pro 真实购买尚未开放。当前不会通过网页切换或扣款。");
      return;
    }
    setChangingPlan(planId);
    setPlanMessage(null);

    try {
      const response = await fetch("/api/account/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plan: planId }),
      });
      const payload = await response.json();

      if (!response.ok || !payload.ok) {
        setPlanMessage(
          payload.code === "simulated_billing_disabled"
            ? "当前环境未启用模拟套餐切换。正式会员需要通过 Apple IAP、后台订单或人工审核发放。"
            : payload.error || "方案更新失败。",
        );
        return;
      }

      setPlanMessage("方案已更新。当前只应在开发或验收环境启用模拟切换。");
      router.refresh();
    } catch {
      setPlanMessage("方案更新请求失败。");
    } finally {
      setChangingPlan(null);
    }
  }

  async function refreshProviderHealth() {
    setCheckingHealth(true);
    try {
      const response = await fetch("/api/account/provider-health", { cache: "no-store" });
      const payload = await response.json();
      if (response.ok && payload.ok) {
        setProviderHealth(payload.health || []);
      }
    } finally {
      setCheckingHealth(false);
    }
  }

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  }

  async function submitPasswordChange(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPasswordMessage(null);

    if (passwordForm.newPassword !== passwordForm.confirmPassword) {
      setPasswordMessage("两次输入的新密码不一致。");
      return;
    }

    setChangingPassword(true);
    try {
      const response = await fetch("/api/auth/password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          currentPassword: passwordForm.currentPassword,
          newPassword: passwordForm.newPassword,
        }),
      });
      const payload = await response.json();

      if (!response.ok || !payload.ok) {
        setPasswordMessage(payload.error || "修改密码失败。");
        return;
      }

      setPasswordForm({ confirmPassword: "", currentPassword: "", newPassword: "" });
      setPasswordMessage("密码已修改。其他设备上的登录会话已失效。");
    } catch {
      setPasswordMessage("修改密码请求失败。");
    } finally {
      setChangingPassword(false);
    }
  }

  async function deleteAccount() {
    const confirmed = window.confirm("确认删除当前账号？系统会删除会话、Provider 配置、用量流水、会议音频、纪要、Markdown 和公开分享链接。");
    if (!confirmed) return;

    const response = await fetch("/api/auth/delete", { method: "DELETE" });
    if (!response.ok) return;
    await deleteBrowserRecordingsForUser(user.id).catch(() => undefined);
    router.push("/register");
    router.refresh();
  }

  return (
    <div className="space-y-3 px-4 py-3" data-account-ui="native-list-v29">
      <section className="border-y border-[#e1e8e3] bg-white px-4 py-4" data-account-section="profile">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <p className="text-xs font-semibold text-[#1f6f55]">当前账号</p>
            <h2 className="mt-1 truncate text-xl font-semibold text-[#111827]">{user.name || user.email}</h2>
            <p className="mt-1 truncate text-sm text-[#667085]" title={user.email}>{user.email}</p>
            <p className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-[#1f6f55]">
              <CheckCircle2 className="h-3.5 w-3.5" />
              {user.emailVerifiedAt ? "邮箱已验证" : "邮箱待验证"}
            </p>
          </div>
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[#eef6f1]">
            <UserRound className="h-5 w-5 text-[#1f6f55]" />
          </span>
        </div>

        <div className="mt-4 grid grid-cols-3 divide-x divide-[#edf1ee] border-y border-[#edf1ee] py-3 text-center">
          <AccountMetric label="方案" value={user.plan.toUpperCase()} />
          <AccountMetric label="剩余额度" value={`${usage.officialMinutesRemaining} 分钟`} />
          <AccountMetric label="可用模型" value={`${readyProviders}/${providerHealth.length}`} />
        </div>
      </section>

      <section className="border-y border-[#e1e8e3] bg-white px-4 py-4" data-account-section="usage">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-[#111827]">使用状态</h2>
            <p className="mt-1 text-sm text-[#667085]">{entitlementStatusText(entitlements.status)}</p>
          </div>
          <span className={entitlementBadgeClass(entitlements.status)}>{processingRouteLabel(entitlements.preferredRoute)}</span>
        </div>

        <div className="mt-4">
          <div className="flex items-center justify-between text-xs text-[#667085]">
            <span>官方额度</span>
            <span>{usedRatio}% 已使用</span>
          </div>
          <div className="mt-2 h-2 overflow-hidden rounded-full bg-[#edf0ed]">
            <div className="h-full rounded-full bg-[#1f6f55]" style={{ width: `${usedRatio}%` }} />
          </div>
          <p className="mt-2 text-xs leading-5 text-[#667085]">
            剩余 {usage.officialMinutesRemaining} / {usage.officialMinutesTotal} 分钟。
          </p>
        </div>

        <Link className="mt-3 flex min-h-12 items-center gap-3 border-t border-[#edf1ee] pt-3" href={entitlements.nextAction.href}>
          <span className="min-w-0 flex-1">
            <strong className="block text-sm text-[#111827]">{entitlements.nextAction.label}</strong>
            <span className="mt-1 block truncate text-xs text-[#667085]" title={entitlements.nextAction.detail}>{entitlements.nextAction.detail}</span>
          </span>
          <ArrowRight className="h-5 w-5 shrink-0 text-[#7a8981]" />
        </Link>
      </section>

      <details className="group border-y border-[#e1e8e3] bg-white" data-account-disclosure="plans">
        <AccountDisclosureSummary
          detail={`当前 ${user.plan.toUpperCase()} · ${usage.officialMinutesRemaining} 分钟可用`}
          icon={<CreditCard className="h-5 w-5" />}
          title="会员与额度"
        />
        <div className="border-t border-[#edf1ee] px-4 py-4">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm text-[#667085]">
              {simulatedPlanChangesEnabled
                ? "当前为开发验收环境，可测试模拟方案；也可以继续使用自己的模型。"
                : "Plus / Pro 真实购买尚未开放；当前可继续使用 Free 或配置自己的模型。"}
            </p>
            <Link className="shrink-0 text-sm font-semibold text-[#1f6f55]" href="/pricing">说明</Link>
          </div>
          <div className="mt-4 grid gap-2">
            {billingPlans.map((plan) => (
              <PlanRow
                active={user.plan === plan.id}
                busy={changingPlan === plan.id}
                disabled={!simulatedPlanChangesEnabled}
                key={plan.id}
                onSelect={() => void changePlan(plan.id)}
                plan={plan}
              />
            ))}
          </div>
          {planMessage ? <p className="mt-3 rounded-lg border border-[#b9d8c9] bg-[#effaf3] px-3 py-2 text-sm font-medium text-[#1f6f55]">{planMessage}</p> : null}
        </div>
      </details>

      <details className="group border-y border-[#e1e8e3] bg-white" data-account-disclosure="providers">
        <AccountDisclosureSummary
          detail={`已保存 ${providerCredentials.length} 组 · ${readyProviders} 组可用`}
          icon={<KeyRound className="h-5 w-5" />}
          title="模型配置"
        />
        <div className="border-t border-[#edf1ee] px-4 py-4">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm font-semibold text-[#111827]">连接状态</p>
            <button className="app-icon-button" disabled={checkingHealth} onClick={() => void refreshProviderHealth()} type="button" title="刷新">
              <RefreshCw className={checkingHealth ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
            </button>
          </div>
          <div className="mt-3 divide-y divide-[#edf1ee] border-y border-[#edf1ee]">
            {providerHealth.map((item) => (
              <div key={item.providerId} className="py-3">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-[#111827]">{item.label}</p>
                    <p className="mt-1 text-xs text-[#667085]">{item.canUseFor.length ? item.canUseFor.map(providerUseLabel).join(" / ") : "暂不可用"}</p>
                  </div>
                  <ProviderBadge status={item.status} />
                </div>
                {item.nextActions[0] ? <p className="mt-2 text-xs leading-5 text-[#667085]">{item.nextActions[0]}</p> : null}
              </div>
            ))}
          </div>
          <Link className="app-secondary-button mt-4 w-full" href="/settings">
            <KeyRound className="h-4 w-4" />
            配置自己的模型
          </Link>
        </div>
      </details>

      <Link className="flex min-h-16 items-center gap-3 border-y border-[#e1e8e3] bg-white px-4 py-3" href="/meetings" data-account-row="meetings">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[#eef6f1] text-[#1f6f55]"><FileText className="h-5 w-5" /></span>
        <span className="min-w-0 flex-1">
          <strong className="block text-sm text-[#111827]">会议记录</strong>
          <span className="mt-1 block text-xs leading-5 text-[#667085]">共 {meetings.length} 场 · {completedMeetings} 份纪要 · {publicMeetings} 个分享</span>
        </span>
        <ArrowRight className="h-5 w-5 shrink-0 text-[#7a8981]" />
      </Link>

      <details className="group border-y border-[#e1e8e3] bg-white" data-account-disclosure="security">
        <AccountDisclosureSummary detail="密码、数据导出、退出与删除" icon={<LockKeyhole className="h-5 w-5" />} title="账号与数据" />
        <div className="border-t border-[#edf1ee] px-4 py-4">
          <form onSubmit={submitPasswordChange}>
            <input aria-hidden="true" autoComplete="username" className="sr-only" name="username" readOnly tabIndex={-1} type="email" value={user.email} />
            <div>
              <p className="text-sm font-semibold text-[#111827]">修改密码</p>
              <p className="mt-1 text-xs leading-5 text-[#667085]">修改后会让其他设备的登录会话失效。</p>
            </div>
            <div className="mt-3 grid gap-2">
              <input autoComplete="current-password" className="auth-input" name="current-password" onChange={(event) => setPasswordForm((current) => ({ ...current, currentPassword: event.target.value }))} placeholder="当前密码" type="password" value={passwordForm.currentPassword} />
              <input autoComplete="new-password" className="auth-input" name="new-password" onChange={(event) => setPasswordForm((current) => ({ ...current, newPassword: event.target.value }))} placeholder="新密码，至少 8 位" type="password" value={passwordForm.newPassword} />
              <input autoComplete="new-password" className="auth-input" name="confirm-password" onChange={(event) => setPasswordForm((current) => ({ ...current, confirmPassword: event.target.value }))} placeholder="再次输入新密码" type="password" value={passwordForm.confirmPassword} />
            </div>
            {passwordMessage ? <p className="mt-3 rounded-lg bg-[#f7faf8] px-3 py-2 text-xs leading-5 text-[#667085]">{passwordMessage}</p> : null}
            <button className="app-secondary-button mt-3 w-full" disabled={changingPassword || !passwordForm.currentPassword || !passwordForm.newPassword || !passwordForm.confirmPassword} type="submit">
              <LockKeyhole className="h-4 w-4" />
              {changingPassword ? "修改中" : "更新密码"}
            </button>
          </form>
          <div className="mt-4 grid gap-2 border-t border-[#edf1ee] pt-4">
            <a className="app-secondary-button w-full" href="/api/account/export"><Download className="h-4 w-4" />导出账号摘要</a>
            <a className="app-secondary-button w-full" href="/api/account/export?scope=portable">
              <FileText className="h-4 w-4" />
              导出全部会议内容
            </a>
            <button className="app-secondary-button w-full" type="button" onClick={logout}><LogOut className="h-4 w-4" />退出登录</button>
            <button className="app-danger-button w-full" type="button" onClick={deleteAccount}><Trash2 className="h-4 w-4" />删除账号</button>
          </div>
          <p className="mt-3 text-xs leading-5 text-[#667085]">删除账号会清除会话、Provider 配置、用量流水、会议音频、纪要、Markdown 和公开分享链接。</p>
        </div>
      </details>

      <AppBottomNav active="account" />
    </div>
  );
}

function AccountMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 px-2">
      <p className="text-[11px] text-[#667085]">{label}</p>
      <p className="mt-1 truncate text-sm font-semibold text-[#111827]">{value}</p>
    </div>
  );
}

function AccountDisclosureSummary({ detail, icon, title }: { detail: string; icon: ReactNode; title: string }) {
  return (
    <summary className="flex min-h-16 cursor-pointer list-none items-center gap-3 px-4 py-3 [&::-webkit-details-marker]:hidden">
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[#eef6f1] text-[#1f6f55]">{icon}</span>
      <span className="min-w-0 flex-1">
        <strong className="block text-sm text-[#111827]">{title}</strong>
        <span className="mt-1 block truncate text-xs leading-5 text-[#667085]">{detail}</span>
      </span>
      <ChevronDown className="h-5 w-5 shrink-0 text-[#7a8981] transition-transform group-open:rotate-180" />
    </summary>
  );
}

function PlanRow({
  active,
  busy,
  disabled,
  onSelect,
  plan,
}: {
  active: boolean;
  busy: boolean;
  disabled: boolean;
  onSelect: () => void;
  plan: BillingPlan;
}) {
  return (
    <article className={`rounded-lg border p-3 ${active ? "border-[#1f6f55] bg-[#eef6f1]" : "border-[#e7ece8] bg-[#fbfcfb]"}`}>
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-[#111827]">{plan.name}</p>
          <p className="mt-1 text-xs text-[#667085]">{plan.minutes}</p>
        </div>
        <div className="text-right">
          <p className="text-sm font-semibold text-[#111827]">{plan.price}</p>
          <button className="mt-2 min-h-11 text-xs font-semibold text-[#1f6f55] disabled:text-[#98a2b3]" disabled={active || busy || disabled} onClick={onSelect} type="button">
            {active ? "当前" : disabled ? "未开放" : busy ? "切换中" : "选择"}
          </button>
        </div>
      </div>
    </article>
  );
}

function ProviderBadge({ status }: { status: ProviderHealthResult["status"] }) {
  if (status === "ready") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-[#effaf3] px-2.5 py-1 text-xs font-semibold text-[#1f6f55]">
        <CheckCircle2 className="h-3.5 w-3.5" />
        可用
      </span>
    );
  }

  const label = status === "failed" ? "失败" : status === "incomplete" ? "待补" : "未配置";
  return <span className="rounded-full bg-[#fff9e8] px-2.5 py-1 text-xs font-semibold text-[#76530a]">{label}</span>;
}

function entitlementStatusText(status: AccountEntitlements["status"]) {
  if (status === "ready") return "当前账号可以继续处理会议。";
  if (status === "attention") return "当前账号有可用路径，但建议补齐配置。";
  return "当前账号需要补额度或模型配置。";
}

function entitlementBadgeClass(status: AccountEntitlements["status"]) {
  if (status === "ready") return "rounded-full bg-[#effaf3] px-2.5 py-1 text-xs font-semibold text-[#1f6f55]";
  if (status === "attention") return "rounded-full bg-[#fff9e8] px-2.5 py-1 text-xs font-semibold text-[#76530a]";
  return "rounded-full bg-[#fff4f1] px-2.5 py-1 text-xs font-semibold text-[#9f3124]";
}

function processingRouteLabel(route: AccountEntitlements["preferredRoute"]) {
  if (route === "byok") return "自带模型";
  if (route === "hybrid") return "混合模式";
  return "官方额度";
}

function providerUseLabel(use: ProviderHealthResult["canUseFor"][number]) {
  if (use === "file_asr") return "会后识别";
  if (use === "realtime_asr") return "实时草稿";
  if (use === "summary") return "纪要总结";
  return use;
}
