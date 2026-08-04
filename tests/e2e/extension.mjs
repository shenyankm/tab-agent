// Real-browser E2E for the Pixel Agent extension (playwright-core + system Chrome).
// Usage: node tests/e2e/extension.mjs [--graph-only]
// Env:   PIXEL_EXT_DIR — extension build dir (default .output/chrome-mv3)
//        PIXEL_CHROME  — Chrome binary (default /usr/bin/google-chrome)
import { chromium } from 'playwright-core';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const EXT_DIR = path.resolve(process.env.PIXEL_EXT_DIR ?? '.output/chrome-mv3');
const CHROME = process.env.PIXEL_CHROME ?? '/usr/bin/google-chrome';
const GRAPH_ONLY = process.argv.includes('--graph-only');

// fail fast with an actionable message instead of a 15s service-worker timeout
if (!fs.existsSync(path.join(EXT_DIR, 'manifest.json'))) {
  console.error(`extension build not found at ${EXT_DIR} — run \`pnpm build\` first`);
  process.exit(1);
}

// Chrome 136+: --load-extension/--disable-extensions-except are gated behind a
// (double-negative) feature flag that must be disabled for the switches to work
const CHROME_ARGS = [
  '--headless=new',
  '--no-sandbox',
  '--disable-features=DisableDisableExtensionsExceptCommandLineSwitch',
  `--disable-extensions-except=${EXT_DIR}`,
  `--load-extension=${EXT_DIR}`,
];

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

// --- a test page with selectable text ---
const PAGE_TEXT = 'Pixel Agent E2E unique selection phrase forty two';
const server = http.createServer((req, res) => {
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end(`<!doctype html><html><head><title>E2E Test Page</title></head><body>
    <article>
      <h1>E2E article heading</h1>
      <p>${PAGE_TEXT}. Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.</p>
      <p>Second paragraph with more filler text so Readability sees an article. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris.</p>
    </article>
  </body></html>`);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const pageUrl = `http://127.0.0.1:${server.address().port}/`;

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'pixel-agent-e2e-'));
const context = await chromium.launchPersistentContext(profile, {
  executablePath: CHROME,
  headless: false,
  ignoreDefaultArgs: ['--disable-extensions'], // playwright disables extensions by default
  args: CHROME_ARGS,
});

