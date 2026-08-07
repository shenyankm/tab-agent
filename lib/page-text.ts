import { Readability } from '@mozilla/readability';

// Readability mutates its input, so it gets a clone; null/throw (non-article pages,
// framesets) falls back to raw innerText. article.textContent is plain text — the
// page context goes into an LLM prompt, no markdown conversion needed.
// keyed by URL with a mutation generation: same-URL DOM changes (SPA-loaded content)
// invalidate the cache via a debounced MutationObserver so LLM prompts see fresh text
let pageTextCache: { url: string; text: string } | null = null;
let textGen = 0, textGenAt = 0;
let observerStarted = false;

function ensureObserver() {
  if (observerStarted || typeof document === 'undefined') return;
  observerStarted = true;
  let timer: ReturnType<typeof setTimeout> | null = null;
  // 扩展自己插入的 <mark>(text-fragments-polyfill 带特征 class)会触发结构变化,
  // 页面正文并未改变——整批变化都落在自己的 mark 内时不让缓存失效,
  // 否则保存/重放摘录的瞬间缓存就被废掉,下次提问重跑整页 Readability。
  // 注意 childList 突变的 target 是 mark 的父元素而非 mark 本身,
  // 必须检查 addedNodes/removedNodes 才能识别"自己的变化"。
  // nodeType 用数字字面量:环境 teardown 后残留的 observer microtask 里
  // 全局 Element/Node 已不可用,instanceof 会抛 ReferenceError
  const inOwnMark = (n: Node) => {
    const el = n.nodeType === 1 ? (n as Element) : n.parentElement;
    return !!el?.closest?.('mark.text-fragments-polyfill-target-text');
  };
  const own = (m: MutationRecord) =>
    m.type === 'characterData'
      ? inOwnMark(m.target)
      : [...m.addedNodes, ...m.removedNodes].every(inOwnMark);
  const obs = new MutationObserver((muts) => {
    if (muts.every(own)) return;
    if (timer) return;
    timer = setTimeout(() => { textGen++; timer = null; }, 1000);
  });
  if (document.body) obs.observe(document.body, { childList: true, subtree: true, characterData: true });
  else document.addEventListener('DOMContentLoaded', () => obs.observe(document.body, { childList: true, subtree: true, characterData: true }), { once: true });
}
export function pageText() {
  ensureObserver();
  const url = location.href.split('#', 1)[0];
  if (pageTextCache?.url === url && textGen === textGenAt) return pageTextCache.text;
  let text: string | undefined;
  try {
    const article = new Readability(document.cloneNode(true) as Document).parse();
    if (article?.textContent) text = article.textContent;
  } catch { /* fall through */ }
  // innerText forces a synchronous layout of the whole page — only pay it as the fallback
  text ??= document.body.innerText;
  // cache the capped form: consumers slice(0, 20000/500) anyway, and a huge page's
  // full text would sit in this module-level cache forever
  const capped = text.slice(0, 20000);
  pageTextCache = { url, text: capped };
  textGenAt = textGen;
  return capped;
}
