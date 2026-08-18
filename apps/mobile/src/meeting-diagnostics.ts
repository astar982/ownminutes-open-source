import { translate, type AppLocale } from "./i18n/core";

export function meetingResultHasNoSpeech(diagnostics: string[] | null | undefined) {
  return Boolean(diagnostics?.some((item) => /(?:未检测到可用人声|no[ -]?speech)/i.test(item)));
}

export function toUserFacingMeetingDiagnostic(
  input: string | string[] | null | undefined,
  locale: AppLocale = "zh-Hans",
) {
  const diagnostics = (Array.isArray(input) ? input : input ? [input] : []).filter(Boolean);
  if (diagnostics.length === 0) return null;

  if (meetingResultHasNoSpeech(diagnostics)) {
    return translate(locale, "meetingDiagnostics.noSpeech");
  }

  const combined = diagnostics.join(" ");
  if (/(?:not wired|missing|failed|fallback|provider[_ -]?error|未配置|调用失败|识别失败)/i.test(combined)) {
    return translate(locale, "meetingDiagnostics.providerUnavailable");
  }

  if (/(?:not usable|low_confidence|empty|placeholder|transcript quality|没有可用逐字稿|转写质量)/i.test(combined)) {
    return translate(locale, "meetingDiagnostics.transcriptUnavailable");
  }

  return null;
}
