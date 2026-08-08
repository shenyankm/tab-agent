// Gateway communication layer: HTTP/SSE calls to the cloud agent gateway plus
// the handleChat turn orchestrator. Pure move out of entrypoints/background.ts —
// handleChat/keepalive are exported for the background entrypoint (port handler),
// ChatOut/PageContext for its payload typing; api/createSession/uploadFile/
// postUserMessage/streamReply stay module-private.
import { GATEWAY, patItem, agentIdItem, envIdItem } from '@/lib/settings';
import { parseSSE } from '@/lib/sse';
import { today } from '@/lib/usage'; // 会话缓存按日轮换

// 每日会话的 storage 读缓存(SW 存活期内有效):handleChat 每次提问不再读盘
let sessionCache: { id: string; day: string } | null = null;
type EventCursor = { sessionId: string; eventId: string };
let eventCursor: EventCursor | null = null;
const EVENT_CURSOR_KEY = 'local:eventCursor.v1' as const;

// 凭证同样走 SW 存活期内存缓存:每回合 3 次 storage 读降为首次一次;
// 设置页改完凭据,watch 立刻失效缓存,下一条消息读到新值
let credsCache: { pat: string; agentId: string; envId: string } | null = null;
const invalidateCreds = () => { credsCache = null; };
patItem.watch(invalidateCreds);
agentIdItem.watch(invalidateCreds);
envIdItem.watch(invalidateCreds);

/** Test-only: clear the in-memory session cache between test cases. */
export function resetSessionCacheForTests() {
  sessionCache = null;
  eventCursor = null;
  credsCache = null;
}

// MV3 kills the worker after 30s without extension API activity; ping to stay alive
// while a turn streams nothing for that long
export const keepalive = () => setInterval(() => void browser.runtime.getPlatformInfo().catch(() => {}), 20_000);

export type ChatOut =
  | { type: 'delta'; text: string }
  | { type: 'done' }
  | { type: 'error'; code?: 'unconfigured' | 'auth'; message?: string };

