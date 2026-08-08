// 懒加载 chunk 桥:WXT 的 content script 强制 IIFE,动态 import 会被内联,
 // 真正的拆分 = unlisted entrypoint(entrypoints/agent-*.ts 各打成独立文件)
 // + 经 background 的 scripting.executeScript 按需注入同一隔离世界。
 // 桥注册表与在途加载 Map 都挂 globalThis:主包与 chunk 是独立模块图,
 // 模块级单例会每图一份,导致重复注入或读到空桥。
import { sendRequest } from '@/lib/messages';

export type ChunkName = 'agent-marks' | 'agent-pagetext' | 'agent-ui';

export type MarksChunk = {
  marks: typeof import('@/lib/marks');
  highlight: typeof import('@/lib/clips-highlight');
};
export type PageTextChunk = { pageText: typeof import('@/lib/page-text').pageText };
export type UiChunk = {
  mountFloatingAgent: typeof import('@/components/floating-agent').mountFloatingAgent;
};

type Bridge = Partial<Record<ChunkName, unknown>>;
const g = globalThis as {
  __tabAgentBridge?: Bridge;
  __tabAgentChunks?: Map<ChunkName, Promise<unknown>>;
};
const bridge = () => (g.__tabAgentBridge ??= {});
const loads = () => (g.__tabAgentChunks ??= new Map());

function loadChunk<T>(name: ChunkName): Promise<T> {
  const registered = bridge()[name];
  if (registered) return Promise.resolve(registered as T);
  let p = loads().get(name);
  if (!p) {
    p = sendRequest<void>({ type: 'chunkLoad', name }).then(() => {
      // executeScript resolve 时脚本已同步执行完,桥必然就位;缺桥=注入失败
      const mod = bridge()[name];
      if (!mod) throw new Error(`chunk ${name} did not register`);
      return mod;
    });
    // 失败(上下文失效/SW 错误)不留缓存,下次调用重试
    p.catch(() => { if (loads().get(name) === p) loads().delete(name); });
    loads().set(name, p);
  }
  return p as Promise<T>;
}

export const loadMarksChunk = () => loadChunk<MarksChunk>('agent-marks');
export const loadPageTextChunk = () => loadChunk<PageTextChunk>('agent-pagetext');
export const loadUiChunk = () => loadChunk<UiChunk>('agent-ui');
