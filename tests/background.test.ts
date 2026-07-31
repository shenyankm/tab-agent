import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- hoisted mocks (available inside vi.mock factories) ---
const {
  mockPat, mockAgentId, mockEnvId, mockVaultId, mockSessionGet, mockSessionSet,
  connectListenerRef, messageListenerRef,
} = vi.hoisted(() => ({
  mockPat: vi.fn().mockResolvedValue('test-pat'),
  mockAgentId: vi.fn().mockResolvedValue('agent-1'),
  mockEnvId: vi.fn().mockResolvedValue('env-1'),
  mockVaultId: vi.fn().mockResolvedValue(''),
  mockSessionGet: vi.fn().mockResolvedValue(''),
  mockSessionSet: vi.fn().mockResolvedValue(undefined),
  connectListenerRef: { current: null as ((...args: any[]) => void) | null },
  messageListenerRef: { current: null as ((...args: any[]) => any) | null },
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
  dict: { 'zh-CN': { 'clips.menu': '保存选中内容为摘录' } },
  langItem: { getValue: () => Promise.resolve('zh-CN'), watch: () => () => {} },
}));

vi.mock('wxt/utils/define-background', () => ({
  defineBackground: (cb: () => void) => cb(),
}));

vi.mock('wxt/browser', () => ({
  browser: {
    runtime: {
      onConnect: {
        addListener: (fn: (...args: any[]) => void) => { connectListenerRef.current = fn; },
      },
      onMessage: {
        addListener: (fn: (...args: any[]) => any) => { messageListenerRef.current = fn; },
      },
      onInstalled: { addListener: vi.fn() },
    },
    contextMenus: {
      create: vi.fn(),
      update: vi.fn(),
      onClicked: { addListener: vi.fn() },
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

  it('envCheck returns ok:false when unconfigured', async () => {
    mockPat.mockResolvedValue('');
    await expect(messageListenerRef.current?.({ type: 'envCheck' })).resolves.toEqual({ ok: false });
  });

  it('envCheck returns ok:true when agent endpoint responds 200', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 200, ok: true }));
    await expect(messageListenerRef.current?.({ type: 'envCheck' })).resolves.toEqual({ ok: true });
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
});
