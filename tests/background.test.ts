import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- hoisted mocks (available inside vi.mock factories) ---
const {
  mockPat, mockAgentId, mockEnvId, mockVaultId, mockSessionGet, mockSessionSet,
  connectListenerRef, messageListenerRef, commandListenerRef, menuListenerRef,
  mockGetClips, mockGetClipsForPage, mockAddClip, mockRemoveClip, mockUpdateClip, mockUpdateClips,
  mockTabsQuery, mockTabsSend,
} = vi.hoisted(() => ({
  mockPat: vi.fn().mockResolvedValue('test-pat'),
  mockAgentId: vi.fn().mockResolvedValue('agent-1'),
  mockEnvId: vi.fn().mockResolvedValue('env-1'),
  mockVaultId: vi.fn().mockResolvedValue(''),
  mockSessionGet: vi.fn().mockResolvedValue(''),
  mockSessionSet: vi.fn().mockResolvedValue(undefined),
  connectListenerRef: { current: null as ((...args: any[]) => void) | null },
  messageListenerRef: { current: null as ((...args: any[]) => unknown) | null },
  commandListenerRef: { current: null as ((command: string) => void) | null },
  menuListenerRef: { current: null as ((info: any, tab: any) => void) | null },
  mockGetClips: vi.fn().mockResolvedValue([]),
  mockGetClipsForPage: vi.fn().mockResolvedValue([]),
  mockAddClip: vi.fn(),
  mockRemoveClip: vi.fn().mockResolvedValue(undefined),
  mockUpdateClip: vi.fn().mockResolvedValue(undefined),
  mockUpdateClips: vi.fn().mockResolvedValue(undefined),
  mockTabsQuery: vi.fn().mockResolvedValue([]),
  mockTabsSend: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/settings', () => ({
  GATEWAY: 'https://api.test.com',
  patItem: { getValue: () => mockPat() },
  agentIdItem: { getValue: () => mockAgentId() },
  envIdItem: { getValue: () => mockEnvId() },
  vaultIdItem: { getValue: () => mockVaultId() },
  sessionIdItem: { getValue: () => mockSessionGet(), setValue: (v: string) => mockSessionSet(v) },
}));

vi.mock('@/lib/i18n', () => ({
  dict: { 'zh-CN': { 'clips.menu': '保存选中内容为摘录', 'clips.menu.page': '保存整页为摘录', 'clips.menu.image': '保存图片为摘录' } },
  langItem: { getValue: () => Promise.resolve('zh-CN'), watch: () => () => {} },
}));

vi.mock('wxt/utils/define-background', () => ({
  defineBackground: (cb: () => void) => cb(),
}));

vi.mock('@/lib/clips', () => ({
  getClipsDirect: () => mockGetClips(),
  getClipsForPageDirect: (page: string) => mockGetClipsForPage(page),
  addClipDirect: (clip: unknown) => mockAddClip(clip),
  removeClipDirect: (id: string) => mockRemoveClip(id),
  updateClipDirect: (id: string, patch: unknown) => mockUpdateClip(id, patch),
  updateClipsDirect: (patches: unknown) => mockUpdateClips(patches),
  normalizeUrl: (u: string) => { try { const p = new URL(u); p.hash = ''; return p.toString(); } catch { return u; } },
}));

vi.mock('wxt/browser', () => ({
  browser: {
    runtime: {
      onConnect: {
        addListener: (fn: (...args: any[]) => void) => { connectListenerRef.current = fn; },
      },
      onInstalled: { addListener: vi.fn() },
      onMessage: {
        addListener: (fn: (...args: any[]) => unknown) => { messageListenerRef.current = fn; },
      },
      // fanOutClipsChanged broadcasts to extension pages; no listener in tests
      sendMessage: vi.fn().mockRejectedValue(new Error('no listener')),
    },
    contextMenus: {
      create: vi.fn(),
      update: vi.fn(),
      onClicked: { addListener: (fn: (info: any, tab: any) => void) => { menuListenerRef.current = fn; } },
    },
    commands: {
      onCommand: { addListener: (fn: (command: string) => void) => { commandListenerRef.current = fn; } },
    },
    tabs: {
      query: (info: unknown) => mockTabsQuery(info),
      sendMessage: (tabId: number, msg: unknown) => mockTabsSend(tabId, msg),
    },
  },
}));

