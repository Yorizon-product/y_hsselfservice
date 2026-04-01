import { useState, useEffect, useCallback } from "react";
import en from "@/locales/en.json";
import de from "@/locales/de.json";

type Translations = typeof en;
export type TranslationKey = keyof Translations;
export type Locale = "en" | "de";

const SUPPORTED_LOCALES: Locale[] = ["en", "de"];
const locales: Record<Locale, Translations> = { en, de };

function detectLocale(): Locale {
  // 1. Check localStorage
  const stored = localStorage.getItem("locale");
  if (stored && SUPPORTED_LOCALES.includes(stored as Locale)) {
    return stored as Locale;
  }

  // 2. Check navigator.language prefix
  const browserLang = navigator.language?.split("-")[0];
  if (browserLang && SUPPORTED_LOCALES.includes(browserLang as Locale)) {
    return browserLang as Locale;
  }

  // 3. Fallback
  return "en";
}

export function useTranslation() {
  const [locale, setLocaleState] = useState<Locale | null>(null);

  useEffect(() => {
    const detected = detectLocale();
    setLocaleState(detected);
    document.documentElement.lang = detected;
  }, []);

  const setLocale = useCallback((l: Locale) => {
    setLocaleState(l);
    localStorage.setItem("locale", l);
    document.documentElement.lang = l;
  }, []);

  const t = useCallback(
    (key: TranslationKey, vars?: Record<string, string | number>) => {
      if (!locale) return "";
      let str = locales[locale][key] || locales.en[key] || key;
      if (vars) {
        for (const [k, v] of Object.entries(vars)) {
          str = str.replace(`{${k}}`, String(v));
        }
      }
      return str;
    },
    [locale]
  );

  const cycleLocale = useCallback(() => {
    const current = locale || "en";
    const idx = SUPPORTED_LOCALES.indexOf(current);
    const next = SUPPORTED_LOCALES[(idx + 1) % SUPPORTED_LOCALES.length];
    setLocale(next);
  }, [locale, setLocale]);

  return { t, locale, setLocale, cycleLocale };
}
