// 按需 chunk:摘录定位/高亮(text-fragments-polyfill)+ fragment URL 生成。
// 仅在有摘录重放/落地/保存时经 scripting.executeScript 注入(lib/lazy.ts)。
import * as marks from '@/lib/marks';
import * as highlight from '@/lib/clips-highlight';

export default defineUnlistedScript(() => {
  const g = globalThis as { __tabAgentBridge?: Record<string, unknown> };
  const bridge = (g.__tabAgentBridge ??= {});
  // 重复注入(加载竞态)不重建模块状态:markByClip/fadeTimers 重建会丢掉在页 mark 的账本
  bridge['agent-marks'] ??= { marks, highlight };
});