// import after mocks — triggers defineBackground callback
await import('@/entrypoints/background');

// --- port pair wiring ---
type Listener = (...args: any[]) => void;

function createPortPair() {
  const incoming: Listener[] = []; // background → test
  const outgoing: Listener[] = []; // test → background
  const disconnectListeners: Listener[] = [];

  const bgPort = {
    name: 'chat',
    onMessage: { addListener: (fn: Listener) => { outgoing.push(fn); } },
    onDisconnect: { addListener: (fn: Listener) => { disconnectListeners.push(fn); } },
    postMessage: (msg: unknown) => incoming.forEach((fn) => fn(msg)),
  };

  const testPort = {
    postMessage: (msg: unknown) => outgoing.forEach((fn) => fn(msg)),
    onMessage: { addListener: (fn: Listener) => { incoming.push(fn); } },
    disconnect: () => disconnectListeners.forEach((fn) => fn()),
  };

  return { bgPort, testPort };
}

function connect() {
  const messages: unknown[] = [];
  const pair = createPortPair();
  pair.testPort.onMessage.addListener((msg) => messages.push(msg));
  connectListenerRef.current?.(pair.bgPort);
  return { port: pair.testPort, messages };
}

async function until(pred: () => boolean, ms = 2000) {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('timeout waiting for condition');
    await new Promise((r) => setTimeout(r, 10));
  }
}

function sseStream(frames: string[]) {
  const text = frames.map((f) => `data: ${f}\n\n`).join('');
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

describe('background handleChat', () => {
  beforeEach(() => {
    mockPat.mockResolvedValue('test-pat');
    mockAgentId.mockResolvedValue('agent-1');
    mockEnvId.mockResolvedValue('env-1');
    mockVaultId.mockResolvedValue('');
    mockSessionGet.mockResolvedValue('');
    mockSessionSet.mockResolvedValue(undefined);
  });

  it('sends unconfigured error when pat is empty', async () => {
    mockPat.mockResolvedValue('');
    const { port, messages } = connect();
    port.postMessage({ text: 'hello' });
    await until(() => messages.length > 0);
    expect(messages[0]).toEqual({ type: 'error', code: 'unconfigured' });
  });

  it('sends auth error on 401 response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 401, ok: false }));
    const { port, messages } = connect();
    port.postMessage({ text: 'hello' });
    await until(() => messages.length > 0);
    expect(messages[0]).toMatchObject({ type: 'error', code: 'auth' });
  });

  it('streams delta and done on happy path', async () => {
    mockSessionGet.mockResolvedValue('sess-1');
    const fetchMock = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
      const url = String(_url);
      if (url.includes('/events/stream')) {
        return Promise.resolve({
          status: 200,
          ok: true,
          body: sseStream([
            JSON.stringify({ type: 'event_delta', delta: { content: { text: 'Hi ' } } }),
            JSON.stringify({ type: 'event_delta', delta: { content: { text: 'there' } } }),
            JSON.stringify({ type: 'session.status_idle' }),
          ]),
        });
      }
      if (url.includes('/events') && init?.method === 'POST') {
        return Promise.resolve({ status: 200, ok: true });
      }
      return Promise.resolve({ status: 200, ok: true, json: () => Promise.resolve({}) });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { port, messages } = connect();
    port.postMessage({ text: 'hello' });
    await until(() => messages.some((m: any) => m.type === 'done'));

    const deltas = messages.filter((m: any) => m.type === 'delta');
    // frames arriving in one network read are coalesced into a single delta
    expect(deltas).toEqual([{ type: 'delta', text: 'Hi there' }]);
    expect(messages.at(-1)).toEqual({ type: 'done' });
  });

  it('recreates session when cached session returns 404', async () => {
    mockSessionGet.mockResolvedValue('dead-session');
    const fetchMock = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
      const url = String(_url);
      if (url.endsWith('/sessions') && init?.method === 'POST') {
        return Promise.resolve({ status: 200, ok: true, json: () => Promise.resolve({ id: 'new-sess' }) });
      }
      if (url.includes('/events/stream')) {
        if (url.includes('dead-session')) return Promise.resolve({ status: 404, ok: false });
        return Promise.resolve({
          status: 200,
          ok: true,
          body: sseStream([JSON.stringify({ type: 'session.status_idle' })]),
        });
      }
      if (url.includes('/events') && init?.method === 'POST') {
        if (url.includes('dead-session')) return Promise.resolve({ status: 404, ok: false });
        return Promise.resolve({ status: 200, ok: true });
      }
      return Promise.resolve({ status: 200, ok: true, json: () => Promise.resolve({}) });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { port, messages } = connect();
    port.postMessage({ text: 'hello' });
    await until(() => messages.some((m: any) => m.type === 'done'));

    expect(mockSessionSet).toHaveBeenCalledWith('new-sess');
    expect(messages.at(-1)).toEqual({ type: 'done' });
  });

  // regression: non-streaming fetches carried no signal — a hung gateway kept
  // handleChat unsettled forever, leaking the keepalive interval and pinning the
  // worker alive. Every fetch must carry a signal that port disconnect aborts.
  it('wires an abort signal into every fetch and aborts on port disconnect', async () => {
    mockSessionGet.mockResolvedValue('');
    const signals: (AbortSignal | undefined)[] = [];
    vi.stubGlobal('fetch', vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
      signals.push(init?.signal ?? undefined);
      // hang until aborted — the only way out must be the signal
      return new Promise((_, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal!.reason ?? new Error('aborted')));
      });
    }));

    const { port, messages } = connect();
    port.postMessage({ text: 'hello' });
    await until(() => signals.length > 0);
    expect(signals[0]).toBeInstanceOf(AbortSignal); // 30s hang guard applies even without a caller signal
    expect(signals[0]!.aborted).toBe(false);

    port.disconnect();
    await until(() => signals[0]!.aborted);
    expect(messages).toEqual([]); // port is gone; nothing to send to, no crash
    vi.unstubAllGlobals();
  });
});

