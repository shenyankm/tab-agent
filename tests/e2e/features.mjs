// Full-feature live E2E against the real gateway (api.qoder.com) with .env credentials.
// Covers what extension.mjs/chat.mjs don't: article page context, summarize button,
// none/screenshot carry modes, whole-page & image clips, options search/note/delete,
// popup rendering.
// Usage: pnpm build && node tests/e2e/features.mjs
import { chromium } from 'playwright-core';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const EXT_DIR = path.resolve(process.env.TAB_EXT_DIR ?? path.join(ROOT, '.output/chrome-mv3'));
const CHROME = process.env.TAB_CHROME ?? '/usr/bin/google-chrome';

// --- .env parsing (same rules as chat.mjs) ---
const env = {};
for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.+?)\s*$/);
  if (m && !(m[1] in env)) env[m[1]] = m[2].replace(/^"|"$/g, '');
}
const { PAT, AGENT_ID, ENV_ID } = env;
if (!PAT || !AGENT_ID || !ENV_ID) {
  console.log('SKIP  .env lacks PAT/AGENT_ID/ENV_ID');
  process.exit(0);
}

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

// unique markers the agent can only know from page content / the screenshot
const TOKEN = 'ZXQ-4837';
const HEADLINE = 'Features E2E 总标题';
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const server = http.createServer((req, res) => {
  if (req.url === '/pixel.png') {
    res.setHeader('content-type', 'image/png');
    res.end(Buffer.from(PNG_B64, 'base64'));
    return;
  }
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end(`<!doctype html><html><head><title>Features E2E</title></head><body>
    <article>
      <h1 style="font-size:64px">${HEADLINE}</h1>
      <p>本页正文包含一串魔法令牌 ${TOKEN}，用于验证页面上下文确实被提取并发送。
      Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.</p>
      <p>第二段填充文本让 Readability 判定为正文。Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat.</p>
      <img src="/pixel.png" alt="E2E 图片替代文本">
    </article>
  </body></html>`);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const pageUrl = `http://127.0.0.1:${server.address().port}/`;

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'tab-agent-feat-'));
const context = await chromium.launchPersistentContext(profile, {
  executablePath: CHROME,
  headless: false,
  ignoreDefaultArgs: ['--disable-extensions'],
  args: [
    '--headless=new',
    '--no-sandbox',
    '--disable-features=DisableDisableExtensionsExceptCommandLineSwitch',
    `--disable-extensions-except=${EXT_DIR}`,
    `--load-extension=${EXT_DIR}`,
  ],
});

