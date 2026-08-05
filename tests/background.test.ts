import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- hoisted mocks (available inside vi.mock factories) ---
const {
  mockPat, mockAgentId, mockEnvId, mockVaultId,
  connectListenerRef, messageListenerRef, commandListenerRef, menuListenerRef, installedListenerRef, tabRemovedListenerRef,
  mockGetClips, mockGetClipsForPage, mockAddClip, mockRemoveClip, mockUpdateClip,
  mockTabsQuery, mockTabsSend, mockCapture, mockMenuCreate, mockMenuRemoveAll,
  perTabStorage, mockStorageGet, mockStorageSet, mockStorageRemove,
} = vi.hoisted(() => ({
  mockPat: vi.fn().mockResolvedValue('test-pat'),
  mockAgentId: vi.fn().mockResolvedValue('agent-1'),
  mockEnvId: vi.fn().mockResolvedValue('env-1'),
  mockVaultId: vi.fn().mockResolvedValue(''),
  connectListenerRef: { current: null as ((...args: any[]) => void) | null },
  messageListenerRef: { current: null as ((...args: any[]) => unknown) | null },
  commandListenerRef: { current: null as ((command: string) => void) | null },
  menuListenerRef: { current: null as ((info: any, tab: any) => void) | null },
  installedListenerRef: { current: null as (() => void) | null },
  tabRemovedListenerRef: { current: null as ((tabId: number) => void) | null },
  mockGetClips: vi.fn().mockResolvedValue([]),
  mockGetClipsForPage: vi.fn().mockResolvedValue([]),
  mockAddClip: vi.fn(),
  mockRemoveClip: vi.fn().mockResolvedValue(undefined),
  mockUpdateClip: vi.fn().mockResolvedValue(undefined),
  mockTabsQuery: vi.fn().mockResolvedValue([]),
  mockTabsSend: vi.fn().mockResolvedValue(undefined),
  mockCapture: vi.fn().mockResolvedValue('data:image/jpeg;base64,Zm9v'),
  mockMenuCreate: vi.fn(),
  mockMenuRemoveAll: vi.fn().mockResolvedValue(undefined),
  // backing map for the per-tab session cache (WXT storage auto-import)
  perTabStorage: new Map<string, unknown>(),
  mockStorageGet: vi.fn((key: string) => Promise.resolve(perTabStorage.get(key) ?? null)),
  mockStorageSet: vi.fn((key: string, value: unknown) => { perTabStorage.set(key, value); return Promise.resolve(); }),
  mockStorageRemove: vi.fn((key: string) => { perTabStorage.delete(key); return Promise.resolve(); }),
}));

vi.mock('@/lib/settings', () => ({
  GATEWAY: 'https://api.test.com',
  patItem: { getValue: () => mockPat() },
  agentIdItem: { getValue: () => mockAgentId() },
  envIdItem: { getValue: () => mockEnvId() },
  vaultIdItem: { getValue: () => mockVaultId() },
  // 云端记忆默认关闭:既有用例零行为变化;watch 供开关全量补齐钩子注册
  memorySyncItem: { getValue: () => Promise.resolve(false), watch: () => () => {} },
  memoryStoreIdItem: { getValue: () => Promise.resolve('') },
  memoryMapItem: { getValue: () => Promise.resolve({}), setValue: () => Promise.resolve() },
  deploymentIdItem: { getValue: () => Promise.resolve('') },
}));

// 日报 Deployment 编排在启动时跑:mock 掉避免测试内真实请求网关
vi.mock('@/lib/daily-report', () => ({ syncDeployment: vi.fn().mockResolvedValue(undefined) }));

vi.mock('@/lib/i18n', () => ({
  dict: { 'zh-CN': { 'clips.menu': '保存选中内容为摘录', 'clips.menu.page': '保存整页为摘录', 'clips.menu.image': '保存图片为摘录' } },
  langItem: { getValue: () => Promise.resolve('zh-CN'), watch: () => () => {} },
  DEFAULT_LANG: 'zh-CN',
}));

vi.mock('wxt/utils/define-background', () => ({
  defineBackground: (cb: () => void) => cb(),
}));

// WXT auto-imported `storage` (per-tab session cache in handleChat)
vi.mock('wxt/utils/storage', () => ({
  storage: {
    getItem: (key: string) => mockStorageGet(key),
    setItem: (key: string, value: string) => mockStorageSet(key, value),
    removeItem: (key: string) => mockStorageRemove(key),
  },
}));

