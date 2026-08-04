import { Readability } from '@mozilla/readability';

// Readability mutates its input, so it gets a clone; null/throw (non-article pages,
// framesets) falls back to raw innerText. article.textContent is plain text — the
// page context goes into an LLM prompt, no markdown conversion needed.
// keyed by URL with a mutation generation: same-URL DOM changes (SPA-loaded content)
// invalidate the cache via a debounced MutationObserver so LLM prompts see fresh text
let pageTextCache: { url: string; text: string } | null = null;
let textGen = 0, textGenAt = 0;
if (typeof document !== 'undefined') {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const obs = new MutationObserver(() => {
    if (timer) return;
    timer = setTimeout(() => { textGen++; timer = null; }, 1000);
  });
  if (document.body) obs.observe(document.body, { childList: true, subtree: true, characterData: true });
  else document.addEventListener('DOMContentLoaded', () => obs.observe(document.body, { childList: true, subtree: true, characterData: true }), { once: true });
}
export function pageText() {
  if (pageTextCache?.url === location.href && textGen === textGenAt) return pageTextCache.text;
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
  pageTextCache = { url: location.href, text: capped };
  textGenAt = textGen;
  return capped;
}
