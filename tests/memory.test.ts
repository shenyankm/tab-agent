import { describe, it, expect, vi, beforeEach } from 'vitest';

// 整模块 mock gateway:只测镜像编排逻辑,不碰真实 fetch 层
const { mockApi } = vi.hoisted(() => ({ mockApi: vi.fn() }));
vi.mock('@/lib/gateway', () => ({ api: (...args: unknown[]) => mockApi(...args) }));

const { mockPat, mockStoreId, mockMapGet, mockMapSet, mockGetClips, mockMapState } = vi.hoisted(() => {
  // map 走共享状态:setValue 之后 getValue 读到新值,模拟真实 storage 行为
  const mockMapState = { value: {} as Record<string, string> };
  return {
    mockPat: vi.fn().mockResolvedValue('test-pat'),
    mockStoreId: vi.fn().mockResolvedValue('store-1'),
    mockMapGet: vi.fn(() => Promise.resolve(mockMapState.value)),
    mockMapSet: vi.fn((v: Record<string, string>) => { mockMapState.value = v; return Promise.resolve(); }),
    mockGetClips: vi.fn().mockResolvedValue([]),
    mockMapState,
  };
});

vi.mock('@/lib/settings', () => ({
  patItem: { getValue: () => mockPat() },
  memoryStoreIdItem: { getValue: () => mockStoreId() },
  memoryMapItem: { getValue: () => mockMapGet(), setValue: (v: unknown) => mockMapSet(v as Record<string, string>) },
}));

vi.mock('@/lib/clips-store', () => ({
  getClipsDirect: () => mockGetClips(),
}));

const { syncAllClipsToMemoryStore, deleteClipFromMemoryStore } = await import('@/lib/memory');

const clip = (id: string, extra: Record<string, unknown> = {}) => ({
  id, url: `https://e.com/${id}`, pageUrl: 'https://e.com/p', title: `T ${id}`,
  text: `text ${id}`, createdAt: 1700000000000, ...extra,
});

// create/update/delete 按 path 区分:create 落到 memories 集合,update/delete 落到单条 memory
function memoryFetch(reply: (path: string, init: RequestInit) => { ok: boolean; status: number; id?: string }) {
  mockApi.mockImplementation((_pat: string, path: string, init?: RequestInit) => {
    const r = reply(path, init ?? {});
    return Promise.resolve({
      ok: r.ok,
      status: r.status,
      json: () => Promise.resolve({ id: r.id }),
    });
  });
}

const ok = (init?: RequestInit) => ({ ok: true, status: 200, id: undefined });

beforeEach(() => {
  mockApi.mockReset();
  mockPat.mockResolvedValue('test-pat');
  mockStoreId.mockResolvedValue('store-1');
  mockMapState.value = {};
  mockMapSet.mockClear(); // 保留 hoisted 实现,只清调用记录
  mockGetClips.mockResolvedValue([]);
});

describe('syncAllClipsToMemoryStore', () => {
  it('skips without a PAT — no API calls, reports 0', async () => {
    mockPat.mockResolvedValue('');
    expect(await syncAllClipsToMemoryStore()).toBe(0);
    expect(mockApi).not.toHaveBeenCalled();
  });

  it('creates a memory per clip, records the returned id in the map', async () => {
    mockGetClips.mockResolvedValue([clip('a'), clip('b')]);
    memoryFetch((path, init) => {
      if (!init.method || init.method !== 'POST') return { ok: false, status: 405 };
      const body = JSON.parse(String(init.body));
      if (path !== '/memory_stores/store-1/memories') return { ok: false, status: 404 };
      return { ok: true, status: 200, id: `mem-${body.path.match(/clips\/(.+)\.md/)[1]}` };
    });

    expect(await syncAllClipsToMemoryStore()).toBe(2);
    // 创建请求带 path 与 content
    expect(JSON.parse(String(mockApi.mock.calls[0][2]?.body))).toMatchObject({ path: 'clips/a.md' });
    expect(JSON.parse(String(mockApi.mock.calls[1][2]?.body))).toMatchObject({ path: 'clips/b.md' });
    expect(mockMapSet).toHaveBeenCalledWith({ a: 'mem-a', b: 'mem-b' });
  });

  it('updates already-mapped clips instead of recreating them', async () => {
    mockMapState.value = { a: 'mem-a' };
    mockGetClips.mockResolvedValue([clip('a')]);
    const calls: string[] = [];
    memoryFetch((path, init) => {
      calls.push(path);
      return ok(init);
    });

    expect(await syncAllClipsToMemoryStore()).toBe(1);
    // 更新落到单条 memory,不再走创建集合;更新 body 只含 content
    expect(calls).toEqual(['/memory_stores/store-1/memories/mem-a']);
    expect(JSON.parse(String(mockApi.mock.calls[0][2]?.body))).toMatchObject({ content: expect.stringContaining('text a') });
    expect(mockMapSet).not.toHaveBeenCalled();
  });

  it('counts only successes when individual writes fail', async () => {
    mockGetClips.mockResolvedValue([clip('a'), clip('b'), clip('c')]);
    let n = 0;
    memoryFetch(() => ({ ok: ++n !== 2, status: n === 2 ? 500 : 200, id: `mem-c${n}` }));

    expect(await syncAllClipsToMemoryStore()).toBe(2); // 中间一条 500,不阻断其余
    expect(mockApi).toHaveBeenCalledTimes(3);
  });
});

describe('deleteClipFromMemoryStore', () => {
  it('deletes the mapped memory and clears the map entry', async () => {
    mockMapState.value = { a: 'mem-a' };
    const calls: string[] = [];
    memoryFetch((path, init) => {
      calls.push(path);
      return ok(init);
    });

    await deleteClipFromMemoryStore('a');
    expect(calls).toEqual(['/memory_stores/store-1/memories/mem-a']);
    expect(mockApi.mock.calls[0][2]).toMatchObject({ method: 'DELETE' });
    expect(mockMapSet).toHaveBeenCalledWith({});
  });

  it('is a no-op for clips never synced', async () => {
    await deleteClipFromMemoryStore('ghost');
    expect(mockApi).not.toHaveBeenCalled();
  });
});