// Every non-streaming call gets a 30s hang guard: a dead gateway must not keep
// handleChat unsettled forever — that would leak the keepalive interval and pin
// the worker alive permanently. Streams opt out (timeout: false) and rely on
// their own 90s read watchdog instead.
async function api(pat: string, path: string, init?: RequestInit & { timeout?: number | false }) {
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
  signal?: AbortSignal,
) {
  const res = await api(pat, '/sessions', {
    method: 'POST',
    signal,
    body: JSON.stringify({
      agent: { id: agentId, type: 'agent' },
      environment_id: envId,
      // 标题带日期：云端会话列表里能辨认每天轮换的新会话
      title: `Tab Agent ${today()}`,
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

/** Read the SSE stream and forward agent.message text until the turn ends. */
async function streamReply(
  pat: string,
  sessionId: string,
  signal: AbortSignal,
  send: (msg: ChatOut) => void,
  /** true once our user.message POST has succeeded — gates the turn's events */
  isPosted: () => boolean,
  lastEventId?: string,
  onEventId?: (id: string) => void,
  onIdle?: () => void,
) {
  // delta subscription — the brackets MUST be percent-encoded: literal `[]` in
  // the query kills the stream silently (no frames at all, turn hangs forever);
  // %5B%5D streams event_start/event_delta per docs (live capture 2026-08-05).
  // The buffered agent.message copy (same id) follows the deltas — deduped below.
  const res = await api(pat, `/sessions/${sessionId}/events/stream?event_deltas%5B%5D=agent.message`, {
    headers: {
      Accept: 'text/event-stream',
      ...(lastEventId ? { 'Last-Event-ID': lastEventId } : {}),
    },
    signal,
    timeout: false, // long-lived by design; the 90s read watchdog below guards it
  });
  if (!res.ok || !res.body) {
    console.warn('[tab-agent] stream HTTP', res.status);
    throw new Error(`stream: HTTP ${res.status}`);
  }

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
  // false is the old turn's replay (in-flight messages, stale idle) and must be
  // dropped — the LAST user.message event is this turn's boundary (the event
  // log is ordered: replay always precedes our message)
  let userMsgId = '';
  let sentAny = false; // \n\n separator between agent messages, across reads
  let lastDeltaId = ''; // message boundary detection inside the delta stream
  const seenDeltaIds = new Set<string>(); // delta'd message ids — their buffered copy must not double-count

  try {
    while (true) {
      const { done, value } = await Promise.race([reader.read(), timeout]);
      if (done) break;
      armTimeout(); // reset for next read
      const frames = parseSSE(buffer + decoder.decode(value, { stream: true }));
      buffer = frames.rest;

      // one read() often carries several frames; coalesce so the UI re-renders once per read
      const textParts: string[] = [];
      for (const data of frames.data) {
        let payload: Record<string, any>;
        try {
          const parsed: unknown = JSON.parse(data);
          if (!parsed || typeof parsed !== 'object') continue;
          payload = parsed as Record<string, any>;
        } catch {
          continue;
        }
        const eventId = payload.id ?? payload.event_id ?? payload.event?.id;
        if (typeof eventId === 'string') onEventId?.(eventId);
        // buffered events only: data is the event itself {id, type, content?}.
        // user.message is the turn boundary, last one wins (the log is ordered:
        // replay precedes our message). No isPosted condition on it: the broadcast
        // races the POST response and a dropped boundary is never replayed → the
        // turn goes silent
        if (payload.type === 'user.message' && payload.id) userMsgId = payload.id;
        // fire onIdle on any session.status_idle (used by tryTurn after cancel)
        if (payload.type === 'session.status_idle') onIdle?.();
        // isPosted gates content/idle instead: replayed old-turn events arrive
        // before our POST returns and are dropped; ours arrive after
        if (payload.type === 'event_delta' && userMsgId && isPosted() && payload.delta?.content?.text) {
          if (payload.event_id) {
            seenDeltaIds.add(payload.event_id);
            if (payload.event_id !== lastDeltaId) {
              lastDeltaId = payload.event_id;
              if (textParts.length || sentAny) textParts.push('\n\n'); // new message in the same turn
            }
          }
          textParts.push(payload.delta.content.text);
        } else if (payload.type === 'agent.message' && userMsgId && isPosted() && Array.isArray(payload.content) && !seenDeltaIds.has(payload.id)) {
          // buffered authoritative copy — fallback when deltas never streamed
          const msg = payload.content
            .map((b: any) => (b?.type === 'text' && typeof b.text === 'string' ? b.text : ''))
            .join('');
          if (msg) {
            if (textParts.length || sentAny) textParts.push('\n\n');
            textParts.push(msg);
          }
        } else if (payload.type === 'session.status_idle' && userMsgId && isPosted()) {
          if (textParts.length) send({ type: 'delta', text: textParts.join('') });
          send({ type: 'done' });
          return;
        }
      }
      if (textParts.length) {
        send({ type: 'delta', text: textParts.join('') });
        sentAny = true;
      }
    }
    // stream closed without session.status_idle (server close, network drop, or the
    // idle event was filtered by the isPosted gate during replay) — complete the turn
    // so the content script doesn't hang in "thinking" forever
    send({ type: 'done' });
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
    await reader.cancel().catch(() => {});
  }
}

export async function handleChat(
  text: string,
  page: PageContext | undefined,
  screenshot: boolean,
  signal: AbortSignal,
  send: (msg: ChatOut) => void,
  /** Port sender identity: only the window to screenshot (session is shared). */
  sender?: { windowId?: number },
  /** Fires once per completed turn with the reply's finish day (YYYY-MM-DD). */
  onTurnDone?: (day: string) => void,
): Promise<void> {
  if (!credsCache) {
    const [pat, agentId, envId] = await Promise.all([
      patItem.getValue(),
      agentIdItem.getValue(),
      envIdItem.getValue(),
    ]);
    credsCache = { pat, agentId, envId };
  }
  const { pat, agentId, envId } = credsCache;
  if (!pat || !agentId || !envId) {
    send({ type: 'error', code: 'unconfigured' });
    return;
  }

  // 每日共享会话：所有 tab 同一天共用同一云端会话，跨天重建。
  // ponytail: 共享会话下 tab B 的 409-cancel 会截断 tab A 进行中的回合；
  // 单用户轻聊场景可接受，并发不丢需跨 tab 回合排队（另一量级复杂度）。
  const sessionKey = 'local:sessionId.v4' as const;
  // 会话归属以最后一条回复的完成日为准：跨午夜的回合（23:56 发、00:12 答完）
  // 仍属旧会话，done 时把 day 刷成完成日，下一条消息才触发跨天重建。
  // SW 存活期内的内存副本:连续提问不重复读 storage;SW 重启后首次提问回填。
  let cached = sessionCache;
  if (!cached) {
    const [storedSession, storedCursor] = await Promise.all([
      storage.getItem<{ id: string; day: string }>(sessionKey),
      storage.getItem<EventCursor>(EVENT_CURSOR_KEY),
    ]);
    cached = storedSession ?? null;
    sessionCache = cached;
    eventCursor = storedCursor ?? null;
  }
  let sessionId = cached?.day === today() ? cached.id : '';

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
    // dataURL → Blob 直解:fetch(dataUrl) 会对 base64 做一次完整解码+重编码,
    // 全屏 JPEG 的 base64 可达 MB 级,主线程上直接 atob 快得多
    const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
    const blob = new Blob(
      [Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))],
      { type: 'image/jpeg' },
    );
    mount = {
      fileId: await uploadFile(pat, 'screenshot.jpg', blob, signal),
      path: '/data/input/screenshot.jpg',
      note: "[Screenshot] A screenshot of the page currently visible in the user's browser is mounted at /data/input/screenshot.jpg in your workspace. View it when relevant.",
    };
  }

  // one turn = open stream first (no missed events), then post; false = session gone
  const tryTurn = async (sid: string) => {
    let posted = false;
    let turnEventId = eventCursor?.sessionId === sid ? eventCursor.eventId : undefined;
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
      const streaming = streamReply(
        pat,
        sid,
        turnSignal,
        send,
        () => posted,
        turnEventId,
        (id) => { turnEventId = id; },
        () => idleResolve(),
      );
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
      if (turnEventId) {
        eventCursor = { sessionId: sid, eventId: turnEventId };
        void storage.setItem(EVENT_CURSOR_KEY, eventCursor).catch(() => {});
      }
      onTurnDone?.(today()); // 回复完成日落盘：会话归属跟着最后回复走
      if (sessionCache) sessionCache = { ...sessionCache, day: today() }; // 内存副本同步
      return true;
    } finally {
      turn.abort(); // success: streaming already resolved, no-op; failure: reclaim the SSE fetch
    }
  };

  if (!sessionId || !(await tryTurn(sessionId))) {
    // no cached session or it expired: create a fresh one and retry once
    sessionId = await createSession(pat, agentId, envId, signal);
    const fresh = { id: sessionId, day: today() };
    sessionCache = fresh;
    await storage.setItem(sessionKey, fresh);
    if (!(await tryTurn(sessionId))) throw new Error('session not found after create');
  }
}


