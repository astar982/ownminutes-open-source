#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import {
  defaultAppLocale,
  isLocalePreference,
  resolveAppLocale,
  resolveSystemLocale,
  supportedAppLocales,
  translate,
  translations,
} from "../apps/mobile/src/i18n/core.ts";

const expectedLocales = ["en", "zh-Hans", "zh-Hant"];
const appConfig = JSON.parse(readFileSync("apps/mobile/app.json", "utf8"));
const appSource = readFileSync("apps/mobile/App.tsx", "utf8");
const iapStoreSource = readFileSync("apps/mobile/src/IapPlanStore.tsx", "utf8");
const providerSource = readFileSync("apps/mobile/src/i18n/provider.tsx", "utf8");
const selectorSource = readFileSync("apps/mobile/src/i18n/LanguageSelector.tsx", "utf8");
const expo = appConfig.expo ?? {};
const localizationPlugin = (expo.plugins ?? []).find((entry) => Array.isArray(entry) && entry[0] === "expo-localization");
const configuredLocales = expo.locales ?? {};
const localeFiles = Object.fromEntries(
  expectedLocales.map((locale) => {
    const configuredPath = configuredLocales[locale];
    const path = typeof configuredPath === "string" ? `apps/mobile/${configuredPath.replace(/^\.\//, "")}` : "";
    return [locale, { configuredPath, path, content: path && existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null }];
  }),
);

