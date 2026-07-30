import { patItem, agentIdItem, envIdItem, sessionIdItem } from '@/lib/settings';

// matches host_permissions in wxt.config.ts
const GATEWAY = 'https://api.qoder.com/api/v1/cloud';

type ChatOut =
  | { type: 'delta'; text: string }
  | { type: 'done' }
  | { type: 'error'; code?: 'unconfigured'; message?: string };

async function api(base: string, pat: string, path: string, init?: RequestInit) {
  const res = await fetch(base + path, {
    ...init,
    headers: {
      Authorization: `Bearer ${pat}`,
      'Content-Type': 'application/json',
      ...init?.headers,
    },
  });
  return res;
}

async function createSession(base: string, pat: string, agentId: string, envId: string) {
  const res = await api(base, pat, '/sessions', {
    method: 'POST',
    body: JSON.stringify({ agent: agentId, environment_id: envId, title: 'Pixel Agent' }),
  });
  if (!res.ok) throw new Error(`create session: HTTP ${res.status}`);
  const session = await res.json();
  await sessionIdItem.setValue(session.id);
  return session.id as string;
}

type PageContext = { url: string; title: string; text: string };

function postUserMessage(base: string, pat: string, sessionId: string, text: string, page?: PageContext) {
  // context is inlined into the user message: agents with browser tools ignore
  // side-channel context and open their own (blank) cloud browser instead
  const body = page
    ? `${text}\n\n---\n[Page context] The page below is already open in the user's LOCAL browser. Answer from this content. Do NOT use your own browser tools — your cloud browser cannot see the user's page.\nURL: ${page.url}\nTitle: ${page.title}\n\n${page.text}`
    : text;
  return api(base, pat, `/sessions/${sessionId}/events`, {
    method: 'POST',
    body: JSON.stringify({
      events: [{ type: 'user.message', content: [{ type: 'text', text: body }] }],
    }),
  });
}

/** Read the SSE stream and forward agent.message deltas until the turn ends. */
async function streamReply(
  base: string,
  pat: string,
  sessionId: string,
  signal: AbortSignal,
  send: (msg: ChatOut) => void,
  isPosted: () => boolean,
) {
  const res = await fetch(
    `${base}/sessions/${sessionId}/events/stream?event_deltas[]=agent.message`,
    { headers: { Authorization: `Bearer ${pat}`, Accept: 'text/event-stream' }, signal },
  );
  if (!res.ok || !res.body) throw new Error(`stream: HTTP ${res.status}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let sep;
    while ((sep = buffer.indexOf('\n\n')) !== -1) {
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      const dataLine = frame.split('\n').find((l) => l.startsWith('data:'));
      if (!dataLine) continue; // heartbeat comment or empty frame
      let payload;
      try {
        payload = JSON.parse(dataLine.slice(5));
      } catch {
        continue;
      }
      if (payload.type === 'event_delta' && payload.delta?.content?.text) {
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
  signal: AbortSignal,
  send: (msg: ChatOut) => void,
) {
  const [pat, agentId, envId] = await Promise.all([
    patItem.getValue(),
    agentIdItem.getValue(),
    envIdItem.getValue(),
  ]);
  if (!pat || !agentId || !envId) {
    send({ type: 'error', code: 'unconfigured' });
    return;
  }
  const base = GATEWAY;

  let sessionId = await sessionIdItem.getValue();

  // one turn = open stream first (no missed events), then post; false = session gone
  const tryTurn = async (sid: string) => {
    let posted = false;
    const streaming = streamReply(base, pat, sid, signal, send, () => posted);
    streaming.catch(() => {}); // dead-session stream 404s and self-terminates
    const res = await postUserMessage(base, pat, sid, text, page);
    if (res.status === 404) return false;
    if (res.status === 409) throw new Error('previous turn still running');
    if (!res.ok) throw new Error(`send message: HTTP ${res.status}`);
    posted = true;
    await streaming;
    return true;
  };

  if (!sessionId || !(await tryTurn(sessionId))) {
    // no cached session or it expired: create a fresh one and retry once
    sessionId = await createSession(base, pat, agentId, envId);
    if (!(await tryTurn(sessionId))) throw new Error('session not found after create');
  }
}

export default defineBackground(() => {
  browser.runtime.onConnect.addListener((port) => {
    if (port.name !== 'chat') return;
    const abort = new AbortController();
    port.onDisconnect.addListener(() => abort.abort());
    port.onMessage.addListener((msg: { text: string; page?: PageContext }) => {
      const send = (out: ChatOut) => {
        try {
          port.postMessage(out);
        } catch {
          /* port closed */
        }
      };
      handleChat(msg.text, msg.page, abort.signal, send).catch((err) => {
        if (!abort.signal.aborted) send({ type: 'error', message: String(err?.message ?? err) });
      });
    });
  });
});