try {
  // --- extension service worker ---
  const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker', { timeout: 15_000 }));
  const extId = new URL(sw.url()).host;
  check('service worker started', true, extId);

  const optionsUrl = `chrome-extension://${extId}/options.html`;

  if (!GRAPH_ONLY) {
    // --- content script mounts the shadow UI on a real page ---
    const page = await context.newPage();
    await page.goto(pageUrl, { waitUntil: 'load' });
    const host = page.locator('pixel-agent-floating-ui');
    await host.waitFor({ state: 'attached', timeout: 10_000 });
    check('content script mounts shadow UI host', true);

    const hasLauncher = await host.evaluate((el) => !!el.shadowRoot?.querySelector('.pixel-agent-launcher'));
    check('pet launcher rendered inside shadow root', hasLauncher);

    // --- save-a-clip flow: selection → edit card → IDB → in-page mark ---
    await page.evaluate((text) => {
      const p = document.querySelector('p');
      const idx = p.textContent.indexOf(text);
      const range = document.createRange();
      range.setStart(p.firstChild, idx);
      range.setEnd(p.firstChild, idx + text.length);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }, PAGE_TEXT);

    // no "tabs" permission: tab.url is hidden from the extension, so locate the
    // test page as the active tab of the current window instead
    const tabId = await sw.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      return tab?.id;
    });
    check('service worker sees the test tab', typeof tabId === 'number');

    // same message the context menu sends
    await sw.evaluate((id) => chrome.tabs.sendMessage(id, { type: 'saveClip' }), tabId);
    const saveBtn = host.locator('button[type="submit"]');
    await saveBtn.waitFor({ timeout: 5_000 }); // the edit card popped
    await saveBtn.click();
    await page.waitForSelector('mark', { timeout: 5_000 });
    check('clip saved and text marked in page', true);

    // highlight replay after a real reload (IDB → background → content script)
    await page.reload({ waitUntil: 'load' });
    await page.waitForSelector('mark', { timeout: 10_000 });
    check('highlight replays after reload', true);

    // --- pet toggle unmounts/remounts the whole shadow UI ---
    await sw.evaluate(() => chrome.storage.local.set({ petEnabled: false }));
    await host.waitFor({ state: 'detached', timeout: 5_000 });
    check('pet toggle off unmounts the UI', true);
    await sw.evaluate(() => chrome.storage.local.set({ petEnabled: true }));
    await page.locator('pixel-agent-floating-ui').waitFor({ state: 'attached', timeout: 5_000 });
    check('pet toggle on remounts the UI', true);

    // --- options clips page lists the saved clip (createdAt index read) ---
    const opt = await context.newPage();
    await opt.goto(`${optionsUrl}#clips`, { waitUntil: 'load' });
    await opt.getByText(PAGE_TEXT, { exact: false }).waitFor({ timeout: 10_000 });
    check('options clips page lists the saved clip', true);
    await opt.close();
    await page.close();
  }

  // --- IDB v2 with both indexes (real Chromium IndexedDB) ---
  const opt2 = await context.newPage();
  await opt2.goto(optionsUrl, { waitUntil: 'load' });
  const dbInfo = await opt2.evaluate(async () => {
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open('pixel-agent');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    const store = db.transaction('clips').objectStore('clips');
    const info = { version: db.version, indexes: [...store.indexNames] };
    db.close();
    return info;
  });
  check('IndexedDB is v2 with createdAt/pageUrl indexes',
    dbInfo.version === 2 && dbInfo.indexes.includes('createdAt') && dbInfo.indexes.includes('pageUrl'),
    JSON.stringify(dbInfo));

  // --- graph stability: an unrelated setState must NOT rebuild the d3 graph ---
  // seed classified clips directly into the extension-origin IDB
  await opt2.evaluate(async () => {
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open('pixel-agent');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    const tx = db.transaction('clips', 'readwrite');
    const store = tx.objectStore('clips');
    const rows = [
      { id: 'g1', category: 'concept', relatedIds: ['g2', 'g3'] },
      { id: 'g2', category: 'concept', relatedIds: ['g1'] },
      { id: 'g3', category: 'tool', relatedIds: ['g1'] },
      { id: 'g4', category: 'tool', relatedIds: [] },
      { id: 'g5', category: 'reference', relatedIds: ['g4'] },
    ];
    rows.forEach((row, i) => store.put({
      url: `https://e.com/p${i}`, pageUrl: `https://e.com/p${i}`, title: `T${i}`,
      text: `graph seed clip ${i} with enough text for a label`, createdAt: 1000 + i,
      ...row,
    }));
    await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); });
    db.close();
  });

  await opt2.goto(`${optionsUrl}#graph`, { waitUntil: 'load' });
  await opt2.reload({ waitUntil: 'load' }); // hash-only navigation doesn't remount the tab
  const firstCircle = opt2.locator('svg circle').first();
  await firstCircle.waitFor({ timeout: 10_000 });
  const nodeCount = await opt2.locator('svg circle').count();
  check('graph renders seeded nodes', nodeCount === 5, `circles=${nodeCount}`);

  // sentinel attribute on a live node; any simulation rebuild wipes it
  await firstCircle.evaluate((el) => el.setAttribute('data-sentinel', '1'));

  // zoom in first: a rebuild would reset the transform back to zoomIdentity
  const svgBox = await opt2.locator('svg.h-96').boundingBox();
  await opt2.mouse.move(svgBox.x + svgBox.width / 2, svgBox.y + svgBox.height / 2);
  await opt2.mouse.wheel(0, -600);
  await opt2.waitForFunction(
    () => document.querySelector('svg g.graph-root')?.getAttribute('transform')?.includes('scale') ?? false,
    { timeout: 5_000 },
  );
  const transformBefore = await opt2.locator('svg g.graph-root').getAttribute('transform');

  // classify without a configured PAT fails fast (unconfigured) — but still runs
  // setClassifying(true) → clips read → setClassifying(false): the regression
  // rebuilt the whole SVG (and restarted the simulation) on each of those states
  await opt2.locator('button:has(svg.lucide-brain)').first().click();
  await opt2.waitForFunction(
    () => !document.querySelector('button:has(svg.lucide-brain)')?.disabled,
    { timeout: 15_000 },
  );

  const sentinelAlive = (await opt2.locator('circle[data-sentinel]').count()) === 1;
  const transformAfter = await opt2.locator('svg g.graph-root').getAttribute('transform');
  check('graph NOT rebuilt by unrelated setState (sentinel survives)', sentinelAlive);
  check('zoom transform preserved across classify click', transformBefore === transformAfter,
    `${transformBefore} vs ${transformAfter}`);

  await opt2.close();
} finally {
  await context.close();
  server.close();
  fs.rmSync(profile, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
