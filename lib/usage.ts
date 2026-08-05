// 每日使用日志：当天聊天/摘录活动的轻量记录，是日报总结的数据源；
// 本地保留 7 天（= 数据备份窗口）。所有写入静默失败——附属数据不得影响主流程。
// 无 DOM 依赖：background bundles 本模块。

type UsageChat = { t: number; q: string; a: string };
export type UsageDay = {
  turns: number;
  clipsAdded: number;
  chats: UsageChat[];
};

const EMPTY: UsageDay = { turns: 0, clipsAdded: 0, chats: [] };
const MAX_CHATS = 50; // 截断上限：storage 配额有限，总结够用即可
const KEEP_DAYS = 7;

/** 本地时区 YYYY-MM-DD（en-CA 格式天然可按字符串比较先后） */
export const today = () => new Date().toLocaleDateString('en-CA');

const key = (day: string) => `local:usage.${day}` as const;

export async function getUsage(day: string): Promise<UsageDay> {
  return (await storage.getItem<UsageDay>(key(day))) ?? EMPTY;
}

async function update(fn: (u: UsageDay) => void) {
  try {
    const k = key(today());
    const u = (await storage.getItem<UsageDay>(k)) ?? { ...EMPTY, chats: [] };
    fn(u);
    await storage.setItem(k, u);
  } catch {
    /* 附属数据写失败静默：主流程（聊天/摘录）零耦合 */
  }
}

export const logChat = (q: string, a: string) => update((u) => {
  u.turns++;
  if (u.chats.length < MAX_CHATS)
    u.chats.push({ t: Date.now(), q: q.slice(0, 200), a: a.slice(0, 500) });
});

export const logClipAdded = () => update((u) => { u.clipsAdded++; });

/** 日志 → Markdown：字段扁平，云端 Agent 无需工具即可读懂 */
export function toMarkdown(day: string, u: UsageDay): string {
  const lines = [
    `# ${day} 使用记录`,
    `- 聊天回合: ${u.turns}`,
    `- 新增摘录: ${u.clipsAdded}`,
    '',
  ];
  if (u.chats.length) {
    lines.push('## 对话摘要');
    for (const c of u.chats) {
      lines.push(
        `### ${new Date(c.t).toLocaleTimeString()}`,
        `- 问: ${c.q}`,
        `- 答: ${c.a}`,
        '',
      );
    }
  }
  // 兜底：云端单条 memory 上限 100KB
  return lines.join('\n').slice(0, 100_000);
}

const shiftDay = (from: string, delta: number) => {
  const [y, m, d] = from.split('-').map(Number);
  // 按年月日分量构造本地日期再偏移：直接 new Date('YYYY-MM-DD') 是 UTC 午夜，
  // 负时区偏移下 getDate() 会退回前一天
  return new Date(y, m - 1, d + delta).toLocaleDateString('en-CA');
};

/** 删除保留窗口外的 usage key；worker 每次启动调一次即可。
 *  ponytail: WXT storage 无法枚举 key，改为枚举候选日期逐个删（不存在的 key 是 no-op）；
 *  窗口外的第 31 天起不再清理，残留条目极小（每天一条截断日志），可忽略 */
export async function purgeOld() {
  try {
    for (let i = KEEP_DAYS + 1; i <= KEEP_DAYS + 30; i++)
      await storage.removeItem(key(shiftDay(today(), -i)));
  } catch {
    /* 清理失败无害：下次启动重试 */
  }
}
