import { useEffect, useState } from 'react';
import { useI18n, type I18nKey, type Lang } from '@/lib/i18n';
import en from '@/lib/i18n/en';
import zhCN from '@/lib/i18n/zh-CN';

// 全量 dict 注册表:en(占位符基线)+ zh-CN(默认语言)静态随包;zh-TW/ja
// 按需动态 import 后填入同一对象——popup/options 的共享 chunk 不再为未使用的
// 语言付解析成本。t() 每次调用实时读取,加载完成经 listeners bump 重渲染。
export const dict: Record<Lang, Record<I18nKey, string>> = {
  en,
  'zh-CN': zhCN,
  'zh-TW': {} as Record<I18nKey, string>,
  ja: {} as Record<I18nKey, string>,
};

const loaders: Partial<
  Record<Lang, () => Promise<{ default: Record<I18nKey, string> }>>
> = {
  'zh-TW': () => import('@/lib/i18n/zh-TW'),
  ja: () => import('@/lib/i18n/ja'),
};

const loading: Partial<Record<Lang, Promise<void>>> = {};
const listeners = new Set<() => void>();

export function ensureLang(lang: Lang): Promise<void> {
  const load = loaders[lang];
  if (!load) return Promise.resolve();
  return (loading[lang] ??= load()
    .then((mod) => {
      Object.assign(dict[lang], mod.default);
      for (const l of listeners) l();
    })
    .catch((e) => {
      delete loading[lang]; // 失败清缓存,下次可重试
      console.warn('[tab-agent] lang pack failed:', e);
    }));
}

/** 全量 dict 版 useI18n:zh-TW/ja 语言包按需加载,落地后自动重渲染。 */
export function useFullI18n() {
  const api = useI18n(dict);
  const [, bump] = useState(0);
  useEffect(() => {
    void ensureLang(api.lang);
    const rerender = () => bump((v) => v + 1);
    listeners.add(rerender);
    return () => {
      listeners.delete(rerender);
    };
  }, [api.lang]);
  return api;
}