vi.mock('@/lib/clips-store', () => ({
  getClipsDirect: () => mockGetClips(),
  getClipsForPageDirect: (page: string) => mockGetClipsForPage(page),
  addClipDirect: (clip: unknown) => mockAddClip(clip),
  removeClipDirect: (id: string) => mockRemoveClip(id),
  updateClipDirect: (id: string, patch: unknown) => mockUpdateClip(id, patch),
  normalizeUrl: (u: string) => { try { const p = new URL(u); p.hash = ''; return p.toString(); } catch { return u; } },
}));

vi.mock('wxt/browser', () => ({
  browser: {
    runtime: {
      onConnect: {
        addListener: (fn: (...args: any[]) => void) => { connectListenerRef.current = fn; },
      },
      onInstalled: { addListener: (fn: () => void) => { installedListenerRef.current = fn; } },
      onMessage: {
        addListener: (fn: (...args: any[]) => unknown) => { messageListenerRef.current = fn; },
      },
      // fanOutClipsChanged broadcasts to extension pages; no listener in tests
      sendMessage: vi.fn().mockRejectedValue(new Error('no listener')),
      // keepalive pings this every 20s while a turn streams nothing
      getPlatformInfo: vi.fn().mockResolvedValue({}),
    },
    contextMenus: {
      create: (props: unknown) => mockMenuCreate(props),
      update: vi.fn(),
      removeAll: () => mockMenuRemoveAll(),
      onClicked: { addListener: (fn: (info: any, tab: any) => void) => { menuListenerRef.current = fn; } },
    },
    commands: {
      onCommand: { addListener: (fn: (command: string) => void) => { commandListenerRef.current = fn; } },
    },
    tabs: {
      query: (info: unknown) => mockTabsQuery(info),
      sendMessage: (tabId: number, msg: unknown) => mockTabsSend(tabId, msg),
      captureVisibleTab: (...args: unknown[]) => mockCapture(...args),
      onRemoved: { addListener: (fn: (tabId: number) => void) => { tabRemovedListenerRef.current = fn; } },
    },
  },
}));

// import after mocks — triggers defineBackground callback
await import('@/entrypoints/background');

// 会话缓存 v4:值为 {id, day},跨天轮换
const TODAY = new Date().toLocaleDateString('en-CA');
const sess = (id: string) => ({ id, day: TODAY });

// --- port pair wiring ---
type Listener = (...args: any[]) => void;

function createPortPair(sender?: { tabId: number; windowId?: number }) {
  const incoming: Listener[] = []; // background → test
  const outgoing: Listener[] = []; // test → background
  const disconnectListeners: Listener[] = [];

  const bgPort = {
    name: 'chat',
    onMessage: { addListener: (fn: Listener) => { outgoing.push(fn); } },
    onDisconnect: { addListener: (fn: Listener) => { disconnectListeners.push(fn); } },
    postMessage: (msg: unknown) => incoming.forEach((fn) => fn(msg)),
    // chrome always sets port.sender for content-script ports; absent in older tests
    ...(sender ? { sender: { tab: { id: sender.tabId, windowId: sender.windowId } } } : {}),
  };

  const testPort = {
    postMessage: (msg: unknown) => outgoing.forEach((fn) => fn(msg)),
    onMessage: { addListener: (fn: Listener) => { incoming.push(fn); } },
    disconnect: () => disconnectListeners.forEach((fn) => fn()),
  };

  return { bgPort, testPort };
}

