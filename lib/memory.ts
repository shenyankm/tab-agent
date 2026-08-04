// 云端记忆镜像:本地摘录(IndexedDB,唯一事实源)→ Qoder Memory Store(最佳努力镜像)。
// 失败只影响云端,永不触碰本地数据;默认关闭,由 memorySyncItem 控制。
//
// 用户云端 Agent 的 system prompt 追加块(粘贴到其 Qoder Agent 配置):
//   你有一个随会话挂载的摘录知识库,位于工作区 /data/.qoder/awareness/ 目录(每个记忆一个 .md 文件):
//   - 当问题涉及用户历史摘录、收藏、或"我记得保存过"等表述时,先用 ls/grep 搜索该目录,读取相关文件后再回答。
//   - 记忆文件格式约定:# 标题 / url / category / tags / created(ISO 日期)/ 正文 / Notes(备注)。
//   - 引用摘录内容时标注其来源 URL。
//   - 该目录属用户私有数据:不得把摘录原文写入其他文件,不得输出与问题无关的摘录全文。
//   - 你被授予 read_write:用户明确说"记住 X"时可在 awareness/ 下新建记忆文件,但不要修改 clips/ 前缀的文件(由扩展自动维护)。
import { api } from '@/lib/gateway';
import { patItem, memoryStoreIdItem, memoryMapItem, memorySyncItem } from '@/lib/settings';
import { getClipsDirect, type Clip } from '@/lib/clips-store';
import { getUsage, toMarkdown } from '@/lib/usage';

/** 会话创建时下发给云端 Agent 的记忆使用说明(resources.instructions)。 */
export const MEMORY_INSTRUCTIONS =
  '这是用户的摘录知识库(Memory Store)。涉及用户保存过的摘录、收藏或历史浏览内容时,先读取 /data/.qoder/awareness/ 下的记忆文件再回答。摘录文件为 Markdown:标题、来源 URL、分类、标签、创建时间、正文与备注。记忆属于用户私有数据,不得在会话外引用或转述全文。';

const STORE_NAME = 'pixel-agent-memory';

/** 按名查找 Store,无则创建;id 缓存到 memoryStoreIdItem。
 *  ponytail: 创建竞态最坏产生重复 Store(仅缓存的那个被挂载,无害);多端并发时再上锁 */
export async function ensureMemoryStore(pat: string): Promise<string> {
  const cached = await memoryStoreIdItem.getValue();
  if (cached) return cached;
  const res = await api(pat, '/memory_stores', { method: 'GET' });
  if (!res.ok) throw new Error(`list memory stores: HTTP ${res.status}`);
  const stores = (await res.json()) as { id?: string; name?: string }[];
  let store = stores.find((s) => s.name === STORE_NAME);
  if (!store) {
    const created = await api(pat, '/memory_stores', {
      method: 'POST',
      body: JSON.stringify({ name: STORE_NAME, description: 'Pixel Agent 摘录知识库' }),
    });
    if (!created.ok) throw new Error(`create memory store: HTTP ${created.status}`);
    store = (await created.json()) as { id?: string };
  }
  if (typeof store.id !== 'string') throw new Error('memory store reply missing id');
  await memoryStoreIdItem.setValue(store.id);
  return store.id;
}

/** 摘录 → 记忆 Markdown;字段扁平可 grep,agent 无需工具即可解析。 */
export function clipToMemory(c: Clip): string {
  const head = [
    `# ${c.title}`,
    `- url: ${c.pageUrl}`,
    `- category: ${c.category ?? ''}`,
    `- tags: ${c.tags?.join(', ') ?? ''}`,
    `- created: ${new Date(c.createdAt).toISOString()}`,
  ].join('\n');
  const notes = c.notes?.length ? `\n## Notes\n- ${c.notes.join('\n- ')}` : '';
  // 兜底:正文已 20KB 截断(TEXT_CAP),防超长备注击穿云端 100KB 上限
  return (head + '\n\n' + c.text + notes).slice(0, 100_000);
}

