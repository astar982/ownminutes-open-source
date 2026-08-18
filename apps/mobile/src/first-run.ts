import { translate, type AppLocale } from "./i18n/core";
import type { UserProcessingMode } from "./types";

export type FirstRunAction = "start" | "configure" | "plans" | "check";

export type FirstRunGuide = {
  tone: "ready" | "attention" | "blocked";
  eyebrow: string;
  title: string;
  detail: string;
  primaryAction: FirstRunAction;
  primaryLabel: string;
  secondaryAction?: FirstRunAction;
  secondaryLabel?: string;
};

export function getFirstRunGuide(input: {
  hasCompletedMeeting: boolean;
  hasProviderConfig: boolean;
  hasReadyProvider: boolean;
  officialProcessingStatus: "ready" | "unavailable" | "unknown";
  officialMinutesRemaining: number;
  processingMode: UserProcessingMode;
}, locale: AppLocale = "zh-Hans"): FirstRunGuide | null {
  if (input.hasCompletedMeeting) return null;

  if (input.processingMode === "official_quota" && input.officialMinutesRemaining > 0 && input.officialProcessingStatus === "ready") {
    return {
      tone: "ready",
      eyebrow: translate(locale, "firstRun.firstUse"),
      title: translate(locale, "firstRun.freeTrialTitle", { minutes: input.officialMinutesRemaining }),
      detail: translate(locale, "firstRun.freeTrialDetail"),
      primaryAction: "start",
      primaryLabel: translate(locale, "firstRun.startShort"),
    };
  }

  if (input.processingMode === "official_quota" && input.officialMinutesRemaining > 0 && input.officialProcessingStatus === "unknown") {
    return {
      tone: "attention",
      eyebrow: translate(locale, "firstRun.serviceUnknown"),
      title: translate(locale, "firstRun.creditsUnknownTitle"),
      detail: translate(locale, "firstRun.creditsUnknownDetail"),
      primaryAction: "start",
      primaryLabel: translate(locale, "firstRun.startLocal"),
      secondaryAction: "configure",
      secondaryLabel: translate(locale, "firstRun.configureOwn"),
    };
  }

  if (input.processingMode === "official_quota" && input.officialMinutesRemaining > 0) {
    return {
      tone: "attention",
      eyebrow: translate(locale, "firstRun.serviceUnavailable"),
      title: translate(locale, "firstRun.creditsUnavailableTitle"),
      detail: translate(locale, "firstRun.creditsUnavailableDetail"),
      primaryAction: "check",
      primaryLabel: translate(locale, "firstRun.recheckService"),
      secondaryAction: "configure",
      secondaryLabel: translate(locale, "firstRun.configureOwn"),
    };
  }

  if (input.processingMode === "official_quota") {
    return {
      tone: "blocked",
      eyebrow: translate(locale, "firstRun.chooseProcessing"),
      title: translate(locale, "firstRun.finalUnavailable"),
      detail: translate(locale, "firstRun.quotaExhaustedDetail"),
      primaryAction: "configure",
      primaryLabel: translate(locale, "firstRun.configureOwn"),
      secondaryAction: "plans",
      secondaryLabel: translate(locale, "firstRun.viewCredits"),
    };
  }

  if (!input.hasProviderConfig || !input.hasReadyProvider) {
    return {
      tone: "attention",
      eyebrow: translate(locale, "firstRun.configIncomplete"),
      title: translate(locale, "firstRun.oneStepTitle"),
      detail: translate(locale, "firstRun.oneStepDetail"),
      primaryAction: "configure",
      primaryLabel: translate(locale, "firstRun.continueConfig"),
      secondaryAction: "check",
      secondaryLabel: translate(locale, "firstRun.recheck"),
    };
  }

  return {
    tone: "ready",
    eyebrow: translate(locale, "firstRun.modelsReady"),
    title: translate(locale, "firstRun.recordShortTitle"),
    detail: translate(locale, "firstRun.recordShortDetail"),
    primaryAction: "start",
    primaryLabel: translate(locale, "firstRun.startTest"),
  };
}