function connect(sender?: { tabId: number; windowId?: number }) {
  const messages: unknown[] = [];
  const pair = createPortPair(sender);
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

// until() polls via setTimeout, which fake timers freeze — this variant polls via
// microtask yields instead, so it keeps working while vi.useFakeTimers() is active
async function untilFake(pred: () => boolean) {
  for (let i = 0; i < 200 && !pred(); i++) await Promise.resolve();
  if (!pred()) throw new Error('timeout waiting for condition');
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
    perTabStorage.clear();
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
    perTabStorage.set('local:sessionId.v4.tab.7', sess('sess-1'));
    // the gateway pushes this turn's events only AFTER the user.message POST
    // returns — events arriving before it (the old turn's replay) must be dropped
    let controller: ReadableStreamDefaultController | null = null;
    let posts = 0;
    const fetchMock = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
      const url = String(_url);
      if (url.includes('/events/stream')) {
        return Promise.resolve({
          status: 200,
          ok: true,
          body: new ReadableStream({ start(c) { controller = c; } }),
        });
      }
      if (url.includes('/events') && init?.method === 'POST') {
        posts++;
        // this turn's events flow only after the post resolves (posted flips
        // true in the caller) — a macrotask guarantees that microtask chain ran
        if (posts === 1) {
          const frames = [
            { type: 'event_start', event: { id: 'evt_1', type: 'user.message' } },
            { type: 'event_start', event: { id: 'evt_2', type: 'agent.message' } },
            { type: 'event_delta', delta: { content: { text: 'Hi ' } } },
            { type: 'event_delta', delta: { content: { text: 'there' } } },
            { type: 'session.status_idle' },
          ];
          setTimeout(() => {
            controller?.enqueue(new TextEncoder().encode(frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join('')));
            controller?.close();
          }, 0);
        }
        return Promise.resolve({ status: 200, ok: true });
      }
      return Promise.resolve({ status: 200, ok: true, json: () => Promise.resolve({}) });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { port, messages } = connect({ tabId: 7 });
    port.postMessage({ text: 'hello' });
    await until(() => messages.some((m: any) => m.type === 'done'));

    const deltas = messages.filter((m: any) => m.type === 'delta');
    // frames arriving in one network read are coalesced into a single delta
    expect(deltas).toEqual([{ type: 'delta', text: 'Hi there' }]);
    expect(messages.at(-1)).toEqual({ type: 'done' });
  });

  it('recreates session when cached session returns 404', async () => {
    perTabStorage.set('local:sessionId.v4.tab.7', sess('dead-session'));
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

    const { port, messages } = connect({ tabId: 7 });
    port.postMessage({ text: 'hello' });
    await until(() => messages.some((m: any) => m.type === 'done'));

    expect(perTabStorage.get('local:sessionId.v4.tab.7')).toEqual(sess('new-sess'));
    expect(messages.at(-1)).toEqual({ type: 'done' });
  });

  // regression: non-streaming fetches carried no signal — a hung gateway kept
  // handleChat unsettled forever, leaking the keepalive interval and pinning the
  // worker alive. Every fetch must carry a signal that port disconnect aborts.
  it('wires an abort signal into every fetch and aborts on port disconnect', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {}); // expected abort trace
    try {
      // cached session: the turn fires BOTH the stream and the post fetch
      perTabStorage.set('local:sessionId.v4.tab.7', sess('sess-1'));
      const signals: (AbortSignal | undefined)[] = [];
      vi.stubGlobal('fetch', vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
        signals.push(init?.signal ?? undefined);
        // hang until aborted — the only way out must be the signal
        return new Promise((_, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal!.reason ?? new Error('aborted')));
        });
      }));

      const { port, messages } = connect({ tabId: 7 });
      port.postMessage({ text: 'hello' });
      await until(() => signals.length >= 2);
      for (const s of signals) {
        expect(s).toBeInstanceOf(AbortSignal); // 30s hang guard applies even without a caller signal
        expect(s!.aborted).toBe(false);
      }

      port.disconnect();
      await until(() => signals.every((s) => s!.aborted));
      expect(messages).toEqual([]); // port is gone; nothing to send to, no crash
      // the abort trace lands a few microtasks after the signals flip — wait it out
      // before restoring the spy, or it leaks into the test output
      await until(() => errSpy.mock.calls.length > 0);
    } finally {
      errSpy.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  // real protocol timeline: the stream opens first and replays the previous turn's
  // events (user.message event_start, in-flight deltas, idle) BEFORE our POST returns
  it('cancels the in-flight turn, drops the old turn\'s replay, and retries the post on 409', async () => {
    perTabStorage.set('local:sessionId.v4.tab.7', sess('sess-1'));
    let posts = 0;
    let cancels = 0;
    let releaseIdle: (() => void) | null = null;
    let sendNewTurn: (() => void) | null = null;
    vi.stubGlobal('fetch', vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
      const url = String(_url);
      if (url.includes('/events/stream')) {
        return Promise.resolve({
          status: 200,
          ok: true,
          body: new ReadableStream({
            start(c) {
              // old turn's replay arrives immediately, before the first POST returns
              c.enqueue(new TextEncoder().encode(
                `data: ${JSON.stringify({ type: 'event_start', event: { id: 'evt_old_1', type: 'user.message' } })}\n\n` +
                `data: ${JSON.stringify({ type: 'event_start', event: { id: 'evt_old_2', type: 'agent.message' } })}\n\n`
              ));
              releaseIdle = () => {
                c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: 'session.status_idle' })}\n\n`));
              };
              sendNewTurn = () => {
                c.enqueue(new TextEncoder().encode(
                  `data: ${JSON.stringify({ type: 'event_start', event: { id: 'evt_new_1', type: 'user.message' } })}\n\n` +
                  `data: ${JSON.stringify({ type: 'event_start', event: { id: 'evt_new_2', type: 'agent.message' } })}\n\n` +
                  `data: ${JSON.stringify({ type: 'event_delta', delta: { content: { text: 'New reply' } } })}\n\n` +
                  `data: ${JSON.stringify({ type: 'session.status_idle' })}\n\n`
                ));
                c.close();
              };
            },
          }),
        });
      }
      if (url.endsWith('/cancel') && init?.method === 'POST') {
        cancels++;
        return Promise.resolve({ status: 200, ok: true });
      }
      if (url.includes('/events') && init?.method === 'POST') {
        posts++;
        // events flow only AFTER the post resolves (posted flips true) — a
        // macrotask guarantees this microtask chain (incl. posted=true) finished
        if (posts === 2) setTimeout(() => sendNewTurn?.(), 0);
        return Promise.resolve(posts === 1 ? { status: 409, ok: false } : { status: 200, ok: true });
      }
      return Promise.resolve({ status: 200, ok: true, json: () => Promise.resolve({}) });
    }));

    const { port, messages } = connect({ tabId: 7 });
    port.postMessage({ text: 'hello' });

    await until(() => posts === 1 && cancels === 1 && releaseIdle !== null);
    expect(messages).toEqual([]); // replay + cancel are silent: no deltas, no done yet

    releaseIdle!(); // the cancelled turn reaches idle → onIdle resolves → retry
    await until(() => posts === 2);
    await until(() => messages.some((m: any) => m.type === 'done'));
    expect(cancels).toBe(1);
    // only the new turn's text reaches the UI; the old turn's replay never leaks
    expect(messages.filter((m: any) => m.type === 'delta')).toEqual([{ type: 'delta', text: 'New reply' }]);
    expect(messages.at(-1)).toEqual({ type: 'done' });
    vi.unstubAllGlobals();
  });

  it('gives up after two retries on persistent 409 and surfaces the error', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {}); // expected failure trace
    try {
      perTabStorage.set('local:sessionId.v4.tab.7', sess('sess-1'));
      let posts = 0;
      let cancels = 0;
      let releaseIdle: (() => void) | null = null;
      vi.stubGlobal('fetch', vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
        const url = String(_url);
        if (url.includes('/events/stream')) {
          // old turn's replay arrives first; idle frames are released per retry round
          return Promise.resolve({
            status: 200,
            ok: true,
            body: new ReadableStream({
              start(c) {
                c.enqueue(new TextEncoder().encode(
                  `data: ${JSON.stringify({ type: 'event_start', event: { id: 'evt_old_1', type: 'user.message' } })}\n\n`
                ));
                releaseIdle = () => {
                  c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: 'session.status_idle' })}\n\n`));
                };
              },
            }),
          });
        }
        if (url.endsWith('/cancel') && init?.method === 'POST') {
          cancels++;
          return Promise.resolve({ status: 200, ok: true });
        }
        if (url.includes('/events') && init?.method === 'POST') {
          posts++;
          return Promise.resolve({ status: 409, ok: false }); // every post conflicts
        }
        return Promise.resolve({ status: 200, ok: true, json: () => Promise.resolve({}) });
      }));

      const { port, messages } = connect({ tabId: 7 });
      port.postMessage({ text: 'hello' });

      // each 409 round: cancel → wait for idle → retry (2 rounds max)
      for (let i = 1; i <= 2; i++) {
        await until(() => posts === i && cancels === i);
        releaseIdle!();
        await until(() => posts === i + 1);
      }
      await until(() => messages.some((m: any) => m.type === 'error'));

      expect(posts).toBe(3); // initial + 2 retries, then error
      expect(cancels).toBe(2);
      expect(messages.at(-1)).toMatchObject({ type: 'error', message: 'send message: HTTP 409' });
    } finally {
      errSpy.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  // a stream that closes without session.status_idle (server close, network drop) must
  // still complete the turn — otherwise the content script hangs in "thinking" forever
  it('sends done when the stream closes without session.status_idle', async () => {
    perTabStorage.set('local:sessionId.v4.tab.7', sess('sess-1'));
    vi.stubGlobal('fetch', vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
      const url = String(_url);
      if (url.includes('/events/stream')) {
        return Promise.resolve({
          status: 200,
          ok: true,
          body: sseStream([JSON.stringify({ type: 'event_delta', delta: { content: { text: 'partial' } } })]),
        });
      }
      if (url.includes('/events') && init?.method === 'POST') {
        return Promise.resolve({ status: 200, ok: true });
      }
      return Promise.resolve({ status: 200, ok: true, json: () => Promise.resolve({}) });
    }));

    const { port, messages } = connect({ tabId: 7 });
    port.postMessage({ text: 'hello' });
    await until(() => messages.some((m: any) => m.type === 'done'));
    expect(messages.some((m: any) => m.type === 'error')).toBe(false);
    expect(messages.at(-1)).toEqual({ type: 'done' });
    vi.unstubAllGlobals();
  });

  it('captures, uploads and mounts a screenshot before posting the message', async () => {
    perTabStorage.set('local:sessionId.v4.tab.7', sess('sess-1'));
    const order: string[] = [];
    vi.stubGlobal('fetch', vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
      const url = String(_url);
      // the captured dataURL is fetched back into a blob for the multipart upload
      if (url.startsWith('data:')) {
        return Promise.resolve({ ok: true, status: 200, blob: () => Promise.resolve(new Blob(['img'], { type: 'image/jpeg' })) });
      }
      if (url.endsWith('/files') && init?.method === 'POST') {
        order.push('upload');
        expect(init.body).toBeInstanceOf(FormData);
        return Promise.resolve({ status: 200, ok: true, json: () => Promise.resolve({ id: 'file-1' }) });
      }
      if (url.endsWith('/resources') && init?.method === 'POST') {
        order.push('mount');
        expect(JSON.parse(String(init.body))).toEqual({
          type: 'file', file_id: 'file-1', mount_path: '/data/input/screenshot.jpg',
        });
        return Promise.resolve({ status: 200, ok: true });
      }
      if (url.includes('/events/stream')) {
        return Promise.resolve({ status: 200, ok: true, body: sseStream([JSON.stringify({ type: 'session.status_idle' })]) });
      }
      if (url.includes('/events') && init?.method === 'POST') {
        order.push('post');
        expect(String(init.body)).toContain('/data/input/screenshot.jpg'); // mount note inlined
        return Promise.resolve({ status: 200, ok: true });
      }
      return Promise.resolve({ status: 200, ok: true, json: () => Promise.resolve({}) });
    }));

    const { port, messages } = connect({ tabId: 7 });
    port.postMessage({ text: 'what do you see?', screenshot: true });
    await until(() => messages.some((m: any) => m.type === 'done'));

    expect(mockCapture).toHaveBeenCalledWith({ format: 'jpeg', quality: 80 });
    expect(order).toEqual(['upload', 'mount', 'post']);
    expect(messages.at(-1)).toEqual({ type: 'done' });
    vi.unstubAllGlobals();
  });

  it('recreates the session and re-mounts the screenshot when mounting returns 404', async () => {
    perTabStorage.set('local:sessionId.v4.tab.7', sess('dead-sess'));
    let uploads = 0;
    const mounts: string[] = [];
    vi.stubGlobal('fetch', vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
      const url = String(_url);
      if (url.startsWith('data:')) {
        return Promise.resolve({ ok: true, status: 200, blob: () => Promise.resolve(new Blob(['img'], { type: 'image/jpeg' })) });
      }
      if (url.endsWith('/files') && init?.method === 'POST') {
        uploads++;
        return Promise.resolve({ status: 200, ok: true, json: () => Promise.resolve({ id: 'file-1' }) });
      }
      if (url.endsWith('/sessions') && init?.method === 'POST') {
        return Promise.resolve({ status: 200, ok: true, json: () => Promise.resolve({ id: 'new-sess' }) });
      }
      if (url.includes('/resources') && init?.method === 'POST') {
        const sid = url.match(/sessions\/([^/]+)\/resources/)?.[1] ?? '?';
        mounts.push(sid);
        return Promise.resolve({ status: sid === 'dead-sess' ? 404 : 200, ok: sid !== 'dead-sess' });
      }
      if (url.includes('/events/stream')) {
        return Promise.resolve({ status: 200, ok: true, body: sseStream([JSON.stringify({ type: 'session.status_idle' })]) });
      }
      if (url.includes('/events') && init?.method === 'POST') {
        return Promise.resolve({ status: 200, ok: true });
      }
      return Promise.resolve({ status: 200, ok: true, json: () => Promise.resolve({}) });
    }));

    const { port, messages } = connect({ tabId: 7 });
    port.postMessage({ text: 'what do you see?', screenshot: true });
    await until(() => messages.some((m: any) => m.type === 'done'));

    expect(uploads).toBe(1); // upload happens once; only mounting is per-session
    expect(mounts).toEqual(['dead-sess', 'new-sess']);
    expect(perTabStorage.get('local:sessionId.v4.tab.7')).toEqual(sess('new-sess'));
    expect(messages.at(-1)).toEqual({ type: 'done' });
    vi.unstubAllGlobals();
  });
});