/** 单条 upsert:有 memoryId → 更新,无 → 创建并回写映射。
 *  单用户场景省略 content_sha256(文档:省略即跳过乐观锁);多端写再补读回 + 409 重试 */
export async function syncClipToMemoryStore(pat: string, storeId: string, clip: Clip): Promise<boolean> {
  const content = clipToMemory(clip);
  const map = await memoryMapItem.getValue();
  const memoryId = map[clip.id];
  const res = memoryId
    ? await api(pat, `/memory_stores/${storeId}/memories/${memoryId}`, {
        method: 'POST',
        body: JSON.stringify({ content }),
      })
    : await api(pat, `/memory_stores/${storeId}/memories`, {
        method: 'POST',
        body: JSON.stringify({ path: `clips/${clip.id}.md`, content }),
      });
  if (!res.ok) return false;
  if (!memoryId) {
    const data = (await res.json()) as { id?: string };
    if (typeof data.id !== 'string') return false;
    await memoryMapItem.setValue({ ...map, [clip.id]: data.id });
  }
  return true;
}

/** 删除摘录时同步删除云端镜像;map 无条目(未同步/已删)直接 no-op。 */
export async function deleteClipFromMemoryStore(clipId: string): Promise<void> {
  const map = await memoryMapItem.getValue();
  const memoryId = map[clipId];
  if (!memoryId) return;
  const pat = await patItem.getValue();
  if (!pat) return;
  const res = await api(pat, `/memory_stores/${await ensureMemoryStore(pat)}/memories/${memoryId}`, {
    method: 'DELETE',
  });
  if (!res.ok) throw new Error(`delete memory: HTTP ${res.status}`);
  const { [clipId]: _gone, ...rest } = map;
  await memoryMapItem.setValue(rest);
}

/** 写入后自动镜像单条摘录(新增/更新钩子用):开关关或无 PAT 时 no-op,失败由调用方静默。 */
export async function mirrorClip(clip: Clip): Promise<void> {
  if (!(await memorySyncItem.getValue())) return;
  const pat = await patItem.getValue();
  if (!pat) return;
  await syncClipToMemoryStore(pat, await ensureMemoryStore(pat), clip);
}

/** 全量镜像:无 PAT → 0;逐条同步,单条失败不阻断其余(部分成功 = 返回值)。 */
export async function syncAllClipsToMemoryStore(): Promise<number> {
  const pat = await patItem.getValue();
  if (!pat) return 0;
  const storeId = await ensureMemoryStore(pat);
  const clips = await getClipsDirect();
  let synced = 0;
  for (const clip of clips) {
    try {
      if (await syncClipToMemoryStore(pat, storeId, clip)) synced++;
    } catch {
      // 单条失败(网络/auth/写回)只影响镜像,本地 IDB 是事实源
    }
  }
  return synced;
}

/** 当日使用日志 upsert 到 usage/<day>.md(日报 Deployment 的数据源)。
 *  best-effort:失败静默,下一回合重写即自愈。map key 前缀 usage: 与 clip id 不冲突。 */
export async function syncUsageToMemoryStore(day: string): Promise<void> {
  const pat = await patItem.getValue();
  if (!pat) return;
  const storeId = await ensureMemoryStore(pat);
  const content = toMarkdown(day, await getUsage(day));
  const map = await memoryMapItem.getValue();
  const mapKey = `usage:${day}`;
  const memoryId = map[mapKey];
  const res = memoryId
    ? await api(pat, `/memory_stores/${storeId}/memories/${memoryId}`, {
        method: 'POST',
        body: JSON.stringify({ content }),
      })
    : await api(pat, `/memory_stores/${storeId}/memories`, {
        method: 'POST',
        body: JSON.stringify({ path: `usage/${day}.md`, content }),
      });
  if (!res.ok) return;
  if (!memoryId) {
    const data = (await res.json()) as { id?: string };
    if (typeof data.id === 'string') await memoryMapItem.setValue({ ...map, [mapKey]: data.id });
  }
}
