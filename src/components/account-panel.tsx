"use client";

import type { AccountEntitlements, EntitlementStatus, ProcessingRoute } from "@/lib/account-entitlements";
import type { ProviderCredentialSummary, SafeUser, UserUsageSummary } from "@/lib/server/auth-repository";
import type { ProviderHealthResult } from "@/lib/provider-health";
import { billingPlans, type BillingPlan } from "@/lib/billing-plans";
import {
  ArrowRight,
  BookOpenCheck,
  CheckCircle2,
  CircleDollarSign,
  Download,
  KeyRound,
  LogOut,
  Mic,
  RefreshCw,
  Save,
  Settings2,
  Sparkles,
  Trash2,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { type FormEvent, type ReactNode, useState } from "react";

type AccountPanelProps = {
  user: SafeUser;
  usage: UserUsageSummary;
  entitlements: AccountEntitlements;
  providerCredentials: ProviderCredentialSummary[];
  providerHealth: ProviderHealthResult[];
};

export function AccountPanel({ user, usage, entitlements, providerCredentials, providerHealth: initialProviderHealth }: AccountPanelProps) {
  const router = useRouter();
  const [providerId, setProviderId] = useState("volcano-asr");
  const [appId, setAppId] = useState("");
  const [asrResourceId, setAsrResourceId] = useState("volc.seedasr.auc");
  const [asrToken, setAsrToken] = useState("");
  const [asrWsUrl, setAsrWsUrl] = useState("wss://openspeech.bytedance.com/api/v3/sauc/bigmodel");
  const [apiKey, setApiKey] = useState("");
  const [model, setModel] = useState("");
  const [arkBaseUrl, setArkBaseUrl] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [planMessage, setPlanMessage] = useState<string | null>(null);
  const [healthMessage, setHealthMessage] = useState<string | null>(null);
  const [providerHealth, setProviderHealth] = useState(initialProviderHealth);
  const [saving, setSaving] = useState(false);
  const [changingPlan, setChangingPlan] = useState<string | null>(null);
  const [checkingHealth, setCheckingHealth] = useState(false);

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  }

  async function deleteAccount() {
    const confirmed = window.confirm("确认删除当前账号？系统会删除会话、Provider 配置、用量流水、会议音频、纪要、Markdown 和公开分享链接。");
    if (!confirmed) return;

    await fetch("/api/auth/delete", { method: "DELETE" });
    router.push("/register");
    router.refresh();
  }

  async function saveProvider(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setMessage(null);

    try {
      const response = await fetch("/api/account/provider-credentials", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          providerId,
          label: providerId === "volcano-ark" ? "火山方舟" : "火山语音识别",
          fields: {
            VOLCANO_ASR_APP_ID: providerId === "volcano-asr" ? appId : "",
            VOLCANO_ASR_RESOURCE_ID: providerId === "volcano-asr" ? asrResourceId : "",
            VOLCANO_ASR_WS_URL: providerId === "volcano-asr" ? asrWsUrl : "",
            ARK_CHAT_MODEL: providerId === "volcano-ark" ? model : "",
            ARK_BASE_URL: providerId === "volcano-ark" ? arkBaseUrl : "",
          },
          secrets: {
            VOLCANO_ASR_API_KEY: providerId === "volcano-asr" ? apiKey : "",
            VOLCANO_ASR_TOKEN: providerId === "volcano-asr" ? asrToken : "",
            ARK_API_KEY: providerId === "volcano-ark" ? apiKey : "",
          },
        }),
      });
      const payload = await response.json();

      if (!response.ok || !payload.ok) {
        setMessage(payload.error || "保存失败。");
        return;
      }

      setApiKey("");
      setAsrToken("");
      setMessage("Provider 配置已加密保存。页面不会回显密钥原文。");
      await refreshProviderHealth(false);
      router.refresh();
    } catch {
      setMessage("保存请求失败，请确认本地服务正在运行。");
    } finally {
      setSaving(false);
    }
  }

  async function refreshProviderHealth(live: boolean) {
    setCheckingHealth(true);
    setHealthMessage(null);

    try {
      const response = await fetch(live ? "/api/account/provider-health?providerId=volcano-ark&live=1" : "/api/account/provider-health", { cache: "no-store" });
      const payload = await response.json();

      if (!response.ok || !payload.ok) {
        setHealthMessage(payload.error || "健康检查失败。");
        return;
      }

      const nextHealth = payload.health || [];
      setProviderHealth(live ? mergeProviderHealth(providerHealth, nextHealth) : nextHealth);
      setHealthMessage(live ? "真实连通测试已完成。" : "健康状态已刷新。");
    } catch {
      setHealthMessage("健康检查请求失败。");
    } finally {
      setCheckingHealth(false);
    }
  }

  async function changePlan(planId: BillingPlan["id"]) {
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
        setPlanMessage(payload.error || "方案更新失败。");
        return;
      }

      setPlanMessage("方案已更新。正式上架后这里会接入 Apple IAP 或服务端订单。");
      router.refresh();
    } catch {
      setPlanMessage("方案更新请求失败。");
    } finally {
      setChangingPlan(null);
    }
  }

  const usedRatio = usage.officialMinutesTotal > 0 ? Math.min(100, Math.round((usage.officialMinutesUsed / usage.officialMinutesTotal) * 100)) : 0;
  const hasProviderConfig = providerCredentials.length > 0;
  const hasReadyProvider = providerHealth.some((item) => item.status === "ready");
  const hasCompletedMeeting = usage.officialMinutesUsed > 0;
  const canSaveProvider =
    providerId === "volcano-asr"
      ? Boolean(apiKey.trim() || (appId.trim() && asrToken.trim()))
      : Boolean(apiKey.trim() && model.trim());

  return (
    <section className="mt-5 grid gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
      <div className="space-y-4">
        <div className="rounded-lg border border-[#d9ded8] bg-white p-5 shadow-sm">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <h2 className="text-lg font-semibold">账号概览</h2>
              <p className="mt-1 text-sm text-[#667085]">{user.email}</p>
            </div>
            <span className="w-fit rounded-md bg-[#eef6f1] px-2 py-1 text-xs font-semibold text-[#1f6f55]">
              {user.role === "admin" ? "管理员" : "普通用户"}
            </span>
          </div>

          <div className="mt-4 divide-y divide-[#edf0ed] rounded-md border border-[#e1e6e0]">
            <InfoRow label="显示名称" value={user.name} />
            <InfoRow label="当前方案" value={user.plan.toUpperCase()} />
            <InfoRow label="官方额度" value={`${usage.officialMinutesRemaining} / ${usage.officialMinutesTotal} 分钟可用`} />
            <InfoRow label="Provider 配置" value={`${providerCredentials.length} 组已保存`} />
          </div>

          <div className="mt-4 rounded-md border border-[#d9ded8] bg-[#f7faf8] p-3">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-sm font-semibold text-[#111827]">成本模式</h3>
              <span className="rounded-md bg-white px-2 py-1 text-xs font-semibold text-[#1f6f55]">{costModeLabel(usage.costControl.mode)}</span>
            </div>
            <div className="mt-3 grid gap-2 sm:grid-cols-3">
              <SmallMetric label="当前费用" value={usage.costControl.currentPlanPrice} />
              <SmallMetric label="官方单价" value={usage.costControl.officialMinuteUnitPrice} />
              <SmallMetric label="BYOK 配置" value={`${usage.costControl.providerCredentialCount} 组`} />
            </div>
            <p className="mt-3 text-xs leading-5 text-[#667085]">{usage.costControl.recommendation}</p>
          </div>

          <div className="mt-4">
            <div className="flex items-center justify-between text-xs text-[#667085]">
              <span>官方额度使用</span>
              <span>{usedRatio}%</span>
            </div>
            <div className="mt-2 h-2 overflow-hidden rounded-full bg-[#edf0ed]">
              <div className="h-full rounded-full bg-[#1f6f55]" style={{ width: `${usedRatio}%` }} />
            </div>
          </div>

          <div className="mt-4 rounded-md border border-[#e1e6e0] bg-[#fbfcfb] p-3">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-sm font-semibold text-[#111827]">近期用量</h3>
              <span className="text-xs text-[#667085]">最近 {usage.events.length} 条</span>
            </div>
            <div className="mt-3 space-y-2">
              {usage.events.length ? (
                usage.events.slice(0, 5).map((event) => (
                  <div key={event.id} className="flex items-start justify-between gap-3 border-t border-[#edf0ed] pt-2 first:border-t-0 first:pt-0">
                    <div>
                      <p className="text-xs font-semibold text-[#344054]">{usageEventLabel(event.type)}</p>
                      <p className="mt-1 text-xs text-[#667085]">{formatUsageNote(event.note)}</p>
                    </div>
                    <div className="text-right">
                      <p className={event.minutes > 0 && event.type === "meeting_finalize" ? "text-xs font-semibold text-[#a63a32]" : "text-xs font-semibold text-[#1f6f55]"}>
                        {formatUsageMinutes(event)}
                      </p>
                      <p className="mt-1 text-xs text-[#667085]">{formatDateTime(event.createdAt)}</p>
                    </div>
                  </div>
                ))
              ) : (
                <p className="text-sm text-[#667085]">还没有额度流水。</p>
              )}
            </div>
          </div>
        </div>

        <section className="rounded-lg border border-[#d9ded8] bg-white p-5 shadow-sm">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <h2 className="text-lg font-semibold">会议处理资格</h2>
              <p className="mt-1 text-sm leading-6 text-[#667085]">系统会根据官方额度和 BYOK 配置判断当前账号是否还能继续处理会议。</p>
            </div>
            <span className={entitlementBadgeClass(entitlements.status)}>{entitlementStatusLabel(entitlements.status)}</span>
          </div>

          <div className="mt-4 grid gap-2 sm:grid-cols-3">
            <SmallMetric label="推荐路径" value={processingRouteLabel(entitlements.preferredRoute)} />
            <SmallMetric label="官方剩余" value={`${entitlements.officialQuota.remainingMinutes} 分钟`} />
            <SmallMetric label="BYOK" value={entitlements.byok.configured ? `${entitlements.byok.providerCredentialCount} 组` : "未配置"} />
          </div>

          <div className="mt-4 rounded-md border border-[#d9ded8] bg-[#f7faf8] p-3">
            <p className="text-xs font-semibold text-[#344054]">下一步</p>
            <p className="mt-1 text-sm leading-6 text-[#111827]">{entitlements.nextAction.detail}</p>
            <Link className="primary-action mt-3 h-9 w-full justify-center" href={entitlements.nextAction.href}>
              {entitlements.nextAction.label}
              <ArrowRight className="h-4 w-4" />
            </Link>
          </div>

          <div className="mt-4 grid gap-3 md:grid-cols-3">
            {entitlements.routes.map((route) => (
              <ProcessingRouteCard key={route.id} route={route} />
            ))}
          </div>
        </section>

        <section className="rounded-lg border border-[#d9ded8] bg-white p-5 shadow-sm">
          <div className="flex items-start gap-3">
            <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-[#eef6f1] text-[#1f6f55]">
              <CircleDollarSign className="h-5 w-5" />
            </span>
            <div>
              <h2 className="text-lg font-semibold">选择使用方式</h2>
              <p className="mt-1 text-sm leading-6 text-[#667085]">Plus / Pro 真实购买尚未开放；当前可继续使用 Free 或配置自己的模型。</p>
            </div>
          </div>

          <div className="mt-4 grid gap-3 xl:grid-cols-3">
            {billingPlans.map((plan) => (
              <PlanOption
                key={plan.id}
                plan={plan}
                active={user.plan === plan.id}
                busy={changingPlan === plan.id}
                onSelect={() => void changePlan(plan.id)}
              />
            ))}
          </div>

          {planMessage ? <p className="mt-3 rounded-md border border-[#b9d8c9] bg-[#effaf3] px-3 py-2 text-sm font-medium text-[#1f6f55]">{planMessage}</p> : null}
        </section>

        <form className="rounded-lg border border-[#d9ded8] bg-white p-5 shadow-sm" onSubmit={saveProvider}>
          <div className="flex items-start gap-3">
            <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-[#eef6f1] text-[#1f6f55]">
              <KeyRound className="h-5 w-5" />
            </span>
            <div>
              <h2 className="text-lg font-semibold">保存 BYOK 配置</h2>
              <p className="mt-1 text-sm leading-6 text-[#667085]">
                保存后会优先用于登录用户的会后识别和纪要总结；页面不会回显密钥原文。
                <Link className="ml-1 font-semibold text-[#1f6f55]" href="/settings">查看配置向导</Link>
              </p>
            </div>
          </div>

          <div className="mt-4 grid gap-3">
            <label className="block">
              <span className="mb-1 block text-sm font-semibold text-[#344054]">Provider</span>
              <select className="auth-input" value={providerId} onChange={(event) => setProviderId(event.target.value)}>
                <option value="volcano-asr">火山语音识别</option>
                <option value="volcano-ark">火山方舟</option>
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-sm font-semibold text-[#344054]">{providerId === "volcano-ark" ? "模型 / Endpoint ID" : "ASR AppID（可选）"}</span>
              <input className="auth-input" value={providerId === "volcano-ark" ? model : appId} onChange={(event) => (providerId === "volcano-ark" ? setModel(event.target.value) : setAppId(event.target.value))} />
            </label>
            {providerId === "volcano-ark" ? (
              <label className="block">
                <span className="mb-1 block text-sm font-semibold text-[#344054]">Ark Base URL（可选）</span>
                <input className="auth-input" value={arkBaseUrl} onChange={(event) => setArkBaseUrl(event.target.value)} placeholder="https://ark.cn-beijing.volces.com/api/v3" />
              </label>
            ) : null}
            <label className="block">
              <span className="mb-1 block text-sm font-semibold text-[#344054]">{providerId === "volcano-ark" ? "Ark API Key" : "ASR API Key"}</span>
              <input className="auth-input" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder="保存后只显示掩码" type="password" />
            </label>
            {providerId === "volcano-asr" ? (
              <>
                <label className="block">
                  <span className="mb-1 block text-sm font-semibold text-[#344054]">ASR Token（可选）</span>
                  <input className="auth-input" value={asrToken} onChange={(event) => setAsrToken(event.target.value)} placeholder="如果不用 ASR API Key，可填写 AppID + Token" type="password" />
                </label>
                <label className="block">
                  <span className="mb-1 block text-sm font-semibold text-[#344054]">实时 ASR WebSocket URL（可选）</span>
                  <input className="auth-input" value={asrWsUrl} onChange={(event) => setAsrWsUrl(event.target.value)} placeholder="wss://openspeech.bytedance.com/api/v3/sauc/bigmodel" />
                </label>
                <label className="block">
                  <span className="mb-1 block text-sm font-semibold text-[#344054]">ASR Resource ID（可选）</span>
                  <input className="auth-input" value={asrResourceId} onChange={(event) => setAsrResourceId(event.target.value)} placeholder="volc.seedasr.auc" />
                </label>
              </>
            ) : null}
          </div>

          {message ? <p className="mt-3 rounded-md border border-[#b9d8c9] bg-[#effaf3] px-3 py-2 text-sm font-medium text-[#1f6f55]">{message}</p> : null}

          <button className="primary-action mt-4 w-full justify-center" disabled={saving || !canSaveProvider} type="submit">
            <Save className="h-4 w-4" />
            {saving ? "保存中" : "加密保存配置"}
          </button>
        </form>
      </div>

      <div className="space-y-4">
        <TrialPathCard
          costMode={usage.costControl.mode}
          hasCompletedMeeting={hasCompletedMeeting}
          hasProviderConfig={hasProviderConfig}
          hasReadyProvider={hasReadyProvider}
          isPaidPlan={user.plan !== "free"}
          officialMinutesRemaining={usage.officialMinutesRemaining}
        />

        <div className="rounded-lg border border-[#d9ded8] bg-white p-5 shadow-sm">
          <h2 className="text-lg font-semibold">已保存 Provider</h2>
          <div className="mt-4 space-y-3">
            {providerCredentials.length ? (
              providerCredentials.map((credential) => (
                <div key={credential.id} className="rounded-md border border-[#e1e6e0] bg-[#fbfcfb] p-3">
                  <p className="text-sm font-semibold">{credential.label}</p>
                  <p className="mt-1 font-mono text-xs text-[#667085]">{credential.providerId}</p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    {credential.configuredSecrets.map((secret) => (
                      <span key={secret} className="rounded-md bg-[#eef6f1] px-2 py-1 text-xs font-semibold text-[#1f6f55]">
                        {secret}: {credential.secretPreviews[secret] || "已保存"}
                      </span>
                    ))}
                  </div>
                </div>
              ))
            ) : (
              <p className="rounded-md border border-dashed border-[#ccd3ce] p-3 text-sm leading-6 text-[#667085]">还没有保存用户级 Provider。你可以继续使用服务器 `.env.local`，也可以在这里验证 BYOK 流程。</p>
            )}
          </div>
        </div>

        <div className="rounded-lg border border-[#d9ded8] bg-white p-5 shadow-sm">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold">Provider 健康检查</h2>
              <p className="mt-1 text-sm leading-6 text-[#667085]">当前为配置预检，不主动消耗 ASR 识别额度。</p>
            </div>
            <button className="secondary-action shrink-0" disabled={checkingHealth} type="button" onClick={() => void refreshProviderHealth(false)}>
              <RefreshCw className="h-4 w-4" />
              {checkingHealth ? "检查中" : "刷新"}
            </button>
            <button className="secondary-action shrink-0" disabled={checkingHealth} type="button" onClick={() => void refreshProviderHealth(true)}>
              真实测试
            </button>
          </div>

          {healthMessage ? <p className="mt-3 rounded-md border border-[#d9ded8] bg-[#fbfcfb] px-3 py-2 text-sm font-medium text-[#344054]">{healthMessage}</p> : null}

          <div className="mt-4 space-y-3">
            {providerHealth.map((item) => (
              <div key={item.providerId} className="rounded-md border border-[#e1e6e0] bg-[#fbfcfb] p-3">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <p className="text-sm font-semibold">{item.label}</p>
                    <p className="mt-1 font-mono text-xs text-[#667085]">{item.providerId}</p>
                  </div>
                  <span className={providerHealthBadgeClass(item.status)}>{providerHealthLabel(item.status)}</span>
                </div>
                <p className="mt-3 text-xs leading-5 text-[#667085]">
                  用途：{item.canUseFor.length ? item.canUseFor.map(providerUseLabel).join(" / ") : "暂不可用"} · {item.liveChecked ? "已真实连通测试" : "配置预检"}
                </p>
                <div className="mt-3 space-y-2">
                  {item.checks.slice(0, 3).map((check) => (
                    <p key={check.id} className={check.ok ? "text-xs leading-5 text-[#1f6f55]" : "text-xs leading-5 text-[#9a5b13]"}>
                      {check.ok ? "通过" : "待补"}：{check.label}，{check.detail}
                    </p>
                  ))}
                </div>
                {item.nextActions[0] ? <p className="mt-3 rounded-md bg-[#f3f5f2] px-3 py-2 text-xs leading-5 text-[#344054]">{item.nextActions[0]}</p> : null}
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-lg border border-[#d9ded8] bg-white p-5 shadow-sm">
          <h2 className="text-lg font-semibold">账号操作</h2>
          <div className="mt-4 grid gap-2">
            <a className="secondary-action w-full justify-center" href="/api/account/export">
              <Download className="h-4 w-4" />
              导出我的数据
            </a>
            <button className="secondary-action w-full justify-center" type="button" onClick={logout}>
              <LogOut className="h-4 w-4" />
              退出登录
            </button>
            <button className="danger-action w-full justify-center" type="button" onClick={deleteAccount}>
              <Trash2 className="h-4 w-4" />
              删除账号
            </button>
          </div>
          <p className="mt-3 text-xs leading-5 text-[#667085]">
            数据导出只包含账号、用量、Provider 掩码摘要和会议清单，不包含密钥原文。删除账号会清除会话、Provider 配置、用量流水、会议音频、纪要、Markdown 和公开分享链接。
            <Link className="ml-1 font-semibold text-[#1f6f55]" href="/data-deletion">查看数据删除说明</Link>
          </p>
        </div>

        <a className="secondary-action w-full justify-center" href="/pricing">
          查看会员方案
          <ArrowRight className="h-4 w-4" />
        </a>
      </div>
    </section>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4 px-3 py-3">
      <span className="text-sm text-[#667085]">{label}</span>
      <span className="text-right text-sm font-semibold text-[#111827]">{value}</span>
    </div>
  );
}

function SmallMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-[#e1e6e0] bg-white px-3 py-2">
      <p className="text-xs text-[#667085]">{label}</p>
      <p className="mt-1 text-sm font-semibold text-[#111827]">{value}</p>
    </div>
  );
}

function costModeLabel(mode: UserUsageSummary["costControl"]["mode"]) {
  if (mode === "byok") return "自带模型";
  if (mode === "hybrid") return "混合模式";
  return "官方额度";
}

function providerHealthLabel(status: ProviderHealthResult["status"]) {
  if (status === "ready") return "可用";
  if (status === "incomplete") return "待补";
  if (status === "failed") return "失败";
  return "未配置";
}

function providerUseLabel(use: ProviderHealthResult["canUseFor"][number]) {
  if (use === "file_asr") return "会后识别";
  if (use === "realtime_asr") return "实时草稿";
  return "纪要总结";
}

function providerHealthBadgeClass(status: ProviderHealthResult["status"]) {
  if (status === "ready") return "rounded-md bg-[#eef6f1] px-2 py-1 text-xs font-semibold text-[#1f6f55]";
  if (status === "failed") return "rounded-md bg-[#fff1f0] px-2 py-1 text-xs font-semibold text-[#a63a32]";
  return "rounded-md bg-[#edf0ed] px-2 py-1 text-xs font-semibold text-[#665b4c]";
}

function entitlementStatusLabel(status: EntitlementStatus) {
  if (status === "ready") return "可继续使用";
  if (status === "attention") return "需要关注";
  return "已阻断";
}

function entitlementBadgeClass(status: EntitlementStatus) {
  if (status === "ready") return "w-fit rounded-md bg-[#eef6f1] px-2 py-1 text-xs font-semibold text-[#1f6f55]";
  if (status === "attention") return "w-fit rounded-md bg-[#fff9e8] px-2 py-1 text-xs font-semibold text-[#76530a]";
  return "w-fit rounded-md bg-[#fff1f0] px-2 py-1 text-xs font-semibold text-[#a63a32]";
}

function processingRouteLabel(route: AccountEntitlements["preferredRoute"]) {
  if (route === "byok") return "自带模型";
  if (route === "hybrid") return "混合模式";
  return "官方额度";
}

function ProcessingRouteCard({ route }: { route: ProcessingRoute }) {
  return (
    <div className={`rounded-md border p-3 ${route.available ? "border-[#b9d8c9] bg-[#f7faf8]" : "border-[#e1e6e0] bg-[#fbfcfb]"}`}>
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-semibold">{route.label}</p>
        <span className={route.available ? "rounded-md bg-[#eef6f1] px-2 py-0.5 text-[11px] font-semibold text-[#1f6f55]" : "rounded-md bg-[#edf0ed] px-2 py-0.5 text-[11px] font-semibold text-[#667085]"}>
          {route.available ? "可用" : "未就绪"}
        </span>
      </div>
      <p className="mt-2 text-xs leading-5 text-[#667085]">{route.detail}</p>
    </div>
  );
}

function usageEventLabel(type: UserUsageSummary["events"][number]["type"]) {
  if (type === "register_bonus") return "注册赠送";
  if (type === "meeting_finalize") return "会议处理";
  return "方案调整";
}

function formatUsageMinutes(event: UserUsageSummary["events"][number]) {
  if (event.type === "register_bonus") return `+${event.minutes} 分钟`;
  if (event.type === "meeting_finalize") return `-${event.minutes} 分钟`;
  return "额度重算";
}

function formatUsageNote(note: string) {
  if (note.includes("Free plan official trial quota")) return "Free 方案官方体验额度";
  if (note.startsWith("Changed plan to ")) return `切换到 ${note.replace("Changed plan to ", "").toUpperCase()} 方案`;
  if (note.includes("meeting:")) return `会议 ${note.split("meeting:")[1] || ""}`.trim();
  return note;
}

function formatDateTime(value: string) {
  return new Date(value).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function mergeProviderHealth(current: ProviderHealthResult[], updates: ProviderHealthResult[]) {
  const updateMap = new Map(updates.map((item) => [item.providerId, item]));
  const merged = current.map((item) => updateMap.get(item.providerId) ?? item);
  const currentIds = new Set(current.map((item) => item.providerId));

  return [...merged, ...updates.filter((item) => !currentIds.has(item.providerId))];
}

function PlanOption({
  plan,
  active,
  busy,
  onSelect,
}: {
  plan: BillingPlan;
  active: boolean;
  busy: boolean;
  onSelect: () => void;
}) {
  return (
    <article className={`rounded-md border p-3 ${active ? "border-[#1f6f55] bg-[#eef6f1]" : "border-[#e1e6e0] bg-[#fbfcfb]"}`}>
      <div className="flex items-start justify-between gap-2">
        <div>
          <p className="text-sm font-semibold">{plan.name}</p>
          <p className="mt-1 text-xl font-semibold">{plan.price}</p>
        </div>
        {active ? <CheckCircle2 className="h-5 w-5 text-[#1f6f55]" /> : plan.highlight ? <Sparkles className="h-5 w-5 text-[#946200]" /> : null}
      </div>
      <p className="mt-2 text-xs leading-5 text-[#667085]">{plan.minutes}</p>
      <button className={active ? "secondary-action mt-3 h-9 w-full justify-center" : "primary-action mt-3 h-9 w-full justify-center"} disabled={active || busy} type="button" onClick={onSelect}>
        {active ? "当前方案" : busy ? "切换中" : "选择"}
      </button>
    </article>
  );
}

function TrialPathCard({
  costMode,
  hasCompletedMeeting,
  hasProviderConfig,
  hasReadyProvider,
  isPaidPlan,
  officialMinutesRemaining,
}: {
  costMode: UserUsageSummary["costControl"]["mode"];
  hasCompletedMeeting: boolean;
  hasProviderConfig: boolean;
  hasReadyProvider: boolean;
  isPaidPlan: boolean;
  officialMinutesRemaining: number;
}) {
  const nextAction = getTrialPathNextAction({
    hasCompletedMeeting,
    hasProviderConfig,
    hasReadyProvider,
    isPaidPlan,
    officialMinutesRemaining,
  });
  const steps = [
    {
      done: officialMinutesRemaining > 0 || isPaidPlan,
      detail: officialMinutesRemaining > 0 ? `还有 ${officialMinutesRemaining} 分钟官方额度，可直接试用。` : "官方额度已用完，建议配置 BYOK 或升级方案。",
      href: "/pricing",
      icon: <CircleDollarSign className="h-4 w-4" />,
      title: "获得可用额度",
    },
    {
      done: hasProviderConfig,
      detail: hasProviderConfig ? "已保存用户级 Provider，后续可优先走自带模型。" : "想长期低成本使用，先保存火山 ASR / 方舟 Key。",
      href: "/settings",
      icon: <KeyRound className="h-4 w-4" />,
      title: "配置 BYOK",
    },
    {
      done: hasReadyProvider,
      detail: hasReadyProvider ? "至少一组 Provider 预检可用。" : hasProviderConfig ? "已保存配置，建议刷新健康检查确认字段是否完整。" : "保存 Provider 后再做健康检查。",
      href: "/account",
      icon: <Settings2 className="h-4 w-4" />,
      title: "健康检查",
    },
    {
      done: hasCompletedMeeting,
      detail: hasCompletedMeeting ? "已跑过一次会后处理，用量流水已产生。" : "去工作台跑 1 分钟测试，确认录音、上传、纪要和 Markdown。",
      href: "/app",
      icon: <Mic className="h-4 w-4" />,
      title: "短会测试",
    },
    {
      done: isPaidPlan,
      detail: isPaidPlan ? "已进入会员/额度路径。" : "低频用户可继续免费 BYOK；怕麻烦再开 Plus 或 Pro。",
      href: "/pricing",
      icon: <BookOpenCheck className="h-4 w-4" />,
      title: "省心升级",
    },
  ];
  const completed = steps.filter((step) => step.done).length;

  return (
    <div className="rounded-lg border border-[#d9ded8] bg-white p-5 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">试用路径</h2>
          <p className="mt-1 text-sm leading-6 text-[#667085]">
            当前是 {costModeLabel(costMode)}。目标是先跑通一次短会，再决定继续 BYOK 控成本还是开官方额度省配置。
          </p>
        </div>
        <span className="shrink-0 rounded-md bg-[#eef6f1] px-2 py-1 text-xs font-semibold text-[#1f6f55]">
          {completed} / {steps.length}
        </span>
      </div>

      <div className="mt-4 rounded-md border border-[#d9ded8] bg-[#f7faf8] p-3">
        <p className="text-xs font-semibold text-[#344054]">现在最该做</p>
        <p className="mt-1 text-sm leading-6 text-[#111827]">{nextAction.detail}</p>
        <Link className="primary-action mt-3 h-9 w-full justify-center" href={nextAction.href}>
          {nextAction.label}
          <ArrowRight className="h-4 w-4" />
        </Link>
      </div>

      <div className="mt-4 space-y-3">
        {steps.map((step) => (
          <TrialStep key={step.title} {...step} />
        ))}
      </div>
    </div>
  );
}

function getTrialPathNextAction({
  hasCompletedMeeting,
  hasProviderConfig,
  hasReadyProvider,
  isPaidPlan,
  officialMinutesRemaining,
}: {
  hasCompletedMeeting: boolean;
  hasProviderConfig: boolean;
  hasReadyProvider: boolean;
  isPaidPlan: boolean;
  officialMinutesRemaining: number;
}) {
  if (officialMinutesRemaining <= 0 && !hasProviderConfig && !isPaidPlan) {
    return {
      detail: "官方体验额度已用完。先配置 BYOK 或切换 Plus，避免测试卡在额度上。",
      href: "/pricing",
      label: "选择额度方案",
    };
  }

  if (!hasProviderConfig && !hasCompletedMeeting) {
    return {
      detail: "你可以先用官方体验额度跑 1 分钟测试；如果目标是长期低成本，再回来保存 BYOK。",
      href: "/app",
      label: "去跑短会测试",
    };
  }

  if (hasProviderConfig && !hasReadyProvider) {
    return {
      detail: "已保存 Provider，但还需要健康检查确认 ASR 和总结能力可用。",
      href: "/account",
      label: "查看健康检查",
    };
  }

  if (!hasCompletedMeeting) {
    return {
      detail: "配置路径已基本就绪。现在跑一次短会，检查结果清单是否全部通过。",
      href: "/app",
      label: "开始 1 分钟测试",
    };
  }

  if (!isPaidPlan) {
    return {
      detail: "首场会议已完成。免费 BYOK 可以继续用；如果要面向不懂配置的用户，需要验证 Plus 省心路径。",
      href: "/pricing",
      label: "查看会员路径",
    };
  }

  return {
    detail: "账号、试用和会员路径都已验证。下一步可以进入正式会议或检查后台用户增长数据。",
    href: "/app",
    label: "进入工作台",
  };
}

function TrialStep({
  detail,
  done,
  href,
  icon,
  title,
}: {
  detail: string;
  done: boolean;
  href: string;
  icon: ReactNode;
  title: string;
}) {
  return (
    <a className="block rounded-md border border-[#e1e6e0] bg-[#fbfcfb] p-3 hover:bg-white" href={href}>
      <div className="flex items-start gap-3">
        <span className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-md ${done ? "bg-[#1f6f55] text-white" : "bg-[#edf0ed] text-[#667085]"}`}>
          {done ? <CheckCircle2 className="h-4 w-4" /> : icon}
        </span>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-sm font-semibold">{title}</p>
            <span className={`rounded-md px-2 py-0.5 text-[11px] font-semibold ${done ? "bg-[#eef6f1] text-[#1f6f55]" : "bg-[#fff9e8] text-[#76530a]"}`}>
              {done ? "已完成" : "待处理"}
            </span>
          </div>
          <p className="mt-1 text-xs leading-5 text-[#667085]">{detail}</p>
        </div>
      </div>
    </a>
  );
}