describe('background per-tab sessions', () => {
  beforeEach(() => {
    mockPat.mockResolvedValue('test-pat');
    mockAgentId.mockResolvedValue('agent-1');
    mockEnvId.mockResolvedValue('env-1');
    mockVaultId.mockResolvedValue('');
    mockStorageGet.mockClear();
    mockStorageSet.mockClear();
    perTabStorage.clear();
  });

  // fetch mock that serves any cached session and records which session ids get used
  function stubChatFetch(sessionsUsed: string[]) {
    vi.stubGlobal('fetch', vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
      const url = String(_url);
      const sid = url.match(/sessions\/([^/]+)\//)?.[1];
      if (sid) sessionsUsed.push(sid);
      if (url.includes('/events/stream')) {
        return Promise.resolve({
          status: 200,
          ok: true,
          body: sseStream([JSON.stringify({ type: 'session.status_idle' })]),
        });
      }
      return Promise.resolve({ status: 200, ok: true, json: () => Promise.resolve({}) });
    }));
  }

  it('gives each tab its own cached session', async () => {
    perTabStorage.set('local:sessionId.v4.tab.7', sess('sess-A'));
    perTabStorage.set('local:sessionId.v4.tab.9', sess('sess-B'));
    const sessionsUsed: string[] = [];
    stubChatFetch(sessionsUsed);

    const tabA = connect({ tabId: 7, windowId: 1 });
    tabA.port.postMessage({ text: 'hi from A' });
    await until(() => tabA.messages.some((m: any) => m.type === 'done'));

    const tabB = connect({ tabId: 9, windowId: 1 });
    tabB.port.postMessage({ text: 'hi from B' });
    await until(() => tabB.messages.some((m: any) => m.type === 'done'));

    expect(sessionsUsed).toContain('sess-A');
    expect(sessionsUsed).toContain('sess-B');
    expect(sessionsUsed).not.toContain('new-sess');
    vi.unstubAllGlobals();
  });

  it('recreates a dead per-tab session and writes it back to the per-tab key', async () => {
    perTabStorage.set('local:sessionId.v4.tab.7', sess('dead-sess'));
    vi.stubGlobal('fetch', vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
      const url = String(_url);
      if (url.endsWith('/sessions') && init?.method === 'POST') {
        return Promise.resolve({ status: 200, ok: true, json: () => Promise.resolve({ id: 'new-sess' }) });
      }
      if (url.includes('dead-sess')) return Promise.resolve({ status: 404, ok: false });
      if (url.includes('/events/stream')) {
        return Promise.resolve({
          status: 200,
          ok: true,
          body: sseStream([JSON.stringify({ type: 'session.status_idle' })]),
        });
      }
      return Promise.resolve({ status: 200, ok: true, json: () => Promise.resolve({}) });
    }));

    const { port, messages } = connect({ tabId: 7, windowId: 1 });
    port.postMessage({ text: 'hello' });
    await until(() => messages.some((m: any) => m.type === 'done'));

    expect(mockStorageSet).toHaveBeenCalledWith('local:sessionId.v4.tab.7', sess('new-sess'));
    expect(messages.at(-1)).toEqual({ type: 'done' });
    vi.unstubAllGlobals();
  });

  it('screenshots the sender window rather than the focused one', async () => {
    perTabStorage.set('local:sessionId.v4.tab.7', sess('sess-A'));
    vi.stubGlobal('fetch', vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
      const url = String(_url);
      if (url.startsWith('data:')) {
        return Promise.resolve({ ok: true, status: 200, blob: () => Promise.resolve(new Blob(['img'], { type: 'image/jpeg' })) });
      }
      if (url.endsWith('/files') && init?.method === 'POST') {
        return Promise.resolve({ status: 200, ok: true, json: () => Promise.resolve({ id: 'file-1' }) });
      }
      if (url.includes('/events/stream')) {
        return Promise.resolve({ status: 200, ok: true, body: sseStream([JSON.stringify({ type: 'session.status_idle' })]) });
      }
      return Promise.resolve({ status: 200, ok: true, json: () => Promise.resolve({}) });
    }));

    const { port, messages } = connect({ tabId: 7, windowId: 42 });
    port.postMessage({ text: 'what do you see?', screenshot: true });
    await until(() => messages.some((m: any) => m.type === 'done'));

    expect(mockCapture).toHaveBeenCalledWith(42, { format: 'jpeg', quality: 80 });
    vi.unstubAllGlobals();
  });

  it('prunes the per-tab session key when the tab is closed', async () => {
    perTabStorage.set('local:sessionId.v4.tab.7', sess('sess-A'));
    mockStorageRemove.mockClear();

    tabRemovedListenerRef.current?.(7);

    expect(mockStorageRemove).toHaveBeenCalledWith('local:sessionId.v4.tab.7');
    expect(perTabStorage.has('local:sessionId.v4.tab.7')).toBe(false);
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

  it('clipAdd writes via addClipDirect, fans out, and responds with the clip', async () => {
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

  // regression (commit 3a7cdf8): onInstalled also fires on extension update, where the
  // menu ids already exist and create() errors on duplicates — removeAll must run first,
  // and be awaited so the creates can't race ahead of it
  it('rebuilds the menus on install: removeAll awaited before exactly three creates', async () => {
    mockMenuRemoveAll.mockClear();
    mockMenuCreate.mockClear();
    installedListenerRef.current?.();
    await until(() => mockMenuCreate.mock.calls.length === 3);
    expect(mockMenuRemoveAll).toHaveBeenCalledTimes(1);
    expect(mockMenuRemoveAll.mock.invocationCallOrder[0]).toBeLessThan(mockMenuCreate.mock.invocationCallOrder[0]);
    expect(mockMenuCreate.mock.calls.map((c) => (c[0] as { id: string }).id)).toEqual([
      'save-clip', 'save-clip-page', 'save-clip-image',
    ]);
  });

  it('save-clip forwards saveClip and save-clip-page forwards saveClipPage to the tab', () => {
    menuListenerRef.current?.({ menuItemId: 'save-clip' }, { id: 5 });
    expect(mockTabsSend).toHaveBeenCalledWith(5, { type: 'saveClip' });
    menuListenerRef.current?.({ menuItemId: 'save-clip-page' }, { id: 5 });
    expect(mockTabsSend).toHaveBeenCalledWith(5, { type: 'saveClipPage' });
  });

  it('save-clip-image forwards to the content script (page side owns url/title, no tabs permission)', () => {
    menuListenerRef.current?.(
      { menuItemId: 'save-clip-image', srcUrl: 'https://e.com/i.png', altText: 'alt' },
      { id: 5, url: 'https://e.com/p', title: 'T' },
    );
    expect(mockTabsSend).toHaveBeenCalledWith(5, { type: 'saveClipImage', srcUrl: 'https://e.com/i.png', altText: 'alt' });
    expect(mockAddClip).not.toHaveBeenCalled();
  });

  it('save-clip-image falls back to a degraded direct write when the tab has no content script', async () => {
    mockAddClip.mockResolvedValue({ id: 'img-1' });
    mockTabsSend.mockRejectedValue(new Error('no content script'));
    menuListenerRef.current?.(
      { menuItemId: 'save-clip-image', srcUrl: 'https://e.com/i.png', altText: 'alt' },
      { id: 5 },
    );
    await until(() => mockAddClip.mock.calls.length > 0);
    expect(mockAddClip).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'image', url: 'https://e.com/i.png', pageUrl: 'https://e.com/i.png',
      title: '', text: 'alt', imageSrc: 'https://e.com/i.png',
    }));
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

