import { useTranslation } from 'react-i18next';

/** Picks the UI language from a localized text record, falling back to English then to whatever exists. */
export const pickLocal = (text: Record<string, string>, lang: string): string =>
  text[lang === 'it' ? 'it' : 'en'] ?? text['en'] ?? Object.values(text)[0] ?? '';

export function useLocalized() {
  const { i18n } = useTranslation();
  return (text: Record<string, string>) => pickLocal(text, i18n.language);
}
