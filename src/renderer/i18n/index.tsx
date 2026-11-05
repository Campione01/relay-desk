import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { en } from './en';
import { zhTW, type MessageKey } from './zh-TW';

export type { MessageKey } from './zh-TW';
export type Language = 'zh-TW' | 'en';
export type Params = Readonly<Record<string, string | number>>;
export type Translate = (key: MessageKey, params?: Params) => string;

const DICTIONARIES: Readonly<Record<Language, Readonly<Record<MessageKey, string>>>> = { 'zh-TW': zhTW, en };

export function translate(language: Language, key: MessageKey, params?: Params): string {
  const template = DICTIONARIES[language][key] ?? en[key] ?? key;
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match,
  );
}

export function createTranslator(language: Language): Translate {
  return (key, params) => translate(language, key, params);
}

/** Picks `<base>.one` for 1 and `<base>.other` otherwise, with {n} filled in. */
export function plural(t: Translate, one: MessageKey, other: MessageKey, n: number): string {
  return t(n === 1 ? one : other, { n });
}

interface I18nValue {
  language: Language;
  t: Translate;
}

const I18nContext = createContext<I18nValue>({ language: 'en', t: createTranslator('en') });

export function I18nProvider({ language, children }: { language: Language; children: ReactNode }) {
  const value = useMemo<I18nValue>(() => ({ language, t: createTranslator(language) }), [language]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useT(): Translate {
  return useContext(I18nContext).t;
}

export function useLanguage(): Language {
  return useContext(I18nContext).language;
}
