// 每日日报：云端 Deployment（cron 23:55，用户时区）到点自动起一个专属 session，
// 从 Memory Store 读当日 usage 日志与摘录，总结后经 notion MCP 写入用户的 Notion 数据库。
// 浏览器关闭也照常执行——扩展侧只做 Deployment 的幂等收敛管理与"立即生成"入口。
import { api } from '@/lib/gateway';
import { ensureMemoryStore } from '@/lib/memory';
import {
  patItem, agentIdItem, envIdItem, vaultIdItem,
  dailyReportItem, notionDbIdItem, deploymentIdItem,
} from '@/lib/settings';

const DEPLOYMENT_NAME = 'pixel-agent-daily-report';

/** Deployment 的 initial_events 指令；设置页"立即生成"的手动回合也复用它 */
export function buildInstruction(notionDbId: string): string {
  return [
    '你在为 Pixel Agent 生成每日使用日报。步骤：',
    '1. 用 shell 取当天日期（date +%F），在 /data/.qoder/awareness/ 目录下找 usage/<日期>.md 文件；',
    '2. 若该文件不存在，说明当天没有使用记录：只回复"今日无记录"并结束，不要创建任何 Notion 页面；',
    '3. 若存在，读取该文件（内含当日对话摘要与统计），可参考同目录下相关摘录，撰写一份简明的中文日报；',
    `4. 用 notion MCP 工具在 Notion 数据库 ${notionDbId} 中新建页面，标题为"Pixel Agent 日报 <日期>"，内容为日报正文。`,
  ].join('\n');
}

const initialEvents = (dbId: string) =>
  [{ type: 'user.message', content: [{ type: 'text', text: buildInstruction(dbId) }] }];

/** 幂等收敛：Deployment 状态与设置一致（开 → 创建/更新并激活，关或缺配置 → 暂停）。
 *  ponytail: 多设备并发创建竞态最坏产生重复 Deployment（创建前已按 name 查重，残留的那个手动暂停即可） */
export async function syncDeployment(): Promise<void> {
  const [on, pat, agentId, envId, vaultId, dbId, depId] = await Promise.all([
    dailyReportItem.getValue(),
    patItem.getValue(),
    agentIdItem.getValue(),
    envIdItem.getValue(),
    vaultIdItem.getValue(),
    notionDbIdItem.getValue(),
    deploymentIdItem.getValue(),
  ]);
  if (!on || !pat || !agentId || !envId || !dbId) {
    // 已暂停的再 pause 会 409——收敛语义下吞掉即可
    if (depId && pat) await api(pat, `/deployments/${depId}/pause`, { method: 'POST' }).catch(() => {});
    return;
  }

  // merge-patch 更新指令（Notion DB ID 可能变了）并确保处于激活状态
  const revive = async (id: string) => {
    await api(pat, `/deployments/${id}`, {
      method: 'POST',
      body: JSON.stringify({ initial_events: initialEvents(dbId) }),
    });
    await api(pat, `/deployments/${id}/unpause`, { method: 'POST' }).catch(() => {});
  };

  if (depId) return revive(depId);

  // 按 name 查重：多设备各自首开开关时不要各建一个
  const list = await api(pat, '/deployments');
  if (list.ok) {
    const hit = ((await list.json()) as { data?: { id: string; name: string }[] }).data
      ?.find((d) => d.name === DEPLOYMENT_NAME);
    if (hit) {
      await deploymentIdItem.setValue(hit.id);
      return revive(hit.id);
    }
  }

  const storeId = await ensureMemoryStore(pat);
  const res = await api(pat, '/deployments', {
    method: 'POST',
    body: JSON.stringify({
      name: DEPLOYMENT_NAME,
      description: 'Pixel Agent 每日使用总结，写入 Notion',
      agent: { id: agentId, type: 'agent' },
      environment_id: envId,
      schedule: {
        type: 'cron',
        expression: '55 23 * * *',
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      },
      initial_events: initialEvents(dbId),
      // notion MCP 的 OAuth 凭证在 vault 里：不挂 vault，MCP 工具鉴权失败
      ...(vaultId ? { vault_ids: [vaultId] } : {}),
      // 日报 session 只读记忆库（usage 日志 + 摘录镜像）
      resources: [{ type: 'memory_store', memory_store_id: storeId, access: 'read' }],
    }),
  });
  if (!res.ok) throw new Error(`create deployment: HTTP ${res.status}`);
  const data = (await res.json()) as { id?: string };
  if (typeof data.id !== 'string') throw new Error('create deployment: reply missing id');
  await deploymentIdItem.setValue(data.id);
}
