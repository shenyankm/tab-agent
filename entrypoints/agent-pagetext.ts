// 按需 chunk:Readability 页面正文提取。仅在聊天携带正文/整页剪藏时注入(lib/lazy.ts)。
import { pageText } from '@/lib/page-text';

export default defineUnlistedScript(() => {
  const g = globalThis as { __tabAgentBridge?: Record<string, unknown> };
  const bridge = (g.__tabAgentBridge ??= {});
  bridge['agent-pagetext'] ??= { pageText };
});
