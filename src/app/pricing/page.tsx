import type { Metadata } from "next";
import type { ReactNode } from "react";
import { ArrowLeft, BadgeDollarSign, CheckCircle2, KeyRound, Settings2, Sparkles, UserRound } from "lucide-react";
import Link from "next/link";
import { AppBottomNav } from "@/components/app-bottom-nav";
import { billingPlans, usageMetrics, type BillingPlan } from "@/lib/billing-plans";
import { getPaymentDiagnostics } from "@/lib/payment-diagnostics";
import { getCurrentUser } from "@/lib/server/current-user";

export const metadata: Metadata = {
  title: "价格 - OwnMinutes",
};

export const dynamic = "force-dynamic";

export default async function PricingPage() {
  const user = await getCurrentUser();
  const ctaHref = user ? "/account" : "/register";
  const payment = getPaymentDiagnostics();
  const purchasesOpen = payment.acceptingPurchases;

  return (
    <main className="min-h-screen bg-[#e8ecf1] text-[#111827] sm:py-5">
      <div className="ownminutes-mobile-shell mx-auto min-h-screen w-full max-w-[430px] bg-[#f8f7f3] pb-24 shadow-[0_24px_70px_rgba(15,23,42,0.12)] sm:min-h-[860px] sm:overflow-hidden sm:rounded-[28px] sm:border sm:border-[#d8dde4] lg:max-w-[1180px] lg:px-6 lg:py-6">
        <header className="sticky top-0 z-20 border-b border-[#e6e0d4] bg-[#f8f7f3]/95 px-5 pb-3 pt-4 backdrop-blur lg:static lg:border-b-0 lg:px-0 lg:pb-5">
          <div className="flex items-center justify-between gap-3">
            <Link className="app-icon-button" href="/app" title="返回录音">
              <ArrowLeft className="h-4 w-4" />
            </Link>
            <div className="min-w-0 flex-1">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-[#738078]">Pricing</p>
              <h1 className="mt-1 truncate text-xl font-semibold text-[#111827]">方案与成本</h1>
            </div>
            <Link className="app-icon-button app-icon-button-dark" href={user ? "/account" : "/login"} title={user ? "账号" : "登录"}>
              <UserRound className="h-4 w-4" />
            </Link>
          </div>
        </header>

        <div className="space-y-4 px-4 py-4 lg:px-0">
          <section className="overflow-hidden rounded-lg border border-[#e2ddd2] bg-white p-4 shadow-[0_18px_45px_rgba(15,23,42,0.08)] lg:p-6">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-sm text-[#667085]">{user ? "当前账号" : "官方 App 免费下载"}</p>
                <h2 className="mt-1 text-2xl font-semibold leading-tight text-[#111827] lg:text-4xl">自己控成本，不被年费绑住。</h2>
              </div>
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-[#edf5f0] text-[#157a5a]">
                <KeyRound className="h-5 w-5" />
              </span>
            </div>

            <div className="mt-5 grid grid-cols-3 gap-2 text-center">
              <HeroMetric label="Free" value="BYOK + 60" />
              <HeroMetric label="Plus" value="600 分钟/月" />
              <HeroMetric label="Pro" value="1800 分钟/月" />
            </div>

            <p className="mt-5 text-sm leading-6 text-[#667085]">
              Free 的 BYOK 永久免费，并附带一次性 60 分钟官方体验额度；需要持续使用官方额度时可选择 Plus 或 Pro。
            </p>
          </section>

          <section className="grid gap-3 lg:grid-cols-3">
            <PathCard title="Free 路径" badge="推荐先试" icon={<KeyRound className="h-4 w-4" />} detail="BYOK 永久免费，新账号另有一次性 60 分钟官方体验额度，不按月重复赠送。" />
            <PathCard title="Plus 路径" badge={purchasesOpen ? "个人用户" : "准备开放"} icon={<Sparkles className="h-4 w-4" />} detail="计划价 US$7.99/月，包含每月 600 分钟官方额度；以 iOS App Store 实际开放页面为准。" />
            <PathCard title="Pro 路径" badge={purchasesOpen ? "重度使用" : "准备开放"} icon={<BadgeDollarSign className="h-4 w-4" />} detail="计划价 US$19.99/月，包含每月 1800 分钟官方额度；以 iOS App Store 实际开放页面为准。" />
          </section>

          <section className="rounded-lg border border-[#d9ded8] bg-white p-5 shadow-sm">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-sm font-semibold text-[#1f6f55]">成本自测</p>
                <h2 className="mt-1 text-lg font-semibold">先按会议频率选路径。</h2>
              </div>
              <BadgeDollarSign className="h-5 w-5 shrink-0 text-[#1f6f55]" />
            </div>
            <p className="mt-3 text-sm leading-6 text-[#667085]">
              会议成本主要由识别分钟、纪要模型调用、存储和分享页组成。愿意配置模型时优先使用 Free + BYOK；希望免配置时，再根据每月会议量选择 Plus 或 Pro。
            </p>
            <div className="mt-4 grid gap-3 lg:grid-cols-3">
              <CostRouteCard
                title="先体验或愿意配置模型"
                route="Free + BYOK"
                detail="BYOK 永久免费，并有一次性 60 分钟官方体验额度；模型费用走自己的供应商账号。"
              />
              <CostRouteCard
                title="每月约 600 分钟以内"
                route="Plus"
                detail="每月 600 分钟官方额度，适合不想维护模型配置的个人用户。"
              />
              <CostRouteCard
                title="每月会议量更大"
                route="Pro"
                detail="每月 1800 分钟官方额度，适合月度会议处理量更高的重度用户。"
              />
            </div>
            <div className="mt-4 rounded-lg bg-[#f7faf8] p-4">
              <p className="text-sm font-semibold text-[#111827]">推荐判断</p>
              <p className="mt-2 text-sm leading-6 text-[#667085]">
                愿意配置模型就长期使用 Free + BYOK；希望免配置且每月不超过 600 分钟可选 Plus；需要更多官方额度则选 Pro。
              </p>
            </div>
          </section>

          <section className="grid gap-4 lg:grid-cols-3">
            {billingPlans.map((plan) => (
              <PlanCard key={plan.id} ctaHref={ctaHref} plan={plan} purchasesOpen={purchasesOpen} />
            ))}
          </section>

          <section className="rounded-lg border border-[#d9ded8] bg-white p-5 shadow-sm">
            <h2 className="text-lg font-semibold">成本为什么可控</h2>
            <div className="mt-4 grid gap-3 md:grid-cols-3">
              {usageMetrics.map((metric) => (
                <div key={metric.label} className="rounded-lg border border-[#e1e6e0] bg-[#fbfcfb] p-3">
                  <p className="text-sm font-semibold">{metric.label}</p>
                  <p className="mt-2 text-sm leading-6 text-[#667085]">{metric.value}</p>
                </div>
              ))}
            </div>
            <p className="mt-4 text-sm leading-6 text-[#667085]">
              先用 Free 验证产品价值，再按实际月度会议量选择 Plus 或 Pro，不必为用不到的额度付费。
            </p>
          </section>

          <section className="rounded-lg border border-[#d9ded8] bg-white p-5 shadow-sm">
            <h2 className="text-lg font-semibold">当前付费说明</h2>
            <p className="mt-2 text-sm leading-6 text-[#667085]">
              {purchasesOpen
                ? "Plus / Pro 已在 iOS App Store 开放购买。实际结算金额、币种、续订周期和确认结果以 Apple 购买界面为准。"
                : "Plus / Pro 真实购买目前尚未开放。本页价格与额度是计划方案，不会在网页或当前客户端直接扣款；开放后以 iOS App Store 购买界面为准。"}
            </p>
            <div className="mt-4 grid gap-2 sm:grid-cols-2">
              <Link className="app-primary-button" href={ctaHref}>
                {user ? "查看当前账号" : "免费注册"}
              </Link>
              <Link className="app-secondary-button" href="/settings">
                <Settings2 className="h-4 w-4" />
                配置自己的模型
              </Link>
            </div>
          </section>

          <div className="flex flex-wrap gap-3 px-1 text-sm font-semibold text-[#1f6f55]">
            <Link href="/support">支持</Link>
            <Link href="/privacy">隐私政策</Link>
            <Link href="/terms">服务条款</Link>
            <Link href="/data-deletion">数据删除说明</Link>
          </div>
        </div>

        <AppBottomNav active="account" hiddenOnDesktop />
      </div>
    </main>
  );
}

function HeroMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-[#e1e8e2] bg-[#fbfcfb] px-2 py-3">
      <p className="text-[11px] font-medium text-[#66766e]">{label}</p>
      <p className="mt-1 text-sm font-semibold text-[#111827]">{value}</p>
    </div>
  );
}

function PathCard({ badge, detail, icon, title }: { badge: string; detail: string; icon: ReactNode; title: string }) {
  return (
    <article className="rounded-lg border border-[#e4e8e5] bg-white p-4 shadow-sm">
      <div className="flex items-center justify-between gap-3">
        <span className="flex h-9 w-9 items-center justify-center rounded-full bg-[#eef6f1] text-[#1f6f55]">{icon}</span>
        <span className="rounded-full bg-[#f3f6f4] px-2.5 py-1 text-xs font-semibold text-[#667085]">{badge}</span>
      </div>
      <h2 className="mt-4 text-base font-semibold">{title}</h2>
      <p className="mt-2 text-sm leading-6 text-[#667085]">{detail}</p>
    </article>
  );
}

function CostRouteCard({ detail, route, title }: { detail: string; route: string; title: string }) {
  return (
    <article className="rounded-lg border border-[#e1e6e0] bg-[#fbfcfb] p-4">
      <p className="text-sm font-semibold text-[#111827]">{title}</p>
      <p className="mt-2 text-xl font-semibold text-[#1f6f55]">{route}</p>
      <p className="mt-2 text-sm leading-6 text-[#667085]">{detail}</p>
    </article>
  );
}

function PlanCard({ ctaHref, plan, purchasesOpen }: { ctaHref: string; plan: BillingPlan; purchasesOpen: boolean }) {
  return (
    <article className={`rounded-lg border bg-white p-5 shadow-sm ${plan.highlight ? "border-[#1f6f55] ring-2 ring-[#1f6f55]/10" : "border-[#d9ded8]"}`}>
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-xl font-semibold">{plan.name}</h2>
        {plan.highlight ? (
          <span className="inline-flex h-8 items-center gap-1 rounded-full bg-[#1f6f55] px-3 text-xs font-semibold text-white">
            <Sparkles className="h-3.5 w-3.5" />
            推荐
          </span>
        ) : null}
      </div>
      <p className="mt-4 text-3xl font-semibold">{plan.price}</p>
      <p className="mt-1 text-sm text-[#667085]">{plan.caption}</p>
      <div className="mt-4 rounded-lg bg-[#eef6f1] px-3 py-2 text-sm font-semibold text-[#1f6f55]">{plan.minutes}</div>
      <ul className="mt-4 space-y-3">
        {plan.features.map((feature) => (
          <li key={feature} className="flex gap-2 text-sm leading-6 text-[#44515f]">
            <CheckCircle2 className="mt-1 h-4 w-4 shrink-0 text-[#1f6f55]" />
            {feature}
          </li>
        ))}
      </ul>
      {plan.id === "free" ? (
        <Link className="app-secondary-button mt-5 w-full" href={ctaHref}>
          免费开始
        </Link>
      ) : (
        <span
          aria-disabled={!purchasesOpen}
          className={`${plan.highlight ? "app-primary-button" : "app-secondary-button"} mt-5 w-full cursor-default justify-center ${purchasesOpen ? "" : "opacity-60"}`}
        >
          {purchasesOpen ? "请在 iOS App 内购买" : "暂未开放购买"}
        </span>
      )}
    </article>
  );
}
