import { billingPlans } from "@/lib/billing-plans";
import { getByokCoverage } from "@/lib/processing-route";
import type { BillingPlanId, ProviderCredentialSummary, SafeUser, UserUsageSummary } from "@/lib/server/auth-repository";

export type EntitlementStatus = "ready" | "attention" | "blocked";
export type ProcessingRouteId = "byok" | "official_quota" | "hybrid";

export type ProcessingRoute = {
  id: ProcessingRouteId;
  label: string;
  available: boolean;
  detail: string;
};

export type AccountEntitlements = {
  status: EntitlementStatus;
  canFinalizeMeeting: boolean;
  preferredRoute: ProcessingRouteId;
  plan: {
    id: BillingPlanId;
    name: string;
    price: string;
  };
  officialQuota: {
    totalMinutes: number;
    usedMinutes: number;
    remainingMinutes: number;
    lowBalance: boolean;
    exhausted: boolean;
  };
  byok: {
    configured: boolean;
    providerCredentialCount: number;
  };
  routes: ProcessingRoute[];
  nextAction: {
    id: "start_meeting" | "configure_byok" | "buy_minutes_or_upgrade" | "monitor_usage";
    label: string;
    href: string;
    detail: string;
  };
  checks: Array<{
    id: string;
    status: EntitlementStatus;
    label: string;
    detail: string;
  }>;
};

export function buildAccountEntitlements(input: {
  user: SafeUser;
  usage: UserUsageSummary;
  providerCredentials: ProviderCredentialSummary[];
}): AccountEntitlements {
  const providerCredentialCount = input.providerCredentials.length;
  const coverage = getByokCoverage(input.providerCredentials);
  const hasByok = coverage.complete;
  const hasPartialByok = coverage.hasAny && !coverage.complete;
  const remainingMinutes = input.usage.officialMinutesRemaining;
  const officialAvailable = remainingMinutes > 0;
  const plan = billingPlans.find((item) => item.id === input.user.plan);
  const preferredRoute = input.user.processingMode;
  const canFinalizeMeeting = preferredRoute === "byok" ? hasByok : officialAvailable;
  const lowBalance = preferredRoute === "official_quota" && officialAvailable && remainingMinutes < 10;
  const status: EntitlementStatus = canFinalizeMeeting ? (lowBalance || (!hasByok && input.user.plan === "free") ? "attention" : "ready") : "blocked";

  return {
    status,
    canFinalizeMeeting,
    preferredRoute,
    plan: {
      id: input.user.plan,
      name: plan?.name ?? input.user.plan.toUpperCase(),
      price: plan?.price ?? "未知",
    },
    officialQuota: {
      totalMinutes: input.usage.officialMinutesTotal,
      usedMinutes: input.usage.officialMinutesUsed,
      remainingMinutes,
      lowBalance,
      exhausted: remainingMinutes <= 0,
    },
    byok: {
      configured: hasByok,
      providerCredentialCount,
    },
    routes: [
      {
        id: "byok",
        label: "自带模型",
        available: hasByok,
        detail: hasByok ? "语音识别与纪要总结均使用用户自己的 Provider，不扣官方分钟。" : hasPartialByok ? "只配置了部分 Provider；选择 BYOK 时会阻止处理，不会自动扣官方分钟。" : "未配置 BYOK，长期低成本路径尚未跑通。",
      },
      {
        id: "official_quota",
        label: "官方额度",
        available: officialAvailable,
        detail: officialAvailable ? `剩余 ${remainingMinutes} 分钟，可用于免配置处理会议。` : "官方额度已用完，需配置 BYOK 或升级 Plus / Pro。",
      },
      {
        id: "hybrid",
        label: "混合模式",
        available: false,
        detail: hasPartialByok ? "配置尚未完成；新会议不会隐式混用两套服务。请配齐 BYOK，或明确选择官方额度。" : "混合模式只用于兼容旧会议账单，不再用于新会议。",
      },
    ],
    nextAction: getNextAction({
      canFinalizeMeeting,
      hasByok,
      officialAvailable,
      lowBalance,
      plan: input.user.plan,
      processingMode: preferredRoute,
    }),
    checks: [
      {
        id: "meeting-processing",
        status: canFinalizeMeeting ? "ready" : "blocked",
        label: "会议处理资格",
        detail: canFinalizeMeeting ? "当前选定的会议处理路径可用。" : "当前选定的会议处理路径不可用，请切换或完成配置。",
      },
      {
        id: "quota-balance",
        status: officialAvailable ? (lowBalance ? "attention" : "ready") : "blocked",
        label: "官方额度",
        detail: officialAvailable ? `剩余 ${remainingMinutes} 分钟。` : "官方额度已耗尽。",
      },
      {
        id: "byok-cost-control",
        status: hasByok ? "ready" : "attention",
        label: "成本自控",
        detail: hasByok ? `ASR 与总结两组 Provider 已配齐。` : hasPartialByok ? `已保存 ${providerCredentialCount} 组，但尚未形成完整 BYOK。` : "未配置 BYOK，用户仍依赖官方额度。",
      },
      {
        id: "commercial-path",
        status: input.user.plan === "free" ? "attention" : "ready",
        label: "当前方案",
        detail: input.user.plan === "free" ? "当前为 Free，可使用官方体验额度或配置自己的模型。" : `当前为 ${input.user.plan.toUpperCase()} 方案。`,
      },
    ],
  };
}

function getNextAction(input: {
  canFinalizeMeeting: boolean;
  hasByok: boolean;
  officialAvailable: boolean;
  lowBalance: boolean;
  plan: BillingPlanId;
  processingMode: SafeUser["processingMode"];
}): AccountEntitlements["nextAction"] {
  if (!input.canFinalizeMeeting) {
    if (input.processingMode === "byok") {
      return {
        id: "configure_byok",
        label: "完成自有模型配置",
        href: "/settings",
        detail: "当前选择自己的模型，但语音识别或纪要总结尚未配齐。不会自动改用官方额度。",
      };
    }
    return {
      id: "buy_minutes_or_upgrade",
      label: "配置 BYOK 或升级",
      href: "/pricing",
      detail: "当前选择官方额度，但官方分钟已用完。不会自动改用自己的模型。",
    };
  }

  if (!input.hasByok && input.plan === "free") {
    return {
      id: "configure_byok",
      label: "配置自带模型",
      href: "/settings",
      detail: "你可以继续使用官方体验额度；配置自己的模型后，可自行控制长期使用成本。",
    };
  }

  if (input.lowBalance) {
    return {
      id: "buy_minutes_or_upgrade",
      label: "处理额度预警",
      href: "/pricing",
      detail: "官方额度低于 10 分钟，建议升级 Plus / Pro 或切换 BYOK。",
    };
  }

  if (input.hasByok) {
    return {
      id: "start_meeting",
      label: "开始记录会议",
      href: "/app",
      detail: "自己的模型已配置完成，可以开始记录会议。",
    };
  }

  return {
    id: "monitor_usage",
    label: "查看用量",
    href: "/account",
    detail: "官方额度仍可用，可在账号页随时查看剩余分钟。",
  };
}
