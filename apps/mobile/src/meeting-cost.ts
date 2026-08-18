import type { ProviderCredentialSummary, ProviderHealthResult, UserProcessingMode } from "./types";
import { translate, type AppLocale } from "./i18n/core";

export type MobileProcessingRoute = "byok" | "hybrid" | "official_quota" | "unavailable";

export type MeetingCostPreview = {
  route: MobileProcessingRoute;
  label: string;
  detail: string;
  tone: "ready" | "attention" | "blocked";
};

export function getMobileByokCoverage(credentials: ProviderCredentialSummary[], health: ProviderHealthResult[]) {
  const asr = credentials.find((credential) => credential.providerId === "volcano-asr");
  const ark = credentials.find((credential) => credential.providerId === "volcano-ark");
  const asrFields = new Set(asr?.configuredFields ?? []);
  const asrSecrets = new Set(asr?.configuredSecrets ?? []);
  const arkFields = new Set(ark?.configuredFields ?? []);
  const arkSecrets = new Set(ark?.configuredSecrets ?? []);
  const hasFileAsrCredential = asrSecrets.has("VOLCANO_ASR_API_KEY") || (asrFields.has("VOLCANO_ASR_APP_ID") && asrSecrets.has("VOLCANO_ASR_TOKEN"));
  const hasSummaryCredential = arkFields.has("ARK_CHAT_MODEL") && arkSecrets.has("ARK_API_KEY");
  const fileAsrReady = health.some((item) => item.providerId === "volcano-asr" && item.status === "ready");
  const summaryReady = health.some((item) => item.providerId === "volcano-ark" && item.status === "ready");
  return {
    complete: hasFileAsrCredential && hasSummaryCredential && fileAsrReady && summaryReady,
    hasAny: credentials.length > 0,
    hasFileAsr: hasFileAsrCredential && fileAsrReady,
    hasSummary: hasSummaryCredential && summaryReady,
  };
}

export function getMeetingCostPreview(input: {
  credentials: ProviderCredentialSummary[];
  health: ProviderHealthResult[];
  officialMinutesRemaining: number;
  officialProcessingStatus: "ready" | "unavailable" | "unknown";
  processingMode: UserProcessingMode;
}, locale: AppLocale = "zh-Hans"): MeetingCostPreview {
  const coverage = getMobileByokCoverage(input.credentials, input.health);
  if (input.processingMode === "byok") {
    if (coverage.complete) {
      return {
        route: "byok",
        label: translate(locale, "cost.ownModelsLabel"),
        detail: translate(locale, "cost.ownModelsDetail"),
        tone: "ready",
      };
    }
    return {
      route: "unavailable",
      label: translate(locale, "cost.byokUnavailableLabel"),
      detail: translate(locale, "cost.byokUnavailableDetail"),
      tone: "blocked",
    };
  }

  if (input.officialMinutesRemaining > 0 && input.officialProcessingStatus === "ready") {
    const low = input.officialMinutesRemaining < 10;
    return {
      route: "official_quota",
      label: translate(locale, "cost.officialLabel"),
      detail: translate(locale, "cost.officialDetail", { minutes: input.officialMinutesRemaining, low: low ? translate(locale, "cost.lowSuffix") : "" }),
      tone: low ? "attention" : "ready",
    };
  }

  return {
    route: "unavailable",
    label: translate(locale, "cost.unavailableLabel"),
    detail: translate(
      locale,
      input.officialMinutesRemaining <= 0
        ? "cost.quotaExhausted"
        : input.officialProcessingStatus === "unknown"
          ? "cost.serviceUnknown"
          : "cost.serviceUnavailable",
    ),
    tone: "blocked",
  };
}

export function formatMeetingBilling(input: {
  processingRoute?: "byok" | "hybrid" | "official_quota";
  processedMinutes?: number;
  officialMinutesCharged?: number;
}, locale: AppLocale = "zh-Hans") {
  if (!input.processingRoute) return null;
  const routeLabel = translate(locale, input.processingRoute === "byok" ? "cost.ownModels" : input.processingRoute === "hybrid" ? "cost.hybrid" : "cost.official");
  const processed = input.processedMinutes ?? 0;
  const charged = input.officialMinutesCharged ?? 0;
  return {
    label: translate(locale, "cost.actualUse", { route: routeLabel }),
    detail: input.processingRoute === "byok"
      ? translate(locale, "cost.ownBillingDetail", { processed })
      : translate(locale, "cost.billingDetail", { processed, charged }),
    tone: charged > 0 ? "attention" as const : "ready" as const,
  };
}
