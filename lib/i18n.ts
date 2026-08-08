import { useCallback } from 'react';
import { useStorageValue } from '@/lib/utils';
import en from '@/lib/i18n/en';

export type Lang = 'en' | 'zh-CN' | 'zh-TW' | 'ja';
export type I18nKey = keyof typeof en;

export const DEFAULT_LANG: Lang = 'zh-CN';

export const langLabels: Record<Lang, string> = {
  en: 'English',
  'zh-CN': '简体中文',
  'zh-TW': '繁體中文',
  ja: '日本語',
};

export const langItem = storage.defineItem<Lang>('local:lang', {
  fallback: DEFAULT_LANG,
});

export function useI18n(dicts: Record<Lang, Record<string, string>>) {
  const lang = useStorageValue(langItem, DEFAULT_LANG);
  const setLang = useCallback((l: Lang) => {
    void langItem.setValue(l);
  }, []);
  const t = useCallback(
    (key: string, vars?: Record<string, string>) => {
      // 未知语言/缺失 key 回退到默认语言文案,最后兜底为 key 本身
      const raw = dicts[lang]?.[key] ?? dicts[DEFAULT_LANG]?.[key] ?? key;
      return vars
        ? raw.replace(/\{(\w+)\}/g, (m, name: string) => vars[name] ?? m)
        : raw;
    },
    [dicts, lang],
  );
  return { lang, setLang, t };
}