// invoke the registered onMessage listener and capture the async sendResponse
function dispatch(msg: unknown, senderTabId?: number) {
  const respond = vi.fn();
  const ret = messageListenerRef.current?.(
    msg,
    { tab: senderTabId === undefined ? undefined : { id: senderTabId } },
    respond,
  );
  return { respond, keptOpen: ret === true };
}

describe('background clips message handler', () => {
  beforeEach(() => {
    mockGetClips.mockResolvedValue([]);
    mockGetClipsForPage.mockReset();
    mockGetClipsForPage.mockResolvedValue([]);
    mockAddClip.mockReset();
    mockRemoveClip.mockResolvedValue(undefined);
    mockUpdateClip.mockReset();
    mockUpdateClip.mockResolvedValue(undefined);
    mockUpdateClips.mockReset();
    mockUpdateClips.mockResolvedValue(undefined);
  });

  it('clipsGet responds with the clips and keeps the channel open', async () => {
    const clips = [{ id: 'a', text: 'x' }];
    mockGetClips.mockResolvedValue(clips);
    const { respond, keptOpen } = dispatch({ type: 'clipsGet' });
    expect(keptOpen).toBe(true);
    await until(() => respond.mock.calls.length > 0);
    expect(respond).toHaveBeenCalledWith({ ok: true, data: clips });
  });

  it('clipsGetForPage reads through the page index and keeps the channel open', async () => {
    const clips = [{ id: 'a', pageUrl: 'https://e.com/p', text: 'here' }];
    mockGetClipsForPage.mockResolvedValue(clips);
    const { respond, keptOpen } = dispatch({ type: 'clipsGetForPage', page: 'https://e.com/p' });
    expect(keptOpen).toBe(true);
    await until(() => respond.mock.calls.length > 0);
    expect(mockGetClipsForPage).toHaveBeenCalledWith('https://e.com/p');
    expect(respond).toHaveBeenCalledWith({ ok: true, data: clips });
  });

  it('clipAdd writes via addClipDirect, fans out excluding the source tab, responds with the clip', async () => {
    const full = { id: 'n', text: 's', createdAt: 1 };
    mockAddClip.mockResolvedValue(full);
    const { respond, keptOpen } = dispatch({ type: 'clipAdd', clip: { text: 's' } }, 7);
    expect(keptOpen).toBe(true);
    await until(() => respond.mock.calls.length > 0);
    expect(mockAddClip).toHaveBeenCalledWith({ text: 's' });
    expect(respond).toHaveBeenCalledWith({ ok: true, data: full });
  });

  it('clipDel removes via removeClipDirect and responds', async () => {
    const { respond, keptOpen } = dispatch({ type: 'clipDel', id: 'x' }, 3);
    expect(keptOpen).toBe(true);
    await until(() => respond.mock.calls.length > 0);
    expect(mockRemoveClip).toHaveBeenCalledWith('x');
    expect(respond).toHaveBeenCalledWith({ ok: true, data: undefined });
  });

  it('clipUpdate writes via updateClipDirect and responds', async () => {
    const { respond, keptOpen } = dispatch({ type: 'clipUpdate', id: 'a', patch: { notes: ['n'] } }, 3);
    expect(keptOpen).toBe(true);
    await until(() => respond.mock.calls.length > 0);
    expect(mockUpdateClip).toHaveBeenCalledWith('a', { notes: ['n'] });
    expect(respond).toHaveBeenCalledWith({ ok: true, data: undefined });
  });

  it('responds {ok:false} instead of hanging when the direct op rejects', async () => {
    mockGetClips.mockRejectedValue(new Error('idb down'));
    const { respond, keptOpen } = dispatch({ type: 'clipsGet' });
    expect(keptOpen).toBe(true);
    await until(() => respond.mock.calls.length > 0);
    expect(respond).toHaveBeenCalledWith({ ok: false, error: 'idb down' });
  });

  it('ignores unrelated message types', () => {
    const { respond, keptOpen } = dispatch({ type: 'somethingElse' });
    expect(keptOpen).toBe(false);
    expect(respond).not.toHaveBeenCalled();
  });
});

