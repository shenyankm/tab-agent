import { defineConfig } from 'wxt';
import tailwindcss from '@tailwindcss/vite';

// See https://wxt.dev/api/config.html
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'Pixel Agent',
    permissions: ['storage'],
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
