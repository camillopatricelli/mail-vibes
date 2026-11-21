import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import en from './en'
import it from './it'

export type Language = 'en' | 'it'
export type LanguagePref = 'auto' | Language

export function detectBrowserLanguage(): Language {
  const langs = navigator.languages?.length ? navigator.languages : [navigator.language]
  for (const l of langs) {
    const base = l.toLowerCase().split('-')[0]
    if (base === 'it') return 'it'
    if (base === 'en') return 'en'
  }
  return 'en'
}

export function resolveLanguage(pref: LanguagePref): Language {
  return pref === 'auto' ? detectBrowserLanguage() : pref
}

void i18n.use(initReactI18next).init({
  resources: { en: { translation: en }, it: { translation: it } },
  lng: detectBrowserLanguage(),
  fallbackLng: 'en',
  interpolation: { escapeValue: false },
})

export function applyLanguage(lang: Language) {
  if (i18n.language !== lang) void i18n.changeLanguage(lang)
  document.documentElement.lang = lang
}

export default i18n