try {
  const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker', { timeout: 15_000 }));
  const extId = new URL(sw.url()).host;
  await sw.evaluate(async ([pat, agentId, envId]) => {
    await chrome.storage.local.set({ pat, agentId, envId });
  }, [PAT, AGENT_ID, ENV_ID]);
  check('service worker started + credentials configured', true, extId);

  const page = await context.newPage();
  await page.goto(pageUrl, { waitUntil: 'load' });
  const host = page.locator('tab-agent-floating-ui');
  await host.waitFor({ state: 'attached', timeout: 10_000 });
  await host.locator('.tab-agent-launcher').waitFor({ timeout: 5_000 });
  check('pet UI mounted (agent-ui chunk injected)', true);

  const tabId = await sw.evaluate(async () =>
    (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id);

  // ---------- clips: whole page / image / selection ----------
  await sw.evaluate((id) => chrome.tabs.sendMessage(id, { type: 'saveClipPage' }), tabId);
  await sw.evaluate(([id, src]) => chrome.tabs.sendMessage(id, { type: 'saveClipImage', srcUrl: src, altText: 'E2E 图片替代文本' }), [tabId, `${pageUrl}pixel.png`]);

  // selection → saveClip → edit card → save
  await page.evaluate((token) => {
    const p = document.querySelector('p');
    const idx = p.textContent.indexOf(token);
    const range = document.createRange();
    range.setStart(p.firstChild, idx);
    range.setEnd(p.firstChild, idx + token.length);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  }, TOKEN);
  await sw.evaluate((id) => chrome.tabs.sendMessage(id, { type: 'saveClip' }), tabId);
  await host.locator('button[type="submit"]').click(); // 编辑卡片直接保存
  await page.waitForSelector('mark', { timeout: 8_000 });
  check('selection clip saved + marked (agent-marks chunk)', true);

  // read IDB from the options origin
  const opt = await context.newPage();
  await opt.goto(`chrome-extension://${extId}/options.html#clips`, { waitUntil: 'load' });
  const readClips = () => opt.evaluate(async () => {
    const db = await new Promise((res, rej) => {
      const r = indexedDB.open('tab-agent');
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    const clips = await new Promise((res, rej) => {
      const r = db.transaction('clips').objectStore('clips').getAll();
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
    db.close();
    return clips;
  });
  let clips = [];
  for (let i = 0; i < 10 && clips.length < 3; i++) {
    clips = await readClips();
    if (clips.length < 3) await opt.waitForTimeout(500);
  }
  const kinds = clips.map((c) => c.kind ?? 'selection').sort();
  check('page clip saved via agent-pagetext chunk', kinds.includes('page'), JSON.stringify(kinds));
  check('image clip saved', clips.some((c) => c.kind === 'image' && c.text === 'E2E 图片替代文本'));
  check('selection clip in IDB', clips.some((c) => c.text === TOKEN && c.url.includes(':~:text=')));

  // ---------- options UI: list / search / note / delete ----------
  await opt.getByPlaceholder('搜索摘录…').fill(TOKEN);
  await opt.getByText(TOKEN, { exact: true }).waitFor({ timeout: 5_000 });
  check('options clips search filters', (await opt.getByText('E2E 图片替代文本').count()) === 0);
  await opt.getByPlaceholder('搜索摘录…').fill('');

  const row = opt.locator('div').filter({ hasText: TOKEN }).last();
  await opt.getByLabel('更多操作').first().click();
  await opt.getByRole('menuitem', { name: '备注' }).click();
  await opt.getByPlaceholder('添加标注（每行一条）…').fill('第一条备注\n第二条备注');
  await opt.getByRole('button', { name: '保存', exact: true }).click();
  await opt.waitForTimeout(800);
  clips = await readClips();
  check('note saved onto clip', clips.some((c) => c.text === TOKEN && c.notes?.length === 2));

  // delete the image clip through the UI
  await opt.getByLabel('更多操作').last().click(); // newest-first: 最后一条是最早的 image clip? 按文本定位更稳
  const menus = opt.getByRole('menuitem', { name: '删除' });
  await menus.click();
  await opt.getByRole('button', { name: '删除', exact: true }).click();
  await opt.waitForTimeout(800);
  clips = await readClips();
  check('clip deleted through options UI', clips.length === 2, `remaining=${clips.length}`);
  await opt.close();

  // ---------- popup ----------
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extId}/popup.html`, { waitUntil: 'load' });
  await popup.getByText('显示宠物').waitFor({ timeout: 5_000 });
  check('popup renders with pet toggle', true);
  await popup.close();

  // ---------- chat: article context / none / screenshot / summarize ----------
  await host.locator('.tab-agent-launcher').click();
  const ask = async (text) => {
    await host.locator('#tab-agent-query').fill(text);
    await host.locator('form').press('Enter');
    await host.locator('.tab-agent-bubble-user').last().filter({ hasText: text.slice(0, 12) }).waitFor({ timeout: 5_000 });
  };
  // 等最新气泡稳定:两轮文本一致、非"思考中"、非空——流式中途的半截文本不算完
  const waitStableReply = async (timeout = 150_000) => {
    const started = Date.now();
    let prev = '';
    while (Date.now() - started < timeout) {
      const cur = ((await host.locator('.tab-agent-md').last().textContent()) ?? '').trim();
      if (cur && cur === prev && !cur.includes('思考中')) return cur;
      prev = cur;
      await page.waitForTimeout(2000);
    }
    return prev;
  };
  const isError = (t) => ['请重试', '尚未配置', '无效或已过期', '连接中断'].some((s) => t.includes(s));

  await ask(`本页正文里有一串格式为 XXX-0000 的魔法令牌,只回答这串令牌本身`);
  const r1 = await waitStableReply();
  check('article page context reaches the agent (Readability)', r1.includes(TOKEN) && !isError(r1), r1.slice(0, 80));

  await sw.evaluate(() => chrome.storage.local.set({ pageCarry: 'none' }));
  await ask('只回答一个数字:3+5 等于几?');
  const r2 = await waitStableReply();
  check('none mode: chat works without page metadata', r2.includes('8') && !isError(r2), r2.slice(0, 80));

  await sw.evaluate(() => chrome.storage.local.set({ pageCarry: 'screenshot' }));
  await ask('看截图,页面顶部最大的标题文字是什么?只回答标题本身');
  const r3 = await waitStableReply(180_000); // 截图回合含工具调用,流可能长时间静默
  check('screenshot mode: capture + upload + mount (host permission)', r3.includes('Features E2E') && !isError(r3), r3.slice(0, 100));
  await sw.evaluate(() => chrome.storage.local.set({ pageCarry: 'article' }));

  await host.locator('button[aria-label="总结当前页面"]').click();
  const r4 = await waitStableReply(180_000);
  check('summarize button produces a summary', r4.length > 20 && !isError(r4), r4.slice(0, 100));

  // daily session reused across all turns
  const sess = await sw.evaluate(async () => (await chrome.storage.local.get('sessionId.v4'))['sessionId.v4']);
  check('one daily session across all turns', !!sess?.id, sess?.id ?? '');

  await page.close();
} finally {
  await context.close();
  server.close();
  fs.rmSync(profile, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
