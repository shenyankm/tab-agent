import { describe, it, expect, vi, beforeEach } from 'vitest';

// 整模块 mock gateway:只测 Deployment 编排,不碰真实 fetch 层
const { mockApi } = vi.hoisted(() => ({ mockApi: vi.fn() }));
vi.mock('@/lib/gateway', () => ({ api: (...args: unknown[]) => mockApi(...args) }));

// ensureMemoryStore 的编排已在 memory.test 覆盖,这里固定返回
vi.mock('@/lib/memory', () => ({ ensureMemoryStore: () => Promise.resolve('store-1') }));

const { state, mockDepIdSet } = vi.hoisted(() => {
  // 设置项走共享可变状态:setValue 后 getValue 读到新值,模拟真实 storage
  const state = { pat: 'test-pat', agentId: 'agent-1', envId: 'env-1', vaultId: 'vault-1', depId: '' };
  return { state, mockDepIdSet: vi.fn((v: string) => { state.depId = v; return Promise.resolve(); }) };
});

vi.mock('@/lib/settings', () => ({
  patItem: { getValue: () => Promise.resolve(state.pat) },
  agentIdItem: { getValue: () => Promise.resolve(state.agentId) },
  envIdItem: { getValue: () => Promise.resolve(state.envId) },
  vaultIdItem: { getValue: () => Promise.resolve(state.vaultId) },
  deploymentIdItem: { getValue: () => Promise.resolve(state.depId), setValue: (v: string) => mockDepIdSet(v) },
}));

const { buildInstruction, syncDeployment } = await import('@/lib/daily-report');

// 按 path 路由的 api mock 工厂:默认全部 200
function apiFetch(reply?: (path: string, init?: RequestInit) => { ok: boolean; status: number; json?: unknown }) {
  mockApi.mockImplementation((_pat: string, path: string, init?: RequestInit) => {
    const r = reply?.(path, init) ?? { ok: true, status: 200 };
    return Promise.resolve({ ok: r.ok, status: r.status, json: () => Promise.resolve(r.json ?? {}) });
  });
}

beforeEach(() => {
  mockApi.mockReset();
  mockDepIdSet.mockClear();
  Object.assign(state, { pat: 'test-pat', agentId: 'agent-1', envId: 'env-1', vaultId: 'vault-1', depId: '' });
});

describe('buildInstruction', () => {
  it('leaves the Notion target to the agent-side config and skips empty days', () => {
    const s = buildInstruction();
    expect(s).toContain('usage/');
    expect(s).toContain('被配置写入的 Notion 数据库');
    expect(s).toContain('不要创建任何 Notion 页面');
  });
});

describe('syncDeployment', () => {
  it('is a zero-network no-op once the deployment id is cached', async () => {
    state.depId = 'dep-1';
    apiFetch();
    await syncDeployment();
    expect(mockApi).not.toHaveBeenCalled();
  });

  it('unconfigured makes no API calls (retry happens on next worker start)', async () => {
    state.pat = '';
    await syncDeployment();
    expect(mockApi).not.toHaveBeenCalled();
  });

  it('creates the cron deployment (vault + read-only memory store) and caches the id', async () => {
    apiFetch((path, init) => {
      if (path === '/deployments' && init?.method === 'POST')
        return { ok: true, status: 200, json: { id: 'dep-new' } };
      if (path === '/deployments') return { ok: true, status: 200, json: { data: [] } }; // list: no existing
      return { ok: true, status: 200 };
    });
    await syncDeployment();
    const create = mockApi.mock.calls.find((c) => c[1] === '/deployments' && (c[2] as RequestInit)?.method === 'POST');
    const body = JSON.parse(String(create?.[2]?.body));
    expect(body.schedule).toMatchObject({ type: 'cron', expression: '55 23 * * *' });
    expect(typeof body.schedule.timezone).toBe('string');
    expect(body.vault_ids).toEqual(['vault-1']);
    expect(body.resources).toEqual([{ type: 'memory_store', memory_store_id: 'store-1', access: 'read' }]);
    expect(mockDepIdSet).toHaveBeenCalledWith('dep-new');
  });

  it('adopts an existing same-name deployment instead of creating a duplicate', async () => {
    apiFetch((path, init) => {
      if (path === '/deployments' && !init?.method)
        return { ok: true, status: 200, json: { data: [{ id: 'dep-found', name: 'pixel-agent-daily-report' }] } };
      return { ok: true, status: 200 };
    });
    await syncDeployment();
    expect(mockDepIdSet).toHaveBeenCalledWith('dep-found');
    expect(mockApi.mock.calls.map((c) => c[1])).toEqual(['/deployments']); // 查重命中即止,不创建
  });
});
