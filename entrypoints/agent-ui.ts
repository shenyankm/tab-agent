// 按需 chunk:悬浮代理 UI(React 全家桶)。仅在宠物开启时注入(lib/lazy.ts)。
import { mountFloatingAgent } from '@/components/floating-agent';

export default defineUnlistedScript(() => {
  const g = globalThis as { __tabAgentBridge?: Record<string, unknown> };
  const bridge = (g.__tabAgentBridge ??= {});
  bridge['agent-ui'] ??= { mountFloatingAgent };
});
