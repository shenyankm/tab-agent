import { defineConfig } from 'wxt';
import tailwindcss from '@tailwindcss/vite';

// See https://wxt.dev/api/config.html
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'Tab Agent',
    description: 'A chat-bubble mascot that answers your page questions and saves knowledge clips.',
    // AbortSignal.any (background turns) requires Chrome 116+
    minimum_chrome_version: '116',
    // scripting: content script 的懒加载 chunk(React UI/高亮/Readability)
    // 经 executeScript 按需注入(lib/lazy.ts),无安装警告
    permissions: ['storage', 'contextMenus', 'scripting'],
    commands: {
      save_clip: {
        suggested_key: { default: 'Alt+Shift+S' },
        description: 'Save selection as clip',
      },
    },
    // <all_urls> is required for the all-page content script and scripting API
    // injection; screenshot capture uses the same host access. It is declared
    // statically here, while the popup rechecks it when the browser withholds it.
    host_permissions: ['https://api.qoder.com/*', '<all_urls>'],
    web_accessible_resources: [
      {
        matches: ['<all_urls>'],
        resources: ['mascot-expressions.webp'],
      },
    ],
  },
  vite: () => ({
    plugins: [tailwindcss()],
  }),
});
