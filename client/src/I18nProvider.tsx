import { createContext, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";
import { LANGUAGE_STORAGE_KEY, resolveLocale, translate } from "./i18n.ts";
import type { Locale, LocalePreference, MessageParams } from "./i18n.ts";

type I18n = {
  locale: Locale;
  preference: LocalePreference;
  setPreference: (preference: LocalePreference) => void;
  t: (code: string, params?: MessageParams) => string;
};
const I18nContext = createContext<I18n | null>(null);

function browserLocale(): Locale {
  return resolveLocale(navigator.languages ?? [navigator.language]);
}

function savedPreference(): LocalePreference {
  try {
    const saved = localStorage.getItem(LANGUAGE_STORAGE_KEY);
    if (saved === "zh-CN" || saved === "en") return saved;
  } catch {
    // 禁用本地存储时仍可切换当前页面语言。
  }
  return "auto";
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [preference, updatePreference] = useState<LocalePreference>(savedPreference);
  const [automaticLocale, setAutomaticLocale] = useState<Locale>(browserLocale);
  const locale = preference === "auto" ? automaticLocale : preference;
  const setPreference = (next: LocalePreference) => {
    updatePreference(next);
    if (next === "auto") setAutomaticLocale(browserLocale());
    try {
      if (next === "auto") localStorage.removeItem(LANGUAGE_STORAGE_KEY);
      else localStorage.setItem(LANGUAGE_STORAGE_KEY, next);
    } catch {
      // 当前选择不依赖持久化成功。
    }
  };
  useEffect(() => {
    const changed = () => setAutomaticLocale(browserLocale());
    window.addEventListener("languagechange", changed);
    return () => window.removeEventListener("languagechange", changed);
  }, []);
  useEffect(() => {
    document.documentElement.lang = locale;
    document.title = translate(locale, "app.title");
  }, [locale]);
  return (
    <I18nContext.Provider
      value={{
        locale,
        preference,
        setPreference,
        t: (code, params) => translate(locale, code, params),
      }}
    >
      {children}
    </I18nContext.Provider>
  );
}

export function useI18n(): I18n {
  const context = useContext(I18nContext);
  if (!context) throw new Error("I18nProvider 缺失");
  return context;
}
