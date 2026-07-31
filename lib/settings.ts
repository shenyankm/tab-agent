export type Theme = 'system' | 'dark' | 'light';
export type PageCarry = 'none' | 'article' | 'screenshot';

// matches host_permissions in wxt.config.ts
export const GATEWAY = 'https://api.qoder.com/api/v1/cloud';

export const themeItem = storage.defineItem<Theme>('local:theme', { fallback: 'system' });
export const petEnabledItem = storage.defineItem<boolean>('local:petEnabled', { fallback: true });
export const clipHighlightItem = storage.defineItem<boolean>('local:clipHighlight', { fallback: true });
export const petPosItem = storage.defineItem<{ right: number; bottom: number }>('local:petPos', {
  fallback: { right: 20, bottom: 20 },
});
export const pageCarryItem = storage.defineItem<PageCarry>('local:pageCarry', { fallback: 'article' });
export const patItem = storage.defineItem<string>('local:pat', { fallback: '' });
export const agentIdItem = storage.defineItem<string>('local:agentId', { fallback: '' });
export const envIdItem = storage.defineItem<string>('local:envId', { fallback: '' });
export const vaultIdItem = storage.defineItem<string>('local:vaultId', { fallback: '' });
// v3: key bumped so a fresh session is created with vault_ids attached (v2: pre-page-context history)
export const sessionIdItem = storage.defineItem<string>('local:sessionId.v3', { fallback: '' });

export const isDark = (theme: Theme) =>
  theme === 'dark' || (theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);

function applyTheme(theme: Theme) {
  document.documentElement.classList.toggle('dark', isDark(theme));
}

/** Apply the saved theme on startup and keep every open page in sync. */
export function initTheme() {
  themeItem.getValue().then(applyTheme);
  themeItem.watch(applyTheme);
}