describe('background context menus', () => {
  beforeEach(() => {
    mockAddClip.mockReset();
    mockTabsSend.mockReset();
    mockTabsSend.mockResolvedValue(undefined);
    mockTabsQuery.mockReset();
    mockTabsQuery.mockResolvedValue([]); // fanOutClipsChanged after the image direct write
  });

  it('save-clip forwards saveClip and save-clip-page forwards saveClipPage to the tab', () => {
    menuListenerRef.current?.({ menuItemId: 'save-clip' }, { id: 5 });
    expect(mockTabsSend).toHaveBeenCalledWith(5, { type: 'saveClip' });
    menuListenerRef.current?.({ menuItemId: 'save-clip-page' }, { id: 5 });
    expect(mockTabsSend).toHaveBeenCalledWith(5, { type: 'saveClipPage' });
  });

  it('save-clip-image writes the clip directly without touching the tab', async () => {
    mockAddClip.mockResolvedValue({ id: 'img-1' });
    menuListenerRef.current?.(
      { menuItemId: 'save-clip-image', srcUrl: 'https://e.com/i.png', altText: 'alt' },
      { id: 5, url: 'https://e.com/p', title: 'T' },
    );
    await until(() => mockAddClip.mock.calls.length > 0);
    expect(mockAddClip).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'image', url: 'https://e.com/i.png', pageUrl: 'https://e.com/p',
      title: 'T', text: 'alt', imageSrc: 'https://e.com/i.png',
    }));
    expect(mockTabsSend).not.toHaveBeenCalled();
  });
});

