export type Theme = 'system' | 'dark' | 'light';

export const themeItem = storage.defineItem<Theme>('local:theme', { fallback: 'system' });
export const autoUpdateItem = storage.defineItem<boolean>('local:autoUpdate', { fallback: true });

export function applyTheme(theme: Theme) {
  const isDark = theme === 'dark' || (theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', isDark);
}

/** Apply the saved theme on startup and keep every open page in sync. */
export function initTheme() {
  themeItem.getValue().then(applyTheme);
  themeItem.watch(applyTheme);
}
