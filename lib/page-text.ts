import { Readability } from '@mozilla/readability';

// ponytail: everything ships eagerly — WXT bundles content scripts as one IIFE and
// inlines dynamic imports (verified: lazy-loading grew the bundle); revisit if WXT
// ever supports content-script code splitting

// Readability mutates its input, so it gets a clone; null/throw (non-article pages,
// framesets) falls back to raw innerText. article.textContent is plain text — the
// page context goes into an LLM prompt, no markdown conversion needed.
// ponytail: keyed by URL — same-URL DOM changes (SPA-loaded content) go stale;
// invalidate on mutation reports if summaries ever lag the page
let pageTextCache: { url: string; text: string } | null = null;
export function pageText() {
  if (pageTextCache?.url === location.href) return pageTextCache.text;
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
  return capped;
}
