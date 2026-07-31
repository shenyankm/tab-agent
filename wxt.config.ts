import { defineConfig } from 'wxt';
import tailwindcss from '@tailwindcss/vite';

// See https://wxt.dev/api/config.html
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'Pixel Agent',
    permissions: ['storage', 'contextMenus'],
    host_permissions: ['https://api.qoder.com/*', 'https://api.deepseek.com/*'],
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
