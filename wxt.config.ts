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
    permissions: ['storage', 'contextMenus'],
    commands: {
      save_clip: {
        suggested_key: { default: 'Alt+Shift+S' },
        description: 'Save selection as clip',
      },
    },
    host_permissions: ['https://api.qoder.com/*'],
    // tabs.captureVisibleTab (screenshot page context) needs <all_urls>; requested
    // at runtime in the popup when the user picks "screenshot" (least privilege)
    optional_host_permissions: ['<all_urls>'],
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
