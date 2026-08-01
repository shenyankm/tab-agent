import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// the content script is injected into every page, so its size is a per-page
// parse cost; cap it so dependency upgrades can't silently bloat it
// resolved relative to this file (import.meta.dirname, Node 20.11+), so the
// vitest working directory doesn't matter
const contentJs = resolve(import.meta.dirname, '../.output/chrome-mv3/content-scripts/content.js');

describe('content bundle size', () => {
  // skipped when unbuilt (local `pnpm test` runs without `wxt build`); CI gates the build
  it.skipIf(!existsSync(contentJs))('content.js stays under 520 KB', () => {
    expect(readFileSync(contentJs).length / 1024).toBeLessThan(520);
  });
});
