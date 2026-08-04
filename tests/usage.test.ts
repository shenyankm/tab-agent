import { describe, it, expect, vi, beforeEach } from 'vitest';

const { storeMap } = vi.hoisted(() => ({ storeMap: new Map<string, unknown>() }));

vi.mock('wxt/utils/storage', () => ({
  storage: {
    getItem: (k: string) => Promise.resolve(storeMap.get(k) ?? null),
    setItem: (k: string, v: unknown) => { storeMap.set(k, v); return Promise.resolve(); },
    removeItem: (k: string) => { storeMap.delete(k); return Promise.resolve(); },
  },
}));

const { logChat, logClipAdded, logClassified, getUsage, toMarkdown, purgeOld, today } =
  await import('@/lib/usage');

const dayKey = (day: string) => `local:usage.${day}`;

// log* 是 fire-and-forget(静默失败语义):断言前让出微任务等写入落地
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

beforeEach(() => storeMap.clear());

describe('usage log', () => {
  it('logChat counts turns and truncates question/answer', async () => {
    logChat('q'.repeat(500), 'a'.repeat(1000));
    await flush();
    const u = await getUsage(today());
    expect(u.turns).toBe(1);
    expect(u.chats[0].q).toHaveLength(200);
    expect(u.chats[0].a).toHaveLength(500);
  });

  it('caps the stored chats at 50 while turns keep counting', async () => {
    for (let i = 0; i < 51; i++) { logChat('q', 'a'); await flush(); }
    const u = await getUsage(today());
    expect(u.turns).toBe(51);
    expect(u.chats).toHaveLength(50);
  });

  it('clip and classify counters accumulate on the same day', async () => {
    logClipAdded();
    await flush(); // 读-改-写是 fire-and-forget：串行发出才不丢更新（真实钩子间隔秒级）
    logClipAdded();
    await flush();
    logClassified();
    await flush();
    const u = await getUsage(today());
    expect(u.clipsAdded).toBe(2);
    expect(u.classified).toBe(true);
  });

  it('getUsage returns empty shape for an unknown day', async () => {
    expect(await getUsage('2000-01-01')).toEqual({ turns: 0, clipsAdded: 0, classified: false, chats: [] });
  });

  it('toMarkdown carries the stats and chat digest', async () => {
    logChat('什么是量子计算', '量子计算利用量子比特…');
    await flush();
    const md = toMarkdown(today(), await getUsage(today()));
    expect(md).toContain(`# ${today()} 使用记录`);
    expect(md).toContain('聊天回合: 1');
    expect(md).toContain('问: 什么是量子计算');
  });
});

describe('purgeOld', () => {
  it('removes keys outside the retention window and keeps recent ones', async () => {
    // purge 只扫 8–37 天窗口（候选日期枚举法，见实现 ponytail 注释）
    const stale = (days: number) =>
      new Date(Date.now() - days * 86_400_000).toLocaleDateString('en-CA');
    storeMap.set(dayKey(stale(10)), { turns: 1 }); // 窗口内：应被清理
    storeMap.set(dayKey(today()), { turns: 1 });
    storeMap.set('local:unrelated', 1);
    await purgeOld();
    expect(storeMap.has(dayKey(stale(10)))).toBe(false);
    expect(storeMap.has(dayKey(today()))).toBe(true);
    expect(storeMap.has('local:unrelated')).toBe(true);
  });
});
