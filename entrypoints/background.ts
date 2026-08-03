import { GATEWAY, patItem, agentIdItem, envIdItem, vaultIdItem, sessionIdItem } from '@/lib/settings';
import { dict, langItem } from '@/lib/i18n';
import { parseSSE } from '@/lib/sse';
import { getClipsDirect, addClipDirect, removeClipDirect, updateClipDirect, updateClipsDirect, normalizeUrl, type Clip } from '@/lib/clips';

// MV3 kills the worker after 30s without extension API activity; ping to stay alive
// while a turn or batch classify streams nothing for that long
const keepalive = () => setInterval(() => void browser.runtime.getPlatformInfo().catch(() => {}), 20_000);

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
  return (await res.json()).id as string;
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

  // ponytail: 90s read timeout — covers silent connection drops where TCP never
  // signals closure (MV3 worker suspension, proxy idle-kill). Agent tool calls
  // (WebFetch, Bash) can take 30-60s; heartbeats arrive every ~15s, so 90s of
  // silence means the connection is dead. Upgrade to a heartbeat-aware watchdog
  // if false positives appear.
  let timer: ReturnType<typeof setTimeout> = 0 as any;
  let rejectTimeout: (e: Error) => void;
  const timeout = new Promise<never>((_, reject) => { rejectTimeout = reject; });
  const armTimeout = () => { clearTimeout(timer); timer = setTimeout(() => rejectTimeout(new Error('stream read timeout')), 90_000); };
  const onAbort = () => rejectTimeout(signal.reason ?? new Error('aborted'));
  signal.addEventListener('abort', onAbort, { once: true });
  armTimeout();

  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), timeout]);
      if (done) break;
      armTimeout(); // reset for next read
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
    // stream closed without session.status_idle (server close, network drop, or the
    // idle event was filtered by the isPosted gate during replay) — complete the turn
    // so the content script doesn't hang in "thinking" forever
    send({ type: 'done' });
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }
}

