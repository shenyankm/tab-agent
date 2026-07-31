import { GATEWAY, patItem, agentIdItem, envIdItem, vaultIdItem, sessionIdItem } from '@/lib/settings';
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
        send({ type: 'delta', text: payload.delta.content.text });
      } else if (payload.type === 'session.status_idle' && isPosted()) {
        // ponytail: isPosted filters idle events replayed before our POST returns; if long
        // histories ever race past it, key off our user.message event id instead
        send({ type: 'done' });
        return;
      }
    }
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
      streaming.catch(() => {}); // dead-session 404s and failure-path aborts self-terminate
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

export default defineBackground(() => {
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
      handleChat(msg.text, msg.page, !!msg.screenshot, abort.signal, send).catch((err) => {
        if (!abort.signal.aborted)
          send({ type: 'error', code: err?.code, message: String(err?.message ?? err) });
      });
    });
  });
});