describe('background commands', () => {
  beforeEach(() => {
    mockTabsQuery.mockReset();
    mockTabsQuery.mockResolvedValue([]);
    mockTabsSend.mockReset();
    mockTabsSend.mockResolvedValue(undefined);
  });

  it('save_clip forwards saveClip to the active tab', async () => {
    mockTabsQuery.mockResolvedValue([{ id: 9 }]);
    commandListenerRef.current?.('save_clip');
    await until(() => mockTabsSend.mock.calls.length > 0);
    expect(mockTabsQuery).toHaveBeenCalledWith({ active: true, currentWindow: true });
    expect(mockTabsSend).toHaveBeenCalledWith(9, { type: 'saveClip' });
  });

  it('ignores other commands', () => {
    commandListenerRef.current?.('some_other_command');
    expect(mockTabsQuery).not.toHaveBeenCalled();
  });
});

describe('background classify', () => {
  const clip = (id: string) => ({
    id, url: 'https://e.com/p', pageUrl: 'https://e.com/p', title: 'T', text: `text ${id}`, createdAt: 1,
  });

  const classifyFetch = (opts: {
    reply: (attempt: number) => string[];
    onSession?: () => void;
  }) => {
    let attempts = 0;
    return vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
      const url = String(_url);
      if (url.endsWith('/sessions') && init?.method === 'POST') {
        const id = `cls-sess-${++attempts}`;
        opts.onSession?.();
        return Promise.resolve({ status: 200, ok: true, json: () => Promise.resolve({ id }) });
      }
      if (url.includes('/events/stream')) {
        const attempt = Number(url.match(/cls-sess-(\d+)/)?.[1] ?? 0);
        return Promise.resolve({ status: 200, ok: true, body: sseStream(opts.reply(attempt)) });
      }
      if (url.includes('/events') && init?.method === 'POST') {
        return Promise.resolve({ status: 200, ok: true });
      }
      return Promise.resolve({ status: 200, ok: true, json: () => Promise.resolve({}) });
    });
  };

  beforeEach(() => {
    mockUpdateClips.mockReset();
    mockUpdateClips.mockResolvedValue(undefined);
  });

  it('classifies clips and writes results', async () => {
    mockGetClips.mockResolvedValue([clip('a')]);
    vi.stubGlobal('fetch', classifyFetch({
      reply: () => [
        JSON.stringify({ type: 'event_delta', delta: { content: { text: '{"clips":[{"id":"a","category":"concept","relatedIds":[],"tags":["ai","x"]}]}' } } }),
        JSON.stringify({ type: 'session.status_idle' }),
      ],
    }));

    const { respond } = dispatch({ type: 'classifyClips' });
    await until(() => respond.mock.calls.length > 0);

    // 结果批量写回(单事务),handleClassify 末尾统一 fan-out
    expect(mockUpdateClips).toHaveBeenCalledWith([
      { id: 'a', patch: { category: 'concept', relatedIds: [], tags: ['ai', 'x'] } },
    ]);
    expect(respond).toHaveBeenCalledWith({ ok: true, data: { classified: 1 } });
    vi.unstubAllGlobals();
  });

  it('splits large libraries into batches and writes each batch back', async () => {
    const clips = Array.from({ length: 120 }, (_, i) => clip(`c${i}`));
    mockGetClips.mockResolvedValue(clips);
    let sessions = 0;
    vi.stubGlobal('fetch', classifyFetch({
      onSession: () => sessions++,
      // each batch filters the reply to its own ids, so replying with all ids is fine
      reply: () => [
        JSON.stringify({
          type: 'event_delta',
          delta: { content: { text: JSON.stringify({ clips: clips.map((c) => ({ id: c.id, category: 'x', relatedIds: [] })) }) } },
        }),
        JSON.stringify({ type: 'session.status_idle' }),
      ],
    }));

    const { respond } = dispatch({ type: 'classifyClips' });
    await until(() => respond.mock.calls.length > 0);

    expect(sessions).toBe(3); // 120 clips / 50 per batch
    expect(mockUpdateClips).toHaveBeenCalledTimes(3);
    expect(mockUpdateClips.mock.calls[0][0]).toHaveLength(50);
    expect(respond).toHaveBeenCalledWith({ ok: true, data: { classified: 120 } });
    vi.unstubAllGlobals();
  });

  it('retries once on an unparseable reply, then surfaces the failure', async () => {
    mockGetClips.mockResolvedValue([clip('a')]);
    let sessions = 0;
    vi.stubGlobal('fetch', classifyFetch({
      onSession: () => sessions++,
      reply: (attempt) => [
        // the retry runs in a fresh session; only it gets a parseable reply
        attempt === 1
          ? JSON.stringify({ type: 'event_delta', delta: { content: { text: 'sorry, cannot do that' } } })
          : JSON.stringify({ type: 'event_delta', delta: { content: { text: '{"clips":[{"id":"a","category":"concept","relatedIds":[]}]}' } } }),
        JSON.stringify({ type: 'session.status_idle' }),
      ],
    }));

    const { respond } = dispatch({ type: 'classifyClips' });
    await until(() => respond.mock.calls.length > 0);
    expect(sessions).toBe(2); // one retry
    expect(respond).toHaveBeenCalledWith({ ok: true, data: { classified: 1 } });

    // both attempts garbage → {ok:false}, and the in-flight lock is released
    sessions = 0;
    vi.stubGlobal('fetch', classifyFetch({
      onSession: () => sessions++,
      reply: () => [
        JSON.stringify({ type: 'event_delta', delta: { content: { text: 'no json at all' } } }),
        JSON.stringify({ type: 'session.status_idle' }),
      ],
    }));
    const second = dispatch({ type: 'classifyClips' });
    await until(() => second.respond.mock.calls.length > 0);
    expect(sessions).toBe(2);
    expect(second.respond).toHaveBeenCalledWith({ ok: false, error: 'no JSON in agent reply' });
    vi.unstubAllGlobals();
  });

  it('shares one in-flight run across concurrent classify triggers', async () => {
    mockGetClips.mockResolvedValue([clip('a')]);
    let sessions = 0;
    let release: (() => void) | null = null;
    const frames = [
      JSON.stringify({ type: 'event_delta', delta: { content: { text: '{"clips":[{"id":"a","category":"x","relatedIds":[]}]}' } } }),
      JSON.stringify({ type: 'session.status_idle' }),
    ];
    const fetchMock = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
      const url = String(_url);
      if (url.endsWith('/sessions') && init?.method === 'POST') {
        sessions++;
        return Promise.resolve({ status: 200, ok: true, json: () => Promise.resolve({ id: `s-${sessions}` }) });
      }
      if (url.includes('/events/stream')) {
        // the test holds the stream open until both triggers have been dispatched
        return Promise.resolve({
          status: 200, ok: true,
          body: new ReadableStream({
            start(c) {
              release = () => {
                c.enqueue(new TextEncoder().encode(frames.map((f) => `data: ${f}\n\n`).join('')));
                c.close();
              };
            },
          }),
        });
      }
      if (url.includes('/events') && init?.method === 'POST') return Promise.resolve({ status: 200, ok: true });
      return Promise.resolve({ status: 200, ok: true, json: () => Promise.resolve({}) });
    });
    vi.stubGlobal('fetch', fetchMock);

    const first = dispatch({ type: 'classifyClips' });
    await until(() => release !== null); // the run reached its stream
    const second = dispatch({ type: 'classifyClips' }); // joins the in-flight run
    release!();
    await until(() => first.respond.mock.calls.length > 0 && second.respond.mock.calls.length > 0);

    expect(sessions).toBe(1); // one shared run, not two
    expect(first.respond).toHaveBeenCalledWith({ ok: true, data: { classified: 1 } });
    expect(second.respond).toHaveBeenCalledWith({ ok: true, data: { classified: 1 } });

    // after completion the lock is released: a new trigger starts a fresh run
    release = null;
    const third = dispatch({ type: 'classifyClips' });
    await until(() => release !== null);
    release!();
    await until(() => third.respond.mock.calls.length > 0);
    expect(sessions).toBe(2);
    vi.unstubAllGlobals();
  });
});