const flattened = Object.fromEntries(expectedLocales.map((locale) => [locale, flattenStrings(translations[locale])]));
const referenceKeys = Object.keys(flattened.en).sort();
const keyParity = expectedLocales.every((locale) => sameStrings(Object.keys(flattened[locale]).sort(), referenceKeys));
const placeholderParity = referenceKeys.every((key) => {
  const expected = placeholders(flattened.en[key]);
  return expectedLocales.every((locale) => sameStrings(placeholders(flattened[locale][key]), expected));
});
const referencedTranslationKeys = [appSource, iapStoreSource, providerSource, selectorSource]
  .flatMap((source) => [...source.matchAll(/\bt\("([^"]+)"/g)].map((match) => match[1]));
const missingSourceTranslationKeys = [...new Set(referencedTranslationKeys)]
  .filter((key) => !referenceKeys.includes(key))
  .sort();
const highRiskRuntimeMessageCalls = [
  "setLastError",
  "setAutoSyncMessage",
  "setHistoryError",
  "setRealtimeUploadDiagnostic",
].flatMap((setter) => extractCalls(appSource, setter));
const interpolationKeys = referenceKeys.filter((key) => placeholders(flattened.en[key]).length > 0);
const interpolationWorks = expectedLocales.every((locale) =>
  interpolationKeys.every((key) => {
    const options = Object.fromEntries(placeholders(flattened[locale][key]).map((name, index) => [name, index + 2]));
    const rendered = translate(locale, key, options);
    return typeof rendered === "string" && !/%\{[^}]+\}/.test(rendered);
  }),
);

const iosSupportedLocales = localizationPlugin?.[1]?.supportedLocales?.ios;
const androidSupportedLocales = localizationPlugin?.[1]?.supportedLocales?.android;
const baseMicrophoneDescription = expo.ios?.infoPlist?.NSMicrophoneUsageDescription;
const audioPlugin = (expo.plugins ?? []).find((entry) => Array.isArray(entry) && entry[0] === "expo-audio");
const audioPluginMicrophoneDescription = audioPlugin?.[1]?.microphonePermission;

const checks = {
  hasExactlyThreeCatalogs:
    sameStrings([...supportedAppLocales], expectedLocales) &&
    sameStrings(Object.keys(translations).sort(), [...expectedLocales].sort()) &&
    defaultAppLocale === "en",
  translationKeysMatch: keyParity,
  sourceTranslationKeysExist: missingSourceTranslationKeys.length === 0,
  englishCatalogContainsNoHan: Object.values(flattened.en).every((value) => !containsHan(value)),
  interpolationVariablesMatch: placeholderParity,
  interpolationRendersInEveryLocale:
    interpolationKeys.length > 0 &&
    interpolationWorks &&
    translate("en", "common.minutes", { count: 3 }) === "3 min" &&
    translate("zh-Hans", "common.minutes", { count: 3 }) === "3 分钟" &&
    translate("zh-Hant", "common.minutes", { count: 3 }) === "3 分鐘",
  resolvesSystemLocales:
    resolveSystemLocale(["en-US"]) === "en" &&
    resolveSystemLocale(["zh-CN"]) === "zh-Hans" &&
    resolveSystemLocale(["zh-Hans-SG"]) === "zh-Hans" &&
    resolveSystemLocale(["zh-TW"]) === "zh-Hant" &&
    resolveSystemLocale(["zh-HK"]) === "zh-Hant" &&
    resolveSystemLocale(["zh-Hant"]) === "zh-Hant" &&
    resolveSystemLocale(["ja-JP"]) === "en" &&
    resolveSystemLocale([]) === "en",
  manualLocaleOverridesSystem:
    resolveAppLocale("en", "zh-CN") === "en" &&
    resolveAppLocale("zh-Hans", "en-US") === "zh-Hans" &&
    resolveAppLocale("zh-Hant", "en-US") === "zh-Hant" &&
    resolveAppLocale("system", "zh-TW") === "zh-Hant" &&
    ["system", ...expectedLocales].every((locale) => isLocalePreference(locale)) &&
    !isLocalePreference("ja"),
  appConfigAdvertisesLocales:
    Array.isArray(localizationPlugin) &&
    sameStrings(iosSupportedLocales, expectedLocales) &&
    sameStrings(androidSupportedLocales, expectedLocales) &&
    sameStrings(Object.keys(configuredLocales).sort(), [...expectedLocales].sort()),
  appConfigUsesEnglishBasePermission:
    expo.ios?.infoPlist?.CFBundleAllowMixedLocalizations === true &&
    isEnglishMicrophonePurpose(baseMicrophoneDescription) &&
    isEnglishMicrophonePurpose(audioPluginMicrophoneDescription),
  nativeLocaleFilesComplete: expectedLocales.every((locale) => {
    const file = localeFiles[locale];
    const ios = file.content?.ios;
    return (
      typeof file.configuredPath === "string" &&
      Boolean(file.content) &&
      nonEmpty(ios?.CFBundleDisplayName) &&
      nonEmpty(ios?.NSMicrophoneUsageDescription) &&
      nonEmpty(file.content?.android?.app_name) &&
      !("NSFaceIDUsageDescription" in (ios ?? {}))
    );
  }),
  englishNativeLocaleIsEnglish:
    isEnglishMicrophonePurpose(localeFiles.en.content?.ios?.NSMicrophoneUsageDescription) &&
    !containsHan(localeFiles.en.content?.ios?.CFBundleDisplayName ?? ""),
  appUsesProviderAndSelectors:
    appSource.includes('import { LanguageSelector } from "./src/i18n/LanguageSelector"') &&
    appSource.includes('import { I18nProvider, useI18n } from "./src/i18n/provider"') &&
    appSource.includes("<I18nProvider>") &&
    appSource.includes("const { locale, ready: i18nReady, t } = useI18n()") &&
    (appSource.match(/<LanguageSelector(?:\s|\/>)/g)?.length ?? 0) === 2 &&
    appSource.includes('<LanguageSelector variant="auth" />') &&
    appSource.includes('<LanguageSelector variant="settings" />') &&
    !appSource.includes("<LanguageSelector compact") &&
    providerSource.includes("useLocales()") &&
    providerSource.includes("SecureStore.getItemAsync") &&
    providerSource.includes("const systemLocale = resolveAppLocale(\"system\", deviceLanguageTags)") &&
    providerSource.includes("ready, setPreference, systemLocale, t") &&
    appSource.includes("if (!i18nReady || !apiBaseUrlRestored || sessionRestoreStartedRef.current) return") &&
    appSource.includes("[apiBaseUrlRestored, i18nReady, restoreSession]") &&
    selectorSource.includes('presentationStyle="pageSheet"') &&
    selectorSource.includes('autonyms[systemLocale]') &&
    selectorSource.includes("const optionAccessibilityLabel") &&
    selectorSource.includes("chooseLanguage(option)"),
  usageRowsResistLongLocalizedText:
    appSource.includes("<View style={styles.usageItemCopy}>") &&
    appSource.includes("<View style={styles.usageItemMeta}>") &&
    /usageItemCopy:\s*\{[\s\S]*?flex:\s*1,[\s\S]*?minWidth:\s*0,[\s\S]*?\}/.test(appSource) &&
    /usageItemMeta:\s*\{[\s\S]*?alignItems:\s*"flex-end",[\s\S]*?flexShrink:\s*0,[\s\S]*?\}/.test(appSource),
  mobileLegalLinksFollowLocale:
    appSource.includes("localizedOwnMinutesWebPath(locale, pathname)") &&
    appSource.includes('if (locale === "en") return `/en${pathname}`') &&
    appSource.includes('if (locale === "zh-Hant") return `/zh-Hant${pathname}`') &&
    iapStoreSource.includes("localizedLegalPagePath(locale, path)") &&
    iapStoreSource.includes('if (locale === "en") return `/en${path}`') &&
    iapStoreSource.includes('if (locale === "zh-Hant") return `/zh-Hant${path}`'),
  freeTrialCopyIsExplicitAndLocalized:
    translate("en", "iap.officialMinutes", { minutes: 60 }) === "One-time official trial: 60 minutes" &&
    translate("zh-Hans", "iap.officialMinutes", { minutes: 60 }) === "一次性 60 分钟官方体验额度" &&
    translate("zh-Hant", "iap.officialMinutes", { minutes: 60 }) === "一次性 60 分鐘官方體驗額度" &&
    expectedLocales.every((locale) => translate(locale, "iap.subtitle").includes("60")),
  highRiskRuntimeMessagesUseCatalog:
    highRiskRuntimeMessageCalls.length > 20 &&
    highRiskRuntimeMessageCalls.every((call) => !containsHan(call)) &&
    appSource.includes('t("runtime.recoveredFinalizedRecording"') &&
    appSource.includes('t("runtime.recoveredUploadedRecording"') &&
    appSource.includes('t("runtime.recoveredInterruptedRecording"') &&
    appSource.includes('t("runtime.recoveredPendingRecording"') &&
    appSource.includes('useState<NetworkStatus>("checking")') &&
    !appSource.includes('networkLabel !== "在线"') &&
    !appSource.includes('setNetworkLabel(networkStateIsOnline') &&
    !appSource.includes("发现本机保留的已完成会议录音") &&
    !appSource.includes("会议历史暂时无法刷新：") &&
    !appSource.includes('autoSyncMessage.includes("重试")') &&
    !appSource.includes('autoSyncMessage.includes("联网")'),
};

console.log(JSON.stringify({
  ...checks,
  catalogKeyCount: referenceKeys.length,
  interpolationKeyCount: interpolationKeys.length,
  missingSourceTranslationKeys,
}, null, 2));

if (Object.values(checks).some((value) => value !== true)) process.exitCode = 1;

function flattenStrings(value, prefix = "", output = {}) {
  for (const [key, child] of Object.entries(value ?? {})) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof child === "string") output[path] = child;
    else if (child && typeof child === "object" && !Array.isArray(child)) flattenStrings(child, path, output);
  }
  return output;
}

function placeholders(value) {
  return [...String(value).matchAll(/%\{([^}]+)\}/g)].map((match) => match[1]).sort();
}

function sameStrings(left, right) {
  return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, index) => value === right[index]);
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function containsHan(value) {
  return /[\u3400-\u9fff\uf900-\ufaff]/u.test(value);
}

function isEnglishMicrophonePurpose(value) {
  return nonEmpty(value) && !containsHan(value) && /microphone/i.test(value) && /meeting/i.test(value);
}

function extractCalls(source, functionName) {
  const calls = [];
  let cursor = 0;
  const marker = `${functionName}(`;
  while ((cursor = source.indexOf(marker, cursor)) >= 0) {
    let depth = 1;
    let index = cursor + marker.length;
    let quote = null;
    let escaped = false;
    for (; index < source.length && depth > 0; index += 1) {
      const character = source[index];
      if (quote) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === quote) quote = null;
        continue;
      }
      if (character === '"' || character === "'" || character === "`") quote = character;
      else if (character === "(") depth += 1;
      else if (character === ")") depth -= 1;
    }
    calls.push(source.slice(cursor, index));
    cursor = Math.max(index, cursor + marker.length);
  }
  return calls;
}
