import { GATEWAY, patItem, agentIdItem, envIdItem, vaultIdItem, sessionIdItem, deepseekKeyItem } from '@/lib/settings';
import { dict, langItem } from '@/lib/i18n';
import { parseSSE } from '@/lib/sse';

type ChatOut =
  | { type: 'delta'; text: string }
  | { type: 'done' }
  | { type: 'error'; code?: 'unconfigured' | 'auth'; message?: string };

async function api(pat: string, path: string, init?: RequestInit) {
  const res = await fetch(GATEWAY + path, {
    ...init,
    headers: {
      Authorization: `Bearer ${pat}`,
      // multipart body: let fetch set the boundary itself
      ...(init?.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
      ...init?.headers,
    },
  });
  // single choke point: every endpoint routes through here
  if (res.status === 401 || res.status === 403)
    throw Object.assign(new Error(`HTTP ${res.status}`), { code: 'auth' as const });
  return res;
}

async function createSession(pat: string, agentId: string, envId: string, vaultId: string) {
  const res = await api(pat, '/sessions', {
    method: 'POST',
    body: JSON.stringify({
      agent: { id: agentId, type: 'agent' },
      environment_id: envId,
      title: 'Pixel Agent',
      ...(vaultId ? { vault_ids: [vaultId] } : {}),
    }),
  });
  if (!res.ok) throw new Error(`create session: HTTP ${res.status}`);
  const session = await res.json();
  await sessionIdItem.setValue(session.id);
  return session.id as string;
}

type PageContext = { url: string; title: string; text: string };
type Mount = { fileId: string; path: string; note: string };

async function uploadFile(pat: string, name: string, blob: Blob) {
  const form = new FormData();
  form.append('file', blob, name);
  const res = await api(pat, '/files', { method: 'POST', body: form });
  if (!res.ok) throw new Error(`upload file: HTTP ${res.status}`);
  return (await res.json()).id as string;
}

function postUserMessage(
  pat: string,
  sessionId: string,
  text: string,
  page?: PageContext,
  notes: string[] = [],
) {
  // context is inlined into the user message: agents with browser tools ignore
  // side-channel context and open their own (blank) cloud browser instead
  let body = page
    ? `${text}\n\n---\n[Page context] The page below is already open in the user's LOCAL browser. Answer from this content. Do NOT use your own browser tools — your cloud browser cannot see the user's page.\nURL: ${page.url}\nTitle: ${page.title}\n\n${page.text}`
    : text;
  for (const note of notes) body += `\n\n${note}`;
  return api(pat, `/sessions/${sessionId}/events`, {
    method: 'POST',
    body: JSON.stringify({
      events: [{ type: 'user.message', content: [{ type: 'text', text: body }] }],
    }),
  });
}

/** Read the SSE stream and forward agent.message deltas until the turn ends. */
async function streamReply(
  pat: string,
  sessionId: string,
  signal: AbortSignal,
  send: (msg: ChatOut) => void,
  isPosted: () => boolean,
) {
  const res = await api(pat, `/sessions/${sessionId}/events/stream?event_deltas[]=agent.message`, {
    headers: { Accept: 'text/event-stream' },
    signal,
  });
  if (!res.ok || !res.body) throw new Error(`stream: HTTP ${res.status}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const frames = parseSSE(buffer + decoder.decode(value, { stream: true }));
    buffer = frames.rest;

    // one read() often carries several frames; coalesce so the UI re-renders once per read
    let text = '';
    for (const data of frames.data) {
      let payload;
      try {
        payload = JSON.parse(data);
      } catch {
        continue;
      }
      // isPosted also gates deltas: a fresh stream replays the old turn's in-flight deltas
      // ponytail: only agent.message emits deltas today; if that changes, filter via event_start's event.id→type map
      if (payload.type === 'event_delta' && isPosted() && payload.delta?.content?.text) {
        text += payload.delta.content.text;
      } else if (payload.type === 'session.status_idle' && isPosted()) {
        // ponytail: isPosted filters idle events replayed before our POST returns; if long
        // histories ever race past it, key off our user.message event id instead
        if (text) send({ type: 'delta', text });
        send({ type: 'done' });
        return;
      }
    }
    if (text) send({ type: 'delta', text });
  }
}

async function handleChat(
  text: string,
  page: PageContext | undefined,
  screenshot: boolean,
  signal: AbortSignal,
  send: (msg: ChatOut) => void,
) {
  const [pat, agentId, envId, vaultId] = await Promise.all([
    patItem.getValue(),
    agentIdItem.getValue(),
    envIdItem.getValue(),
    vaultIdItem.getValue(),
  ]);
  if (!pat || !agentId || !envId) {
    send({ type: 'error', code: 'unconfigured' });
    return;
  }

  let sessionId = await sessionIdItem.getValue();

  // uploads happen once; mounting is per-session, so it happens inside tryTurn
  const mounts: Mount[] = [];
  if (screenshot) {
    // captured here, not in the content script: tabs.captureVisibleTab only exists
    // in extension contexts and needs the <all_urls> host permission
    const dataUrl = await browser.tabs.captureVisibleTab({ format: 'jpeg', quality: 80 });
    mounts.push({
      fileId: await uploadFile(pat, 'screenshot.jpg', await (await fetch(dataUrl)).blob()),
      path: '/data/input/screenshot.jpg',
      note: "[Screenshot] A screenshot of the page currently visible in the user's browser is mounted at /data/input/screenshot.jpg in your workspace. View it when relevant.",
    });
  }

  // one turn = open stream first (no missed events), then post; false = session gone
  const tryTurn = async (sid: string) => {
    let posted = false;
    const turn = new AbortController();
    const turnSignal = AbortSignal.any([signal, turn.signal]); // Chrome 116+
    try {
      for (const m of mounts) {
        const mounted = await api(pat, `/sessions/${sid}/resources`, {
          method: 'POST',
          body: JSON.stringify({ type: 'file', file_id: m.fileId, mount_path: m.path }),
        });
        if (mounted.status === 404) return false; // dead session: recreate and re-mount
        if (!mounted.ok) throw new Error(`mount file: HTTP ${mounted.status}`);
      }
      const streaming = streamReply(pat, sid, turnSignal, send, () => posted);
      // pre-await rejections (dead-session 404, failure-path abort) must not fire
      // unhandledrejection; `await streaming` below still surfaces the error
      streaming.catch(() => {});
      let res = await postUserMessage(pat, sid, text, page, mounts.map((m) => m.note));
      if (res.status === 409) {
        // previous turn still running (e.g. re-submit): cancel it, then retry the post
        await api(pat, `/sessions/${sid}/cancel`, { method: 'POST' });
        // ponytail: cancel→idle is async; bounded poll, swap for an onIdle hook if flaky
        for (let i = 0; i < 5 && res.status === 409; i++) {
          await new Promise((r) => setTimeout(r, 1000));
          res = await postUserMessage(pat, sid, text, page, mounts.map((m) => m.note));
        }
      }
      if (res.status === 404) return false;
      if (!res.ok) throw new Error(`send message: HTTP ${res.status}`);
      posted = true;
      await streaming;
      return true;
    } finally {
      turn.abort(); // success: streaming already resolved, no-op; failure: reclaim the SSE fetch
    }
  };

  if (!sessionId || !(await tryTurn(sessionId))) {
    // no cached session or it expired: create a fresh one and retry once
    sessionId = await createSession(pat, agentId, envId, vaultId);
    if (!(await tryTurn(sessionId))) throw new Error('session not found after create');
  }
}

// ---- 双语对照翻译：DeepSeek Responses API 代理 ----
// ponytail: 内存 Map 缓存，SW 挂起即失效；若命中率不够再升级 Cache API + hash 键
const transCache = new Map<string, string>();

// 并发上限：https://api-docs.deepseek.com/zh-cn/quick_start/rate_limit 用户级并发限额
const DEEPSEEK_CONCURRENCY = 200;

async function deepseekTranslate(texts: string[], to: string): Promise<string[]> {
  const key = await deepseekKeyItem.getValue();
  if (!key) throw Object.assign(new Error('no deepseek key'), { code: 'unconfigured' });

  const out = texts.map((t) => transCache.get(`${to}|${t}`));
  const misses = texts.map((_, i) => i).filter((i) => out[i] === undefined);

  // 按字符量切批（≤3000 字符且 ≤30 段）：LLM 单请求延迟高，批太大首屏等待过久
  const batches: number[][] = [];
  for (let start = 0; start < misses.length; ) {
    const batch: number[] = [];
    let chars = 0;
    while (start < misses.length && batch.length < 30 && chars < 3000) {
      chars += texts[misses[start]].length;
      batch.push(misses[start++]);
    }
    batches.push(batch);
  }

  const run = async (batch: number[]) => {
    const body = JSON.stringify({
      model: 'deepseek-v4-flash', // Responses API 目前仅支持此模型
      instructions: `You are a translation engine. Translate each string in the user's JSON array into ${to}. Reply with ONLY a JSON object {"t": string[]} where t has the same length and order as the input. Keep untranslatable strings (numbers, codes) unchanged.`,
      input: JSON.stringify(batch.map((i) => texts[i])),
      text: { format: { type: 'json_object' } },
      temperature: 1.3, // DeepSeek 官方翻译场景推荐值
    });

    let res: Response;
    for (let attempt = 0; ; attempt++) {
      res = await fetch('https://api.deepseek.com/v1/responses', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body,
      });
      if ((res.status !== 429 && res.status < 500) || attempt >= 3) break;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    }
    if (res.status === 401 || res.status === 403)
      throw Object.assign(new Error(`HTTP ${res.status}`), { code: 'auth' as const });
    if (!res.ok) throw new Error(`translate: HTTP ${res.status}`);

    // 非流式响应：output 里 type==='message' 项的 output_text 块即译文 JSON
    const data = await res.json();
    const raw = data.output
      ?.find((o: { type: string }) => o.type === 'message')
      ?.content?.find((c: { type: string }) => c.type === 'output_text')?.text;
    let translated: unknown;
    try {
      translated = JSON.parse(raw).t;
    } catch {
      translated = null;
    }
    // 长度对不上 = 模型跑偏：该批保持原文，不注入错位译文
    if (!Array.isArray(translated) || translated.length !== batch.length) return;
    batch.forEach((idx, j) => {
      out[idx] = String(translated[j]);
      transCache.set(`${to}|${texts[idx]}`, out[idx]!);
    });
  };

  // 按并发上限分组并行；每次 fetch 也顺带重置 MV3 SW 的 30s 空闲计时器
  for (let i = 0; i < batches.length; i += DEEPSEEK_CONCURRENCY)
    await Promise.all(batches.slice(i, i + DEEPSEEK_CONCURRENCY).map(run));

  // 失败批的段落回退为原文（content 侧≡原文不注入）
  return out.map((t, i) => t ?? texts[i]);
}

