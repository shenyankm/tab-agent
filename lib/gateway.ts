// Gateway communication layer: HTTP/SSE calls to the cloud agent gateway plus
// the handleChat turn orchestrator. Pure move out of entrypoints/background.ts —
// handleChat/keepalive are exported for the background entrypoint (port handler),
// ChatOut/PageContext for its payload typing; api/createSession/uploadFile/
// postUserMessage/streamReply stay module-private.
import { GATEWAY, patItem, agentIdItem, envIdItem, vaultIdItem, reportSentItem } from '@/lib/settings';
import { parseSSE } from '@/lib/sse';
import { today } from '@/lib/usage'; // 会话缓存按日轮换

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
  vaultId: string,
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
      ...(vaultId ? { vault_ids: [vaultId] } : {}),
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
  onIdle?: () => void,
) {
  // delta subscription — the brackets MUST be percent-encoded: literal `[]` in
  // the query kills the stream silently (no frames at all, turn hangs forever);
  // %5B%5D streams event_start/event_delta per docs (live capture 2026-08-05).
  // The buffered agent.message copy (same id) follows the deltas — deduped below.
  const res = await api(pat, `/sessions/${sessionId}/events/stream?event_deltas%5B%5D=agent.message`, {
    headers: { Accept: 'text/event-stream' },
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
      let text = '';
      for (const data of frames.data) {
        let payload;
        try {
          payload = JSON.parse(data);
        } catch {
          continue;
        }
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
              if (text || sentAny) text += '\n\n'; // new message in the same turn
            }
          }
          text += payload.delta.content.text;
        } else if (payload.type === 'agent.message' && userMsgId && isPosted() && Array.isArray(payload.content) && !seenDeltaIds.has(payload.id)) {
          // buffered authoritative copy — fallback when deltas never streamed
          const msg = payload.content
            .map((b: any) => (b?.type === 'text' && typeof b.text === 'string' ? b.text : ''))
            .join('');
          if (msg) text += (text || sentAny ? '\n\n' : '') + msg;
        } else if (payload.type === 'session.status_idle' && userMsgId && isPosted()) {
          if (text) send({ type: 'delta', text });
          send({ type: 'done' });
          return;
        }
      }
      if (text) {
        send({ type: 'delta', text });
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

  // 每日共享会话：所有 tab 同一天共用同一云端会话，跨天重建。
  // ponytail: 共享会话下 tab B 的 409-cancel 会截断 tab A 进行中的回合；
  // 单用户轻聊场景可接受，并发不丢需跨 tab 回合排队（另一量级复杂度）。
  const sessionKey = 'local:sessionId.v4' as const;
  // 会话归属以最后一条回复的完成日为准：跨午夜的回合（23:56 发、00:12 答完）
  // 仍属旧会话，done 时把 day 刷成完成日，下一条消息才触发跨天重建。
  const cached = await storage.getItem<{ id: string; day: string }>(sessionKey);
  let sessionId = cached?.day === today() ? cached.id : '';

  // 跨天且旧会话存在：先让旧会话自总结（上下文即当日完整对话记录，
  // Agent 侧 notion MCP 写日报），fire-and-forget，失败仅留痕不阻断新会话。
  if (cached && cached.day !== today() && (await reportSentItem.getValue()) !== cached.day) {
    await reportSentItem.setValue(cached.day); // 先落标记：失败不重复发，宁缺勿滥
    void summarizeSession(pat, cached.id, cached.day)
      .catch((e) => console.error('[tab-agent] daily report:', e));
  }

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
      onTurnDone?.(today()); // 回复完成日落盘：会话归属跟着最后回复走
      return true;
    } finally {
      turn.abort(); // success: streaming already resolved, no-op; failure: reclaim the SSE fetch
    }
  };

  if (!sessionId || !(await tryTurn(sessionId))) {
    // no cached session or it expired: create a fresh one and retry once
    sessionId = await createSession(pat, agentId, envId, vaultId, signal);
    await storage.setItem(sessionKey, { id: sessionId, day: today() });
    if (!(await tryTurn(sessionId))) throw new Error('session not found after create');
  }
}

/** 跨天时让旧会话自总结：只发消息不等回复（总结写 Notion 由云端 Agent 完成）。
 *  复用 409 自愈：旧会话若有回合在跑，cancel 后等 idle 再发，最多 2 次。 */
async function summarizeSession(pat: string, sessionId: string, day: string): Promise<void> {
  const text = `请总结本次会话中 ${day} 的全部对话，撰写一份简明的中文日报，并用 notion MCP 工具在你被配置写入的 Notion 数据库中新建页面，标题为"Tab Agent 日报 ${day}"。`;
  let res = await postUserMessage(pat, sessionId, text);
  for (let i = 0; i < 2 && res.status === 409; i++) {
    await api(pat, `/sessions/${sessionId}/cancel`, { method: 'POST' });
    await new Promise((r) => setTimeout(r, 2000)); // cancel→idle 是异步的，给云端一点收敛时间
    res = await postUserMessage(pat, sessionId, text);
  }
  if (!res.ok) throw new Error(`daily report: HTTP ${res.status}`);
}
