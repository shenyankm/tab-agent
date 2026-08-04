// Gateway communication layer: HTTP/SSE calls to the cloud agent gateway plus
// the handleChat turn orchestrator. Pure move out of entrypoints/background.ts —
// handleChat/keepalive are exported for the entrypoint (port + classify message
// handlers), ChatOut/PageContext for its payload typing; the rest of the API
// surface (api, createSession, uploadFile, postUserMessage, streamReply) stays
// module-private.
import { GATEWAY, patItem, agentIdItem, envIdItem, vaultIdItem, memorySyncItem, memoryStoreIdItem } from '@/lib/settings';
import { MEMORY_INSTRUCTIONS } from '@/lib/memory';
import { parseSSE } from '@/lib/sse';

// MV3 kills the worker after 30s without extension API activity; ping to stay alive
// while a turn or batch classify streams nothing for that long
export const keepalive = () => setInterval(() => void browser.runtime.getPlatformInfo().catch(() => {}), 20_000);

export type ChatOut =
  | { type: 'delta'; text: string }
  | { type: 'done' }
  | { type: 'error'; code?: 'unconfigured' | 'auth'; message?: string };

// Every non-streaming call gets a 30s hang guard: a dead gateway must not keep
// handleChat unsettled forever — that would leak the keepalive interval and pin
// the worker alive permanently. Streams opt out (timeout: false) and rely on
// their own 90s read watchdog instead.
export async function api(pat: string, path: string, init?: RequestInit & { timeout?: number | false }) {
  const { timeout, ...rest } = init ?? {};
  const signals = [rest.signal, timeout === false ? undefined : AbortSignal.timeout(timeout ?? 30_000)]
    .filter((s): s is AbortSignal => !!s);
  const res = await fetch(GATEWAY + path, {
    ...rest,
    signal: signals.length > 1 ? AbortSignal.any(signals) : signals[0],
    headers: {
      Authorization: `Bearer ${pat}`,
      // multipart body: let fetch set the boundary itself
      ...(rest.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
      ...rest.headers,
    },
  });
  // single choke point: every endpoint routes through here
  if (res.status === 401 || res.status === 403)
    throw Object.assign(new Error(`HTTP ${res.status}`), { code: 'auth' as const });
  return res;
}

async function createSession(
  pat: string,
  agentId: string,
  envId: string,
  vaultId: string,
  /** 云端记忆 Store id,非空时作为 resources 挂载(仅用户聊天会话传值) */
  memoryStoreId: string,
  signal?: AbortSignal,
) {
  const res = await api(pat, '/sessions', {
    method: 'POST',
    signal,
    body: JSON.stringify({
      agent: { id: agentId, type: 'agent' },
      environment_id: envId,
      title: 'Pixel Agent',
      ...(vaultId ? { vault_ids: [vaultId] } : {}),
      ...(memoryStoreId ? {
        resources: [{
          type: 'memory_store',
          memory_store_id: memoryStoreId,
          access: 'read_write',
          instructions: MEMORY_INSTRUCTIONS,
        }],
      } : {}),
    }),
  });
  if (!res.ok) throw new Error(`create session: HTTP ${res.status}`);
  return (await res.json()).id as string;
}

export type PageContext = { url: string; title: string; text: string };
type Mount = { fileId: string; path: string; note: string };

async function uploadFile(pat: string, name: string, blob: Blob, signal?: AbortSignal) {
  const form = new FormData();
  form.append('file', blob, name);
  const res = await api(pat, '/files', { method: 'POST', body: form, signal });
  if (!res.ok) throw new Error(`upload file: HTTP ${res.status}`);
  return (await res.json()).id as string;
}

function postUserMessage(
  pat: string,
  sessionId: string,
  text: string,
  page?: PageContext,
  note?: string,
  signal?: AbortSignal,
) {
  // context is inlined into the user message: agents with browser tools ignore
  // side-channel context and open their own (blank) cloud browser instead
  let body = page
    ? `${text}\n\n---\n[Page context] The page below is already open in the user's LOCAL browser. Answer from this content. Do NOT use your own browser tools — your cloud browser cannot see the user's page.\nURL: ${page.url}\nTitle: ${page.title}\n\n${page.text}`
    : text;
  if (note) body += `\n\n${note}`;
  return api(pat, `/sessions/${sessionId}/events`, {
    method: 'POST',
    signal,
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
  /** true once our user.message POST has succeeded — gates the turn's event_start */
  isPosted: () => boolean,
  onIdle?: () => void,
) {
  const res = await api(pat, `/sessions/${sessionId}/events/stream?event_deltas[]=agent.message`, {
    headers: { Accept: 'text/event-stream' },
    signal,
    timeout: false, // long-lived by design; the 90s read watchdog below guards it
  });
  if (!res.ok || !res.body) throw new Error(`stream: HTTP ${res.status}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  // 90s read timeout reset on every read — heartbeats (every ~15s) keep it alive;
  // 90s of silence means the connection is dead (MV3 worker suspension, proxy idle-kill).
  let timer: ReturnType<typeof setTimeout> = 0 as any;
  let rejectTimeout: (e: Error) => void;
  const timeout = new Promise<never>((_, reject) => { rejectTimeout = reject; });
  const armTimeout = () => { clearTimeout(timer); timer = setTimeout(() => rejectTimeout(new Error('stream read timeout')), 90_000); };
  const onAbort = () => rejectTimeout(signal.reason ?? new Error('aborted'));
  signal.addEventListener('abort', onAbort, { once: true });
  armTimeout();

  // stream opens BEFORE our POST: everything that arrives while isPosted() is
  // false is the old turn's replay (in-flight deltas, stale idle) and must be
  // dropped — the first user.message event_start after POST is our turn's, and
  // only events after it belong to this reply
  let userMsgId = '';

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
        // only the user.message event_start arriving after our POST is this turn's;
        // the stream replays the previous turn's events (incl. its event_start) before
        // the POST returns — without this gate, replay leaks into this reply
        if (payload.type === 'event_start' && payload.event?.id && payload.event.type === 'user.message' && isPosted()) {
          userMsgId = payload.event.id;
        }
        // fire onIdle on any session.status_idle (used by tryTurn after cancel)
        if (payload.type === 'session.status_idle') onIdle?.();
        // userMsgId gates deltas: only process events from after our user.message,
        // preventing replay of the old turn's in-flight deltas after our POST returns
        if (payload.type === 'event_delta' && userMsgId && payload.delta?.content?.text) {
          text += payload.delta.content.text;
        } else if (payload.type === 'session.status_idle' && userMsgId) {
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

export async function handleChat(
  text: string,
  page: PageContext | undefined,
  screenshot: boolean,
  signal: AbortSignal,
  send: (msg: ChatOut) => void,
  /** Pass a session id to reuse it; pass '' to force-create a dedicated one (falsy → new session). */
  ownSession?: string,
  /** Port sender identity: per-tab session cache + the window to screenshot. */
  sender?: { tabId?: number; windowId?: number },
  // resolves the session id used (a fresh one when created) — classify feeds it
  // back into the next batch so one run reuses a single dedicated session
): Promise<string | undefined> {
  const [pat, agentId, envId, vaultId, memorySync, memoryStoreId] = await Promise.all([
    patItem.getValue(),
    agentIdItem.getValue(),
    envIdItem.getValue(),
    vaultIdItem.getValue(),
    memorySyncItem.getValue(),
    memoryStoreIdItem.getValue(),
  ]);
  if (!pat || !agentId || !envId) {
    send({ type: 'error', code: 'unconfigured' });
    return;
  }

  // 分类/专用会话(ownSession 非 undefined)不挂载 Store:严格 JSON prompt 不受记忆干扰。
  // Store 在首次同步时才懒创建,开启同步但尚未同步过的聊天不挂载(同步是显式用户动作)
  const memStoreId = ownSession === undefined && memorySync ? memoryStoreId : '';

  // per-tab cloud sessions: with one global session, tab B's 409-cancel would
  // silently truncate tab A's running turn. Keys of closed tabs are cleaned up
  // in background.ts onRemoved.
  const sessionKey: `local:${string}` | null =
    sender?.tabId != null ? `local:sessionId.v3.tab.${sender.tabId}` : null;
  let sessionId = ownSession ?? (sessionKey
    ? (await storage.getItem<string>(sessionKey)) ?? ''
    : '');

  // upload happens once; mounting is per-session, so it happens inside tryTurn
  let mount: Mount | null = null;
  if (screenshot) {
    // captured here, not in the content script: tabs.captureVisibleTab only exists
    // in extension contexts and needs the <all_urls> host permission; pass the
    // sender's window — omitting it captures the focused window, which may differ
    const opts = { format: 'jpeg', quality: 80 } as const;
    const dataUrl = sender?.windowId != null
      ? await browser.tabs.captureVisibleTab(sender.windowId, opts)
      : await browser.tabs.captureVisibleTab(opts);
    mount = {
      fileId: await uploadFile(pat, 'screenshot.jpg', await (await fetch(dataUrl)).blob(), signal),
      path: '/data/input/screenshot.jpg',
      note: "[Screenshot] A screenshot of the page currently visible in the user's browser is mounted at /data/input/screenshot.jpg in your workspace. View it when relevant.",
    };
  }

  // one turn = open stream first (no missed events), then post; false = session gone
  const tryTurn = async (sid: string) => {
    let posted = false;
    const turn = new AbortController();
    const turnSignal = AbortSignal.any([signal, turn.signal]); // Chrome 116+
    try {
      if (mount) {
        const mounted = await api(pat, `/sessions/${sid}/resources`, {
          method: 'POST',
          signal: turnSignal,
          body: JSON.stringify({ type: 'file', file_id: mount.fileId, mount_path: mount.path }),
        });
        if (mounted.status === 404) return false; // dead session: recreate and re-mount
        if (!mounted.ok) throw new Error(`mount file: HTTP ${mounted.status}`);
      }
      let idleResolve!: () => void;
      let onIdle = new Promise<void>((resolve) => { idleResolve = resolve; });
      const streaming = streamReply(pat, sid, turnSignal, send, () => posted, () => idleResolve());
      // pre-await rejections (dead-session 404, failure-path abort) must not fire
      // unhandledrejection; `await streaming` below still surfaces the error
      streaming.catch(() => {});
      let res = await postUserMessage(pat, sid, text, page, mount?.note, turnSignal);
      if (res.status === 409) {
        // previous turn still running (e.g. re-submit): cancel it, then wait for
        // its session.status_idle before retrying — cancel→idle is async
        for (let i = 0; i < 2 && res.status === 409; i++) {
          await api(pat, `/sessions/${sid}/cancel`, { method: 'POST', signal: turnSignal });
          await Promise.race([
            onIdle,
            new Promise<void>((r) => setTimeout(r, 5000)), // 5s safety net
          ]);
          onIdle = new Promise<void>((resolve) => { idleResolve = resolve; });
          res = await postUserMessage(pat, sid, text, page, mount?.note, turnSignal);
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
    sessionId = await createSession(pat, agentId, envId, vaultId, memStoreId, signal);
    if (ownSession === undefined && sessionKey) await storage.setItem(sessionKey, sessionId);
    if (!(await tryTurn(sessionId))) throw new Error('session not found after create');
  }
  return sessionId;
}
