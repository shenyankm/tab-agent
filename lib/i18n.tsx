import { useEffect, useState } from 'react';

export type Lang = 'en' | 'zh-CN' | 'zh-TW' | 'ja';

const dict: Record<Lang, Record<string, string>> = {
  en: {
    'app.title': 'Pixel Agent',
    'popup.count': 'Count: {n}',
    'settings.title': 'Settings',
    'settings.language': 'Language',
    'settings.theme': 'Theme',
    'settings.autoUpdate': 'Auto Update',
    'theme.system': 'Follow Device',
    'theme.dark': 'Dark',
    'theme.light': 'Light',
    'footer.builtWith': 'Built with {link}',
  },
  'zh-CN': {
    'app.title': 'Pixel Agent',
    'popup.count': '计数: {n}',
    'settings.title': '设置',
    'settings.language': '显示语言',
    'settings.theme': '切换主题',
    'settings.autoUpdate': '插件自动更新',
    'theme.system': '跟随设备',
    'theme.dark': '深色模式',
    'theme.light': '浅色模式',
    'footer.builtWith': '本项目使用 {link} 构建',
  },
  'zh-TW': {
    'app.title': 'Pixel Agent',
    'popup.count': '計數: {n}',
    'settings.title': '設定',
    'settings.language': '顯示語言',
    'settings.theme': '切換主題',
    'settings.autoUpdate': '外掛自動更新',
    'theme.system': '跟隨裝置',
    'theme.dark': '深色模式',
    'theme.light': '淺色模式',
    'footer.builtWith': '本專案使用 {link} 建構',
  },
  ja: {
    'app.title': 'Pixel Agent',
    'popup.count': 'カウント: {n}',
    'settings.title': '設定',
    'settings.language': '表示言語',
    'settings.theme': 'テーマ切替',
    'settings.autoUpdate': '自動アップデート',
    'theme.system': 'デバイスに合わせる',
    'theme.dark': 'ダークモード',
    'theme.light': 'ライトモード',
    'footer.builtWith': '{link} で構築',
  },
};

export function useI18n() {
  const [lang, setLang] = useState<Lang>('zh-CN');

  useEffect(() => {
    browser.storage.local.get('lang').then((r) => {
      if (r.lang) setLang(r.lang as Lang);
    });
  }, []);

  const t = (key: string, vars?: Record<string, string | number>) => {
    let s = dict[lang][key] ?? key;
    if (vars) for (const [k, v] of Object.entries(vars)) s = s.replace(`{${k}}`, String(v));
    return s;
  };

  return { lang, setLang, t };
}