export default defineBackground(() => {
  // "save clip" context menu; title follows the UI language
  browser.runtime.onInstalled.addListener(async () => {
    browser.contextMenus.create({
      id: 'save-clip',
      title: dict[await langItem.getValue()]['clips.menu'],
      contexts: ['selection'],
    });
  });
  langItem.watch((lang) => {
    browser.contextMenus.update('save-clip', { title: dict[lang]['clips.menu'] });
  });
  // the content script owns the save: it has the live Selection for fragment generation
  browser.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId === 'save-clip' && tab?.id)
      browser.tabs.sendMessage(tab.id, { type: 'saveClip' }).catch(() => {
        /* no content script on this page (chrome://, store) */
      });
  });

  // 整页翻译：content 受页面 CORS 限制，由这里持 host_permissions 代发；返回 Promise 保持通道开放
  browser.runtime.onMessage.addListener((msg: { type?: string; texts?: string[]; to?: string }) => {
    if (msg?.type === 'translate' && msg.texts && msg.to) return deepseekTranslate(msg.texts, msg.to);
  });

  browser.runtime.onConnect.addListener((port) => {
    if (port.name !== 'chat') return;
    const abort = new AbortController();
    port.onDisconnect.addListener(() => abort.abort());
    port.onMessage.addListener((msg: { text: string; page?: PageContext; screenshot?: boolean }) => {
      const send = (out: ChatOut) => {
        try {
          port.postMessage(out);
        } catch {
          /* port closed */
        }
      };
      // MV3 kills the worker after 30s without extension API activity; a screenshot
      // turn (tool call + thinking) can stream nothing for that long, so ping to stay alive
      const keepalive = setInterval(() => browser.runtime.getPlatformInfo(), 20_000);
      handleChat(msg.text, msg.page, !!msg.screenshot, abort.signal, send)
        .catch((err) => {
          console.error('[pixel-agent]', err); // port may be gone; keep a trace in the SW console
          if (!abort.signal.aborted)
            send({ type: 'error', code: err?.code, message: String(err?.message ?? err) });
        })
        .finally(() => clearInterval(keepalive));
    });
  });
});