async function handleChat(
  text: string,
  page: PageContext | undefined,
  screenshot: boolean,
  signal: AbortSignal,
  send: (msg: ChatOut) => void,
  /** Pass a session id to reuse it; pass '' to force-create a dedicated one (falsy → new session). */
  ownSession?: string,
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

  let sessionId = ownSession ?? await sessionIdItem.getValue();

  // upload happens once; mounting is per-session, so it happens inside tryTurn
  let mount: Mount | null = null;
  if (screenshot) {
    // captured here, not in the content script: tabs.captureVisibleTab only exists
    // in extension contexts and needs the <all_urls> host permission
    const dataUrl = await browser.tabs.captureVisibleTab({ format: 'jpeg', quality: 80 });
    mount = {
      fileId: await uploadFile(pat, 'screenshot.jpg', await (await fetch(dataUrl)).blob()),
      path: '/data/input/screenshot.jpg',
      note: "[Screenshot] A screenshot of the page currently visible in the user's browser is mounted at /data/input/screenshot.jpg in your workspace. View it when relevant.",
    };
  }
  const notes = mount ? [mount.note] : [];

  // one turn = open stream first (no missed events), then post; false = session gone
  const tryTurn = async (sid: string) => {
    let posted = false;
    const turn = new AbortController();
    const turnSignal = AbortSignal.any([signal, turn.signal]); // Chrome 116+
    try {
      if (mount) {
        const mounted = await api(pat, `/sessions/${sid}/resources`, {
          method: 'POST',
          body: JSON.stringify({ type: 'file', file_id: mount.fileId, mount_path: mount.path }),
        });
        if (mounted.status === 404) return false; // dead session: recreate and re-mount
        if (!mounted.ok) throw new Error(`mount file: HTTP ${mounted.status}`);
      }
      const streaming = streamReply(pat, sid, turnSignal, send, () => posted);
      // pre-await rejections (dead-session 404, failure-path abort) must not fire
      // unhandledrejection; `await streaming` below still surfaces the error
      streaming.catch(() => {});
      let res = await postUserMessage(pat, sid, text, page, notes);
      if (res.status === 409) {
        // previous turn still running (e.g. re-submit): cancel it, then retry the post
        await api(pat, `/sessions/${sid}/cancel`, { method: 'POST' });
        // ponytail: cancel→idle is async; bounded poll, swap for an onIdle hook if flaky
        for (let i = 0; i < 5 && res.status === 409; i++) {
          await new Promise((r) => setTimeout(r, 1000));
          res = await postUserMessage(pat, sid, text, page, notes);
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
    if (ownSession === undefined) await sessionIdItem.setValue(sessionId);
    if (!(await tryTurn(sessionId))) throw new Error('session not found after create');
  }
}

// fan clipsChanged out to content scripts in every tab and to extension pages
// (options) which tabs.sendMessage can't reach.
function fanOutClipsChanged() {
  browser.tabs
    .query({})
    .then((tabs) => {
      for (const tab of tabs)
        if (tab.id)
          browser.tabs.sendMessage(tab.id, { type: 'clipsChanged' }).catch(() => {
            /* no content script on this tab */
          });
    })
    .catch(() => {
      /* tabs.query failed */
    });
  // runtime.sendMessage reaches extension pages (options) but not content scripts;
  // background itself has no watcher, so no echo to worry about here.
  void browser.runtime.sendMessage({ type: 'clipsChanged' }).catch(() => {
    /* no extension page listening */
  });
}

/** Send all clips to the cloud agent for knowledge-type classification, parse the
 *  JSON response and write category/relatedIds back to each clip. */
async function handleClassify(): Promise<{ classified: number }> {
  const clips = await getClipsDirect();
  if (!clips.length) return { classified: 0 };

  const clipList = clips
    .map((c) => `- id: ${c.id}\n  text: ${c.text.slice(0, 500)}`)
    .join('\n');

  const prompt = `Classify the following text clips into knowledge types and identify relationships between them.

Return ONLY a JSON object (no markdown fences) with this exact structure:
{"clips":[{"id":"<clip id>","category":"<knowledge type>","relatedIds":["<other clip id>",...],"tags":["<keyword>",...]}]}

Rules:
- Every clip must have exactly one category
- relatedIds lists clips that are topically related (can be empty)
- tags: up to 3 short topical keywords (can be empty)
- Use consistent category names across clips
- Return nothing except the JSON object

Clips:
${clipList}`;

  // collect the full agent reply via the send callback; use a dedicated session
  // so classify never cancels/pollutes the user's chat session
  const chunks: string[] = [];
  const done = new Promise<void>((resolve, reject) => {
    const send = (msg: ChatOut) => {
      if (msg.type === 'delta') chunks.push(msg.text);
      else if (msg.type === 'done') resolve();
      else if (msg.type === 'error') reject(new Error(msg.message ?? msg.code ?? 'classify error'));
    };
    handleChat(prompt, undefined, false, new AbortController().signal, send, '').catch(reject);
  });
  await done;

  const full = chunks.join('');
  // extract JSON: try direct parse, then try stripping markdown fences
  let parsed: unknown;
  try {
    parsed = JSON.parse(full);
  } catch {
    const m = full.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('no JSON in agent reply');
    parsed = JSON.parse(m[0]);
  }
  const items = (parsed as { clips?: unknown })?.clips;
  if (!Array.isArray(items)) throw new Error('agent reply missing clips array');

  let classified = 0;
  const ids = new Set(clips.map((c) => c.id)); // O(1) membership below (was O(N) per id)
  const patches: { id: string; patch: { category: string; relatedIds: string[]; tags?: string[] } }[] = [];
  for (const item of items) {
    if (!item || typeof item.id !== 'string' || typeof item.category !== 'string') continue;
    if (!ids.has(item.id)) continue;
    patches.push({
      id: item.id,
      patch: {
        category: item.category,
        relatedIds: Array.isArray(item.relatedIds)
          ? item.relatedIds.filter((rid: unknown) => typeof rid === 'string' && ids.has(rid))
          : [],
        // tags are AI-generated; absent in the reply = leave untouched
        ...(Array.isArray(item.tags)
          ? { tags: item.tags.filter((tag: unknown) => typeof tag === 'string') }
          : {}),
      },
    });
    classified++;
  }
  // one transaction instead of N; its single local broadcast + the fan-out below
  // cover every context
  await updateClipsDirect(patches);
  fanOutClipsChanged();
  return { classified };
}

export default defineBackground(() => {
  // warm the extension-origin DB at startup
  void getClipsDirect().catch(() => {
    /* open failed; next access retries */
  });

  // "save clip" context menus; titles follow the UI language
  const MENU_TITLES = {
    'save-clip': 'clips.menu',
    'save-clip-page': 'clips.menu.page',
    'save-clip-image': 'clips.menu.image',
  } as const;
  browser.runtime.onInstalled.addListener(async () => {
    const lang = await langItem.getValue();
    browser.contextMenus.create({ id: 'save-clip', title: dict[lang]['clips.menu'], contexts: ['selection'] });
    browser.contextMenus.create({ id: 'save-clip-page', title: dict[lang]['clips.menu.page'], contexts: ['page'] });
    browser.contextMenus.create({ id: 'save-clip-image', title: dict[lang]['clips.menu.image'], contexts: ['image'] });
  });
  langItem.watch((lang) => {
    for (const [id, key] of Object.entries(MENU_TITLES))
      browser.contextMenus.update(id, { title: dict[lang][key] });
  });
  // the content script owns selection/page saves: it has the live Selection and DOM
  const saveClipToTab = (tabId: number, type: 'saveClip' | 'saveClipPage' = 'saveClip') =>
    browser.tabs.sendMessage(tabId, { type }).catch(() => {
      /* no content script on this page (chrome://, store) */
    });
  browser.contextMenus.onClicked.addListener((info, tab) => {
    if (!tab?.id) return;
    if (info.menuItemId === 'save-clip') return saveClipToTab(tab.id);
    if (info.menuItemId === 'save-clip-page') return saveClipToTab(tab.id, 'saveClipPage');
    // image clip: no Selection needed — background (sole writer) saves directly
    // altText 在 Chrome 的 OnClickData 上有、WXT 的 Firefox 类型未声明
    const altText = (info as { altText?: string }).altText;
    if (info.menuItemId === 'save-clip-image' && info.srcUrl)
      addClipDirect({
        kind: 'image',
        url: info.srcUrl,
        pageUrl: tab.url ?? info.srcUrl,
        title: tab.title ?? '',
        text: altText || info.srcUrl,
        imageSrc: info.srcUrl,
      }).then(() => fanOutClipsChanged()).catch(() => {
        /* write failed; menu click has no surface to report on */
      });
  });

  // 剪藏快捷键:对活动页复用 content script 的保存路径(选区→fragment→storage)
  browser.commands.onCommand.addListener((command) => {
    if (command !== 'save_clip') return;
    browser.tabs.query({ active: true, currentWindow: true })
      .then(([tab]) => {
        if (tab?.id) saveClipToTab(tab.id);
      })
      .catch(() => {
        /* no active tab */
      });
  });

  // clips live in the extension origin's IndexedDB; background is the sole writer.
  // Content scripts (page origin, per-site isolated IDB) proxy reads/writes here.
  // return true keeps the message channel open for the async sendResponse; every
  // branch resolves {ok:true,data} or {ok:false,error} so the sender never hangs.
  browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    const ok = (data: unknown) => sendResponse({ ok: true, data });
    const fail = (e: unknown) => sendResponse({ ok: false, error: String((e as Error)?.message ?? e) });
    if (msg?.type === 'clipsGet') {
      getClipsDirect().then(ok, fail);
      return true;
    }
    // 只回本页摘录:content 端每次 clipsChanged 刷新不再搬全量表过消息通道;
    // fullText 一并剥离——重放高亮永远不需要整页正文
    if (msg?.type === 'clipsGetForPage') {
      getClipsDirect()
        .then((clips) => ok(clips
          .filter((c) => normalizeUrl(c.pageUrl) === msg.page)
          .map(({ fullText: _omit, ...rest }) => rest)), fail);
      return true;
    }
    if (msg?.type === 'clipAdd') {
      addClipDirect(msg.clip as Omit<Clip, 'id' | 'createdAt'>).then((clip) => {
        fanOutClipsChanged();
        ok(clip);
      }, fail);
      return true;
    }
    if (msg?.type === 'clipDel') {
      removeClipDirect(msg.id as string).then(() => {
        fanOutClipsChanged();
        ok(undefined);
      }, fail);
      return true;
    }
    if (msg?.type === 'clipUpdate') {
      updateClipDirect(msg.id as string, msg.patch).then(() => {
        fanOutClipsChanged();
        ok(undefined);
      }, fail);
      return true;
    }
    if (msg?.type === 'classifyClips') {
      // classify (LLM generation + N IDB writes) easily exceeds the 30s worker cap
      const ping = keepalive();
      handleClassify().then(ok, fail).finally(() => clearInterval(ping));
      return true;
    }
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
      // a screenshot turn (tool call + thinking) can stream nothing for that long
      const ping = keepalive();
      handleChat(msg.text, msg.page, !!msg.screenshot, abort.signal, send)
        .catch((err) => {
          console.error('[pixel-agent]', err); // port may be gone; keep a trace in the SW console
          if (!abort.signal.aborted)
            send({ type: 'error', code: err?.code, message: String(err?.message ?? err) });
        })
        .finally(() => clearInterval(ping));
    });
  });
});
