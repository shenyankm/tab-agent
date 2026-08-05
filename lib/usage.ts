// 日期工具：会话缓存按日轮换（gateway.ts）与日报归属日均以本地时区 YYYY-MM-DD 为准。
// 无 DOM 依赖：background bundles 本模块。

/** 本地时区 YYYY-MM-DD（en-CA 格式天然可按字符串比较先后） */
export const today = () => new Date().toLocaleDateString('en-CA');
