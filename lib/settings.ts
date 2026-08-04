export type Theme = 'system' | 'dark' | 'light';
export type PageCarry = 'none' | 'article' | 'screenshot';
export type HighlightColor = 'yellow' | 'purple' | 'green' | 'blue';

// 页面 DOM 里的 <mark> 吃不到 Shadow UI 的样式(cssInjectionMode:'ui'),只能内联
export const HIGHLIGHT_COLORS: Record<HighlightColor, string> = {
  yellow: '#fef08a',
  purple: '#e9d5ff',
  green: '#bbf7d0',
  blue: '#bfdbfe',
};

// matches host_permissions in wxt.config.ts
export const GATEWAY = 'https://api.qoder.com/api/v1/cloud';

export const themeItem = storage.defineItem<Theme>('local:theme', { fallback: 'system' });
export const petEnabledItem = storage.defineItem<boolean>('local:petEnabled', { fallback: true });
export const clipHighlightItem = storage.defineItem<boolean>('local:clipHighlight', { fallback: true });
export const highlightColorItem = storage.defineItem<HighlightColor>('local:highlightColor', { fallback: 'yellow' });
export const petPosItem = storage.defineItem<{ right: number; bottom: number }>('local:petPos', {
  fallback: { right: 20, bottom: 20 },
});
export const pageCarryItem = storage.defineItem<PageCarry>('local:pageCarry', { fallback: 'article' });
export const patItem = storage.defineItem<string>('local:pat', { fallback: '' });
export const agentIdItem = storage.defineItem<string>('local:agentId', { fallback: '' });
export const envIdItem = storage.defineItem<string>('local:envId', { fallback: '' });
export const vaultIdItem = storage.defineItem<string>('local:vaultId', { fallback: '' });
// 云端记忆同步(摘录 → Qoder Memory Store 镜像):默认关闭,开启后才有网络行为
export const memorySyncItem = storage.defineItem<boolean>('local:memorySync', { fallback: false });
export const memoryStoreIdItem = storage.defineItem<string>('local:memoryStoreId', { fallback: '' });
// clipId → cloud memoryId,保证创建/更新/删除对称;条目极小(每摘录一行)
export const memoryMapItem = storage.defineItem<Record<string, string>>('local:memoryMap', { fallback: {} });

export const isDark = (theme: Theme) =>
  theme === 'dark' || (theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);

/** Apply the saved theme on startup and keep every open page in sync. */
export function initTheme() {
  const apply = (theme: Theme) => document.documentElement.classList.toggle('dark', isDark(theme));
  themeItem.getValue().then(apply);
  themeItem.watch(apply);
  // follow OS light/dark flips while a page is open when the user picked "system"
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () =>
    themeItem.getValue().then(apply));
}
