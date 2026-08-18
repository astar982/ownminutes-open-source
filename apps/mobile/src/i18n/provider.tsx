import * as SecureStore from "expo-secure-store";
import { useLocales } from "expo-localization";
import { createContext, type ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { TranslateOptions } from "i18n-js";
import {
  createI18n,
  isLocalePreference,
  localePreferenceStorageKey,
  resolveAppLocale,
  type AppLocale,
  type LocalePreference,
} from "./core";

type I18nContextValue = {
  locale: AppLocale;
  preference: LocalePreference;
  ready: boolean;
  setPreference: (preference: LocalePreference) => Promise<void>;
  systemLocale: AppLocale;
  t: (key: string, options?: TranslateOptions) => string;
};

const I18nContext = createContext<I18nContextValue | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const locales = useLocales();
  const [preference, setPreferenceState] = useState<LocalePreference>("system");
  const [ready, setReady] = useState(false);
  const deviceLanguageTags = locales.map((item) => item.languageTag ?? item.languageCode);
  const systemLocale = resolveAppLocale("system", deviceLanguageTags);
  const locale = resolveAppLocale(preference, deviceLanguageTags);
  const i18n = useMemo(() => createI18n(locale), [locale]);

  useEffect(() => {
    let active = true;
    void SecureStore.getItemAsync(localePreferenceStorageKey)
      .then((stored) => {
        if (active && isLocalePreference(stored)) setPreferenceState(stored);
      })
      .catch(() => undefined)
      .finally(() => {
        if (active) setReady(true);
      });
    return () => {
      active = false;
    };
  }, []);

  const setPreference = useCallback(async (next: LocalePreference) => {
    setPreferenceState(next);
    try {
      await SecureStore.setItemAsync(localePreferenceStorageKey, next);
    } catch {
      // The selection still applies for this session if persistence is unavailable.
    }
  }, []);

  const t = useCallback((key: string, options?: TranslateOptions) => i18n.t(key, options), [i18n]);
  const value = useMemo(
    () => ({ locale, preference, ready, setPreference, systemLocale, t }),
    [locale, preference, ready, setPreference, systemLocale, t],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  const value = useContext(I18nContext);
  if (!value) throw new Error("useI18n must be used inside I18nProvider");
  return value;
}
