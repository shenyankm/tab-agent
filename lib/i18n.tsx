import { useEffect, useState } from 'react';

export type Lang = 'en' | 'zh-CN' | 'zh-TW' | 'ja';

export const langLabels: Record<Lang, string> = {
  en: 'English',
  'zh-CN': '简体中文',
  'zh-TW': '繁体中文',
  ja: '日本語',
};

const langItem = storage.defineItem<Lang>('local:lang', { fallback: 'zh-CN' });

const dict: Record<Lang, Record<string, string>> = {
  en: {
    'app.title': 'Pixel Agent',
    'popup.count': 'Count: {n}',
    'settings.title': 'Settings',
    'settings.language': 'Language',
    'settings.theme': 'Theme',
    'settings.autoUpdate': 'Auto Update',
    'nav.settings': 'Settings',
    'nav.sessions': 'Sessions',
    'nav.privacy': 'Privacy',
    'nav.support': 'Support',
    'theme.system': 'Follow Device',
    'theme.dark': 'Dark',
    'theme.light': 'Light',
    'privacy.updated': 'Last updated: July 30, 2026',
    'privacy.intro': 'Pixel Agent runs entirely in your browser. We do not collect, transmit, or sell any personal data.',
    'privacy.collect.title': 'Data We Store',
    'privacy.collect.body': 'Only your preferences, saved locally via the browser storage API and never leaving your device:',
    'privacy.permission.title': 'Permissions',
    'privacy.permission.body': 'The extension requests the "storage" permission only, used solely to save the preferences above.',
    'privacy.share.title': 'Third Parties',
    'privacy.share.body': 'No analytics, no trackers, no third-party services. The extension makes no network requests.',
    'privacy.contact.title': 'Contact',
    'privacy.contact.body': 'Questions about this policy? Reach us via the Support page.',
    'privacy.promise': 'Your data stays on your device. Always.',
    'footer.builtWith': 'Built with {link}',
  },
  'zh-CN': {
    'app.title': 'Pixel Agent',
    'popup.count': '计数: {n}',
    'settings.title': '设置',
    'settings.language': '显示语言',
    'settings.theme': '切换主题',
    'settings.autoUpdate': '插件自动更新',
    'nav.settings': '设置',
    'nav.sessions': '会话',
    'nav.privacy': '隐私',
    'nav.support': '支持',
    'theme.system': '跟随设备',
    'theme.dark': '深色模式',
    'theme.light': '浅色模式',
    'privacy.updated': '最后更新：2026 年 7 月 30 日',
    'privacy.intro': 'Pixel Agent 完全在你的浏览器本地运行，我们不收集、不上传、不出售任何个人数据。',
    'privacy.collect.title': '我们存储什么',
    'privacy.collect.body': '仅存储你的偏好设置，通过浏览器 storage API 保存在本地，绝不离开你的设备：',
    'privacy.permission.title': '权限说明',
    'privacy.permission.body': '本扩展仅申请 storage 权限，只用于保存上述偏好设置。',
    'privacy.share.title': '第三方',
    'privacy.share.body': '无统计分析、无跟踪器、无第三方服务，扩展不发起任何网络请求。',
    'privacy.contact.title': '联系我们',
    'privacy.contact.body': '对本政策有疑问？请通过“支持”页面联系我们。',
    'privacy.promise': '你的数据始终留在你的设备上。',
    'footer.builtWith': '本项目使用 {link} 构建',
  },
  'zh-TW': {
    'app.title': 'Pixel Agent',
    'popup.count': '計數: {n}',
    'settings.title': '設定',
    'settings.language': '顯示語言',
    'settings.theme': '切換主題',
    'settings.autoUpdate': '外掛自動更新',
    'nav.settings': '設定',
    'nav.sessions': '工作階段',
    'nav.privacy': '隱私',
    'nav.support': '支援',
    'theme.system': '跟隨裝置',
    'theme.dark': '深色模式',
    'theme.light': '淺色模式',
    'privacy.updated': '最後更新：2026 年 7 月 30 日',
    'privacy.intro': 'Pixel Agent 完全在你的瀏覽器本機執行，我們不收集、不上傳、不出售任何個人資料。',
    'privacy.collect.title': '我們儲存什麼',
    'privacy.collect.body': '僅儲存你的偏好設定，透過瀏覽器 storage API 保存在本機，絕不離開你的裝置：',
    'privacy.permission.title': '權限說明',
    'privacy.permission.body': '本擴充功能僅申請 storage 權限，只用於保存上述偏好設定。',
    'privacy.share.title': '第三方',
    'privacy.share.body': '無統計分析、無追蹤器、無第三方服務，擴充功能不發起任何網路請求。',
    'privacy.contact.title': '聯絡我們',
    'privacy.contact.body': '對本政策有疑問？請透過「支援」頁面與我們聯絡。',
    'privacy.promise': '你的資料始終留在你的裝置上。',
    'footer.builtWith': '本專案使用 {link} 建構',
  },
  ja: {
    'app.title': 'Pixel Agent',
    'popup.count': 'カウント: {n}',
    'settings.title': '設定',
    'settings.language': '表示言語',
    'settings.theme': 'テーマ切替',
    'settings.autoUpdate': '自動アップデート',
    'nav.settings': '設定',
    'nav.sessions': 'セッション',
    'nav.privacy': 'プライバシー',
    'nav.support': 'サポート',
    'theme.system': 'デバイスに合わせる',
    'theme.dark': 'ダークモード',
    'theme.light': 'ライトモード',
    'privacy.updated': '最終更新日：2026年7月30日',
    'privacy.intro': 'Pixel Agent はブラウザ内で完結して動作します。個人データの収集・送信・販売は一切行いません。',
    'privacy.collect.title': '保存するデータ',
    'privacy.collect.body': '保存されるのは設定のみです。ブラウザの storage API でローカルに保存され、デバイスの外に出ることはありません：',
    'privacy.permission.title': '権限について',
    'privacy.permission.body': '本拡張機能が要求するのは storage 権限のみで、上記の設定の保存にのみ使用します。',
    'privacy.share.title': '第三者提供',
    'privacy.share.body': 'アナリティクスもトラッカーも第三者サービスも使用せず、ネットワークリクエストは一切行いません。',
    'privacy.contact.title': 'お問い合わせ',
    'privacy.contact.body': '本ポリシーに関するご質問はサポートページからご連絡ください。',
    'privacy.promise': 'あなたのデータはあなたのデバイスに留まります。',
    'footer.builtWith': '{link} で構築',
  },
};

export function useI18n() {
  const [lang, setLangState] = useState<Lang>('zh-CN');

  // watch keeps every component and every open page in sync
  useEffect(() => {
    langItem.getValue().then(setLangState);
    return langItem.watch(setLangState);
  }, []);

  const t = (key: string, vars?: Record<string, string | number>) => {
    let s = dict[lang][key] ?? key;
    if (vars) for (const [k, v] of Object.entries(vars)) s = s.replace(`{${k}}`, String(v));
    return s;
  };

  return { lang, setLang: (l: Lang) => langItem.setValue(l), t };
}
