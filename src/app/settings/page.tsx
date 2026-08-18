import { ArrowRight, CheckCircle2, ChevronDown, Circle, CircleDollarSign, ExternalLink, KeyRound, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { AppBottomNav } from "@/components/app-bottom-nav";
import { ProviderSetupWizard } from "@/components/provider-setup-wizard";
import { getProviderSetupReport, getUserProviderHealth } from "@/lib/provider-health";
import { listProviderCredentials } from "@/lib/server/auth-repository";
import { getCurrentUser } from "@/lib/server/current-user";

export const dynamic = "force-dynamic";

const setupSteps = [
  {
    detail: "在火山控制台开通语音识别，复制 ASR API Key，或 AppID 与 Token。",
    title: "连接会议转写",
  },
  {
    detail: "在方舟控制台创建模型 Endpoint，保存 Ark API Key 与 Endpoint ID。",
    title: "连接纪要模型",
  },
  {
    detail: "配置完成后录一段短会，结束后检查逐字稿和正式纪要。",
    title: "完成一次验证",
  },
];

export default async function SettingsPage() {
  const user = await getCurrentUser();
  const [providerCredentials, providerHealth] = user
    ? await Promise.all([listProviderCredentials(user.id), getUserProviderHealth(user.id)])
    : [[], []];
  const setupReport = getProviderSetupReport(providerHealth);

  return (
    <main className="min-h-screen bg-[#e8eeeb] text-[#111827] sm:py-5">
      <div className="ownminutes-mobile-shell relative mx-auto min-h-screen w-full max-w-[430px] bg-[#f7faf8] pb-28 shadow-[0_24px_70px_rgba(15,23,42,0.12)] sm:min-h-[860px] sm:overflow-hidden sm:rounded-lg sm:border sm:border-white/70" data-settings-ui="native-list-v27">
        <header className="sticky top-0 z-20 bg-[#f7faf8]/95 px-5 pb-3 pt-5 backdrop-blur" data-primary-tab-header="settings">
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0 flex-1">
              <h1 className="truncate text-2xl font-semibold text-[#111827]">模型与服务</h1>
            </div>
            <Link className="app-icon-button" href="/pricing" title="方案与成本">
              <CircleDollarSign className="h-4 w-4" />
            </Link>
          </div>
        </header>

        <div className="space-y-3 px-4 py-3">
          <section className="border-y border-[#e1e8e3] bg-white px-4 py-4" data-settings-section="provider-status">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-xs font-semibold text-[#1f6f55]">自带模型</p>
                <h2 className="mt-1 text-lg font-semibold text-[#111827]">按自己的用量控制成本</h2>
                <p className="mt-1 text-sm leading-6 text-[#667085]">密钥加密保存在后端，不会在页面回显。</p>
              </div>
              <KeyRound className="mt-1 h-5 w-5 shrink-0 text-[#1f6f55]" />
            </div>
            <div className="mt-4 divide-y divide-[#edf1ee] border-y border-[#edf1ee]">
              <SetupStatus label="会议转写" ready={setupReport.hasFileAsr} />
              <SetupStatus label="纪要生成" ready={setupReport.hasSummary} />
            </div>
          </section>

          <details className="group border-y border-[#e1e8e3] bg-white" data-settings-disclosure="provider">
            <summary className="flex min-h-16 cursor-pointer list-none items-center gap-3 px-4 py-3 [&::-webkit-details-marker]:hidden">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[#eef6f1] text-[#1f6f55]">
                <KeyRound className="h-5 w-5" />
              </span>
              <span className="min-w-0 flex-1">
                <strong className="block text-sm text-[#111827]">配置自己的模型</strong>
                <span className="mt-1 block text-xs leading-5 text-[#667085]">添加火山语音与方舟 Key</span>
              </span>
              <ChevronDown className="h-5 w-5 shrink-0 text-[#7a8981] transition-transform group-open:rotate-180" />
            </summary>
            <div className="border-t border-[#edf1ee] bg-[#f7faf8] px-3 py-3">
              <ProviderSetupWizard userEmail={user?.email ?? null} providerCredentials={providerCredentials} providerHealth={providerHealth} />
            </div>
          </details>

          <details className="group border-y border-[#e1e8e3] bg-white" data-settings-disclosure="guide">
            <summary className="flex min-h-16 cursor-pointer list-none items-center gap-3 px-4 py-3 [&::-webkit-details-marker]:hidden">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[#f2f4f2] text-[#506159]">
                <ShieldCheck className="h-5 w-5" />
              </span>
              <span className="min-w-0 flex-1">
                <strong className="block text-sm text-[#111827]">第一次配置</strong>
                <span className="mt-1 block text-xs leading-5 text-[#667085]">查看三步配置说明和控制台入口</span>
              </span>
              <ChevronDown className="h-5 w-5 shrink-0 text-[#7a8981] transition-transform group-open:rotate-180" />
            </summary>
            <div className="space-y-3 border-t border-[#edf1ee] px-4 py-4">
              {setupSteps.map((step, index) => (
                <div className="flex gap-3" key={step.title}>
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[#eef6f1] text-sm font-semibold text-[#1f6f55]">
                    {index + 1}
                  </span>
                  <div className="pb-1">
                    <p className="text-sm font-semibold text-[#111827]">{step.title}</p>
                    <p className="mt-1 text-xs leading-5 text-[#667085]">{step.detail}</p>
                  </div>
                </div>
              ))}
              <div className="grid grid-cols-2 gap-2 pt-1">
                <a className="app-secondary-button bg-white" href="https://console.volcengine.com/speech/app" rel="noreferrer" target="_blank">
                  火山语音
                  <ExternalLink className="h-4 w-4" />
                </a>
                <a className="app-secondary-button bg-white" href="https://console.volcengine.com/ark/" rel="noreferrer" target="_blank">
                  方舟控制台
                  <ExternalLink className="h-4 w-4" />
                </a>
              </div>
            </div>
          </details>

          {user?.role === "admin" ? (
            <Link className="flex min-h-16 items-center gap-3 border-y border-[#e1e8e3] bg-white px-4 py-3" href="/checkup">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[#f2f4f2] text-[#506159]">
                <CircleDollarSign className="h-5 w-5" />
              </span>
              <span className="min-w-0 flex-1">
                <strong className="block text-sm text-[#111827]">管理员验收中心</strong>
                <span className="mt-1 block text-xs leading-5 text-[#667085]">查看全局发布门禁和运维诊断</span>
              </span>
              <ArrowRight className="h-5 w-5 text-[#7a8981]" />
            </Link>
          ) : null}
        </div>

        <AppBottomNav active="account" />
      </div>
    </main>
  );
}

function SetupStatus({ label, ready }: { label: string; ready: boolean }) {
  return (
    <div className="flex min-h-12 items-center gap-3 py-3">
      {ready ? <CheckCircle2 className="h-5 w-5 shrink-0 text-[#11815f]" /> : <Circle className="h-5 w-5 shrink-0 text-[#a5b1aa]" />}
      <p className="min-w-0 flex-1 text-sm font-medium text-[#26352e]">{label}</p>
      <p className={`text-sm font-semibold ${ready ? "text-[#11815f]" : "text-[#7b8781]"}`}>{ready ? "已连接" : "待配置"}</p>
    </div>
  );
}
