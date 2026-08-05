// Real-browser chat E2E against the live gateway (api.qoder.com).
// Usage: node tests/e2e/chat.mjs
// Env:   TAB_EXT_DIR — extension build dir (default .output/chrome-mv3)
//        TAB_CHROME  — Chrome binary (default /usr/bin/google-chrome)
//        Credentials come from the repo-root .env (PAT/AGENT_ID/ENV_ID/VAULT_ID)
// Skips (exit 0) when .env is missing — CI runs without live credentials.
import { chromium } from 'playwright-core';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const EXT_DIR = path.resolve(process.env.TAB_EXT_DIR ?? path.join(ROOT, '.output/chrome-mv3'));
const CHROME = process.env.TAB_CHROME ?? '/usr/bin/google-chrome';

// --- .env parsing (no dotenv dep: KEY=VALUE lines, first wins) ---
const envFile = path.join(ROOT, '.env');
if (!fs.existsSync(envFile)) {
  console.log('SKIP  .env not found — live chat test needs real credentials');
  process.exit(0);
}
const env = {};
for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.+?)\s*$/);
  if (m && !(m[1] in env)) env[m[1]] = m[2].replace(/^"|"$/g, ''); // strip surrounding quotes
}
const { PAT, AGENT_ID, ENV_ID, VAULT_ID } = env;
if (!PAT || !AGENT_ID || !ENV_ID) {
  console.log('SKIP  .env lacks PAT/AGENT_ID/ENV_ID — live chat test needs real credentials');
  process.exit(0);
}

if (!fs.existsSync(path.join(EXT_DIR, 'manifest.json'))) {
  console.error(`extension build not found at ${EXT_DIR} — run \`pnpm build\` first`);
  process.exit(1);
}

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

const server = http.createServer((_req, res) => {
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end(`<!doctype html><html><head><title>Chat E2E</title></head><body>
    <article><h1>Chat E2E article</h1>
    <p>Tab Agent chat e2e page with enough article text for Readability to parse it as an article body. Lorem ipsum dolor sit amet consectetur adipiscing elit.</p>
    </article></body></html>`);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const pageUrl = `http://127.0.0.1:${server.address().port}/`;

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'tab-agent-chat-'));
const context = await chromium.launchPersistentContext(profile, {
  executablePath: CHROME,
  headless: false,
  ignoreDefaultArgs: ['--disable-extensions'],
  args: CHROME_ARGS,
});

try {
  const sw = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker', { timeout: 15_000 }));

  // configure credentials exactly like the settings page does
  await sw.evaluate(async ([pat, agentId, envId, vaultId]) => {
    await chrome.storage.local.set({ pat, agentId, envId, vaultId });
  }, [PAT, AGENT_ID, ENV_ID, VAULT_ID]);

  const page = await context.newPage();
  await page.goto(pageUrl, { waitUntil: 'load' });
  const host = page.locator('tab-agent-floating-ui');
  await host.waitFor({ state: 'attached', timeout: 10_000 });
  // Playwright pierces open shadow roots natively: no native-setter tricks needed
  await host.locator('.tab-agent-launcher').click();

  const ask = async (text) => {
    const input = host.locator('#tab-agent-query');
    await input.fill(text);
    await host.locator('form').press('Enter');
    // the send lands as a user bubble — wait for it so the next ask starts clean
    await host.locator('.tab-agent-bubble-user').last().filter({ hasText: text }).waitFor({ timeout: 5_000 });
  };
  const lastReply = () => host.locator('.tab-agent-md').last().textContent();

  // open the panel and ask a question
  await ask('用一句话回答：1+1 等于几？');

  // wait for a non-empty agent reply (streamed deltas land in the last bubble);
  // 断言里排除错误占位文案:流失败时气泡被替换为"请重试"类文案,不含"思考中",
  // 只放循环条件会以错误文案误判 PASS
  const started = Date.now();
  let reply = '';
  while (Date.now() - started < 120_000) {
    reply = ((await lastReply()) ?? '').trim();
    if (reply && !reply.includes('思考中')) break;
    await new Promise((r) => setTimeout(r, 1500));
  }
  check('chat reply streamed from the live gateway',
    reply.length > 0 && !reply.includes('请重试'), reply.slice(0, 120));

  // ask again: must reuse the cached daily session (second turn, no new session)
  await ask('很好，谢谢！');
  const started2 = Date.now();
  let reply2 = '';
  while (Date.now() - started2 < 120_000) {
    reply2 = ((await lastReply()) ?? '').trim();
    if (reply2 && !reply2.includes('思考中')) break;
    await new Promise((r) => setTimeout(r, 1500));
  }
  check('second turn answered (cached session path)',
    reply2.length > 0 && reply2 !== reply && !reply2.includes('请重试'), reply2.slice(0, 120));

  // the session must be recorded in storage under the v4 key
  const sess = await sw.evaluate(async () => (await chrome.storage.local.get('sessionId.v4'))['sessionId.v4']);
  check('daily session persisted in storage', !!sess?.id && !!sess?.day, JSON.stringify(sess));

  await page.close();
} finally {
  await context.close();
  server.close();
  fs.rmSync(profile, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
