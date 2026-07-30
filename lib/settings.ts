export type Theme = 'system' | 'dark' | 'light';

export const themeItem = storage.defineItem<Theme>('local:theme', { fallback: 'system' });
export const autoUpdateItem = storage.defineItem<boolean>('local:autoUpdate', { fallback: true });
export const petEnabledItem = storage.defineItem<boolean>('local:petEnabled', { fallback: true });
export const petPosItem = storage.defineItem<{ right: number; bottom: number }>('local:petPos', {
  fallback: { right: 20, bottom: 20 },
});
export const patItem = storage.defineItem<string>('local:pat', { fallback: '' });
export const agentIdItem = storage.defineItem<string>('local:agentId', { fallback: '' });
export const envIdItem = storage.defineItem<string>('local:envId', { fallback: '' });
// v2: key bumped to abandon sessions polluted by pre-page-context history
export const sessionIdItem = storage.defineItem<string>('local:sessionId.v2', { fallback: '' });

export function applyTheme(theme: Theme) {
  const isDark = theme === 'dark' || (theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', isDark);
}

/** Apply the saved theme on startup and keep every open page in sync. */
export function initTheme() {
  themeItem.getValue().then(applyTheme);
  themeItem.watch(applyTheme);
}
