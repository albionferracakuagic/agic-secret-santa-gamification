import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { en } from './en';
import { it } from './it';

export const resources = { en: { translation: en }, it: { translation: it } } as const;
export type AppLocale = keyof typeof resources;

export function detectLocale(): AppLocale {
  const stored = typeof localStorage !== 'undefined' ? localStorage.getItem('sg.locale') : null;
  if (stored === 'en' || stored === 'it') return stored;
  const nav = typeof navigator !== 'undefined' ? navigator.language : 'en';
  return nav.toLowerCase().startsWith('it') ? 'it' : 'en';
}

void i18n.use(initReactI18next).init({
  resources,
  lng: detectLocale(),
  fallbackLng: 'en',
  interpolation: { escapeValue: false },
});

export function setLocale(l: AppLocale) {
  localStorage.setItem('sg.locale', l);
  void i18n.changeLanguage(l);
}

export default i18n;
