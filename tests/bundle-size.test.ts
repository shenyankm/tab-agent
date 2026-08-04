import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// the content script is injected into every page, so its size is a per-page
// parse cost; cap it so dependency upgrades can't silently bloat it
// resolved relative to this file (import.meta.dirname, Node 20.11+), so the
// vitest working directory doesn't matter
const outDir = resolve(import.meta.dirname, '../.output/chrome-mv3');
const contentJs = resolve(outDir, 'content-scripts/content.js');
// popup preloads the shared popup/options chunk on every open — gate it too
const sharedChunk = () =>
  readdirSync(resolve(outDir, 'chunks')).find((f) => f.startsWith('style-') && f.endsWith('.js'));

describe('bundle size', () => {
  // skipped when unbuilt (local `pnpm test` runs without `wxt build`); CI builds first
  // 354KB since the react-markdown→lib/markdown swap; keep headroom for growth
  it.skipIf(!existsSync(contentJs))('content.js stays under 400 KB', () => {
    expect(readFileSync(contentJs).length / 1024).toBeLessThan(400);
  });

  it.skipIf(!existsSync(contentJs))('shared popup/options chunk stays under 380 KB', () => {
    const file = sharedChunk();
    expect(file).toBeDefined();
    expect(readFileSync(resolve(outDir, 'chunks', file!)).length / 1024).toBeLessThan(380);
  });
});
