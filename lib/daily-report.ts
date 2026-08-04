// 每日日报：后端默认行为，无前端开关。云端 Deployment（cron 23:55，用户时区）
// 到点自动起一个专属 session，从 Memory Store 读当日 usage 日志与摘录，总结后
// 经 notion MCP 写入 Notion——目标数据库在用户的云端 Agent 配置里指定。
// 浏览器关闭也照常执行；扩展侧只负责确保 Deployment 存在。
import { api } from '@/lib/gateway';
import { ensureMemoryStore } from '@/lib/memory';
import { patItem, agentIdItem, envIdItem, vaultIdItem, deploymentIdItem } from '@/lib/settings';

const DEPLOYMENT_NAME = 'tab-agent-daily-report';

/** Deployment 的 initial_events 指令：Notion 目标库由 Agent 侧配置决定，指令不内嵌 */
export function buildInstruction(): string {
  return [
    '你在为 Tab Agent 生成每日使用日报。步骤：',
    '1. 用 shell 取当天日期（date +%F），在 /data/.qoder/awareness/ 目录下找 usage/<日期>.md 文件；',
    '2. 若该文件不存在，说明当天没有使用记录：只回复"今日无记录"并结束，不要创建任何 Notion 页面；',
    '3. 若存在，读取该文件（内含当日对话摘要与统计），可参考同目录下相关摘录，撰写一份简明的中文日报；',
    '4. 用 notion MCP 工具在你被配置写入的 Notion 数据库中新建页面，标题为"Tab Agent 日报 <日期>"，内容为日报正文。',
  ].join('\n');
}

/** 确保日报 Deployment 存在：幂等。已缓存 id → 零网络返回（指令是静态文本，
 *  建好后无需 patch）；未配置凭证 → 静默返回，下次 worker 启动重试。
 *  ponytail: 缓存的 Deployment 若在云端被手动删除不会自动重建，清 deploymentIdItem 缓存即可；
 *  多设备并发创建竞态最坏产生重复 Deployment（创建前已按 name 查重，残留的手动归档即可） */
export async function syncDeployment(): Promise<void> {
  if (await deploymentIdItem.getValue()) return;
  const [pat, agentId, envId, vaultId] = await Promise.all([
    patItem.getValue(),
    agentIdItem.getValue(),
    envIdItem.getValue(),
    vaultIdItem.getValue(),
  ]);
  if (!pat || !agentId || !envId) return;

  // 按 name 查重：多设备各自首次启动时不要各建一个
  const list = await api(pat, '/deployments');
  if (list.ok) {
    const hit = ((await list.json()) as { data?: { id: string; name: string }[] }).data
      ?.find((d) => d.name === DEPLOYMENT_NAME);
    if (hit) return deploymentIdItem.setValue(hit.id);
  }

  const storeId = await ensureMemoryStore(pat);
  const res = await api(pat, '/deployments', {
    method: 'POST',
    body: JSON.stringify({
      name: DEPLOYMENT_NAME,
      description: 'Tab Agent 每日使用总结，写入 Notion',
      agent: { id: agentId, type: 'agent' },
      environment_id: envId,
      schedule: {
        type: 'cron',
        expression: '55 23 * * *',
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      },
      initial_events: [{ type: 'user.message', content: [{ type: 'text', text: buildInstruction() }] }],
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
