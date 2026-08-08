import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// the content script is injected into every page, so its size is a per-page
// parse cost; cap it so dependency upgrades can't silently bloat it
// resolved relative to this file (import.meta.dirname, Node 20.11+), so the
// vitest working directory doesn't matter
const outDir = resolve(import.meta.dirname, '../.output/chrome-mv3');
const contentJs = resolve(outDir, 'content-scripts/content.js');
const contentCss = resolve(outDir, 'content-scripts/content.css');
const backgroundJs = resolve(outDir, 'background.js');
// popup preloads the shared popup/options chunk on every open — gate it too
const sharedChunk = () =>
  readdirSync(resolve(outDir, 'chunks')).find((f) => f.startsWith('style-') && f.endsWith('.js'));

describe('bundle size', () => {
  // skipped when unbuilt (local `pnpm test` runs without `wxt build`); CI builds first
  // 拆包后(agent-*.js 按需注入)主包只剩桥接/存储/设置:32KB;留足余量
  it.skipIf(!existsSync(contentJs))('content.js stays under 100 KB', () => {
    expect(readFileSync(contentJs).length / 1024).toBeLessThan(100);
  });

  // 全量 i18n dict 是 popup/options/background 的;content 只用 contentDict 子集。
  // 若未来某处把全量 dict 重新引入 content 路径(约 7KB),这里立即失败
  it.skipIf(!existsSync(contentJs))('content.js excludes the full i18n dict', () => {
    const src = readFileSync(contentJs, 'utf8');
    expect(src.includes('アナリティクスもトラッカーもありません')).toBe(false); // ja privacy key
    expect(src.includes('privacy.promise')).toBe(false); // en privacy key
  });

  it.skipIf(!existsSync(contentCss))('content.css stays under 30 KB', () => {
    expect(readFileSync(contentCss).length / 1024).toBeLessThan(30);
  });

  it.skipIf(!existsSync(backgroundJs))('background.js stays under 50 KB', () => {
    expect(readFileSync(backgroundJs).length / 1024).toBeLessThan(50);
  });

  it.skipIf(!existsSync(contentJs))('shared popup/options chunk stays under 380 KB', () => {
    const file = sharedChunk();
    expect(file).toBeDefined();
    expect(readFileSync(resolve(outDir, 'chunks', file!)).length / 1024).toBeLessThan(380);
  });
});
