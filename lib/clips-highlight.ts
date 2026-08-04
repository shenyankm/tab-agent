// Clip highlight half: text-fragment URL generation + on-page locating/marking.
// DOM- and polyfill-dependent — imported by the content script only; background
// and options must use clips-store.ts (keeps the polyfill out of their bundles).
import {
  generateFragment,
  GenerateFragmentStatus,
  type TextFragment,
} from 'text-fragments-polyfill/dist/fragment-generation-utils.js';
import {
  getFragmentDirectives,
  markRange,
  parseFragmentDirectives,
  processTextFragmentDirective,
  removeMarks,
} from 'text-fragments-polyfill/text-fragment-utils';
import { stripHash, type Clip } from './clips-store';

// the fragment directive reserves "-" "," "&"; encodeURIComponent leaves "-" alone
const enc = (s: string) => encodeURIComponent(s).replace(/-/g, '%2D');

const fragmentDirective = (f: TextFragment) =>
  '#:~:text=' +
  (f.prefix ? `${enc(f.prefix)}-,` : '') +
  enc(f.textStart) +
  (f.textEnd ? `,${enc(f.textEnd)}` : '') +
  (f.suffix ? `,-${enc(f.suffix)}` : '');

/** Build the clip's target URL — same algorithm as Chrome's "Copy link to highlight". */
export function buildClipUrl(pageUrl: string, selection: Selection): string {
  const base = stripHash(pageUrl);
  try {
    const { status, fragment } = generateFragment(selection);
    if (status === GenerateFragmentStatus.SUCCESS && fragment)
      return base + fragmentDirective(fragment);
  } catch {
    /* fall through to naive */
  }
  // naive single-term fragment: fallback when generateFragment can't disambiguate
  const text = selection.toString().trim();
  return text ? `${base}#:~:text=${enc(text)}` : base; // bare URL: opens page top, no highlight
}

// generateFragment expands the selection to word bounds per spec (Intl.Segmenter:
// CJK 「下表」 is one word, so selecting from 「表」 pulls in 「下」). The URL
// keeps the word-bounded fragment (matching requires it) — but the visible marks
// must cover only what the user actually selected, so shrink the range to clip.text.
function trimRangeToText(range: Range, text: string) {
  const s = range.toString();
  const i = s.indexOf(text);
  if (i < 0 || s.length === text.length) return; // whitespace drift: keep the word-bounded match
  const walker = document.createTreeWalker(range.commonAncestorContainer, NodeFilter.SHOW_TEXT);
  let pos = 0;
  // a same-text-node range has a Text commonAncestor, which nextNode() never yields
  let node: Node | null = range.commonAncestorContainer.nodeType === Node.TEXT_NODE
    ? range.commonAncestorContainer
    : walker.nextNode();
  for (; node; node = walker.nextNode()) {
    if (!range.intersectsNode(node)) continue;
    // in-range slice of this node, against the original boundaries
    const from = node === range.startContainer ? range.startOffset : 0;
    const to = node === range.endContainer ? range.endOffset : (node as Text).data.length;
    if (i >= pos && i < pos + (to - from)) range.setStart(node, from + i - pos);
    const end = i + text.length;
    if (end > pos && end <= pos + (to - from)) {
      range.setEnd(node, from + end - pos);
      return;
    }
    pos += to - from;
  }
}

// script/style 等子树的文本节点不属于正文,命中会向脚本字符串插 <mark>(篡改页面)
const SKIP_TEXT_PARENTS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE']);

/** 兜底定位:文本片段失配(页面改动/动态渲染)时按 clip.text 在全文中查找
 * (textQuote 式重锚思路的简化版);多实例用 fragment 的
 * prefix/suffix 上下文消解,无吻合再退回第一个命中。
 * ponytail: 全文拼接 indexOf,命中可能跨元素边界;上下文仅空白归一后精确匹配——兜底路径,模糊匹配等失配报告再说 */

// (nodes, full) 文本索引缓存:一批 fragment 失效的 clip 重放集中在 ~2s 的空闲切片内,
// 逐条重建等于每条一次全树 TreeWalker。TTL + 首节点连通性界定失效(SPA 导航后旧节点
// 失连即重建);动态 DOM 的最坏情况是一次兜底失配,与逐条快照同量级
let textIndex: { nodes: Text[]; full: string; at: number } | null = null;

function getTextIndex(): { nodes: Text[]; full: string } {
  if (textIndex && Date.now() - textIndex.at < 3000 && textIndex.nodes[0]?.isConnected !== false)
    return textIndex;
  const nodes: Text[] = [];
  let full = '';
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node: Node | null; (node = walker.nextNode()); ) {
    if (SKIP_TEXT_PARENTS.has((node.parentElement as HTMLElement | null)?.tagName ?? '')) continue;
    nodes.push(node as Text);
    full += (node as Text).data;
  }
  textIndex = { nodes, full, at: Date.now() };
  return textIndex;
}

// 命中上下文比对:不再 slice 全文做归一(O(页面)/候选),从命中点向前/后走原始文本,
// 一段空白折叠为一个空格——O(上下文长度)/候选,语义与 norm(s)=replace(/\s+/g,' ').trim()
// 后的 endsWith/startsWith 一致(np/ns 已 trim,比对端不携带首尾空白)
function endsWithNorm(raw: string, end: number, np: string): boolean {
  let i = end - 1;
  let j = np.length - 1;
  while (i >= 0 && /\s/.test(raw[i])) i--; // 结尾空白归一化后消失
  while (i >= 0 && j >= 0) {
    if (/\s/.test(raw[i])) {
      if (np[j] !== ' ') return false; // 一段原始空白折叠成单个空格
      while (i >= 0 && /\s/.test(raw[i])) i--;
      j--;
    } else {
      if (raw[i] !== np[j]) return false;
      i--;
      j--;
    }
  }
  return j < 0;
}

function startsWithNorm(raw: string, start: number, ns: string): boolean {
  let i = start;
  let j = 0;
  while (i < raw.length && /\s/.test(raw[i])) i++;
  while (i < raw.length && j < ns.length) {
    if (/\s/.test(raw[i])) {
      if (ns[j] !== ' ') return false;
      while (i < raw.length && /\s/.test(raw[i])) i++;
      j++;
    } else {
      if (raw[i] !== ns[j]) return false;
      i++;
      j++;
    }
  }
  return j === ns.length;
}

function findTextRange(text: string, prefix?: string, suffix?: string): Range | null {
  const q = text.trim();
  if (!q || !document.body) return null; // all_urls 匹配的 XML/SVG 页可能无 body
  const { nodes, full } = getTextIndex();
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
  const np = prefix && norm(prefix);
  const ns = suffix && norm(suffix);
  const at = (i: number): Range => {
    // 偏移映射回节点:node 在 full 中起点 = 其之前各节点长度之和。
    // start/end 各自定位:命中可跨多个文本节点(如 <p>hello <b>world</b></p>),
    // 塞进单节点会让 setEnd 偏移越界抛 IndexSizeError
    const locate = (pos: number): [Text, number] => {
      let base = 0, n = 0;
      while (n < nodes.length - 1 && base + nodes[n].data.length <= pos) base += nodes[n++].data.length;
      return [nodes[n], pos - base];
    };
    const r = document.createRange();
    r.setStart(...locate(i));
    r.setEnd(...locate(i + q.length));
    return r;
  };
  let first: Range | null = null;
  for (let i = full.indexOf(q); i >= 0; i = full.indexOf(q, i + q.length)) {
    first ??= at(i);
    // 命中与上下文之间可能隔着空白,归一后比对
    if (np && !endsWithNorm(full, i, np)) continue;
    if (ns && !startsWithNorm(full, i + q.length, ns)) continue;
    return at(i);
  }
  return first; // 无上下文吻合:退回首个命中(旧行为)
}

/** Locate the clip's text on the current page and wrap it in <mark>s; [] if not found. */
export function highlightClip(clip: Clip): Element[] {
  if (clip.kind === 'image' && clip.imageSrc) {
    // exact src match first (lazy-load/srcset variants miss on the exact path,
    // so fall back to hostname+pathname normalization for those)
    const imgs = [...document.images];
    let el = imgs.find((img) => img.src === clip.imageSrc || img.currentSrc === clip.imageSrc);
    if (!el) {
      const norm = (u: string) => { try { const a = new URL(u, location.href); return a.hostname + a.pathname; } catch { return u; } };
      const ns = norm(clip.imageSrc);
      el = imgs.find((img) => norm(img.src) === ns || norm(img.currentSrc) === ns);
    }
    if (!el) return [];
    // cssInjectionMode:'ui' styles only reach the Shadow Root — page imgs need inline
    // styles; stash any pre-existing inline outline so unhighlightClip restores it
    if (!('tabAgentOutline' in el.dataset)) {
      el.dataset.tabAgentOutline = el.style.outline;
      el.dataset.tabAgentOutlineOffset = el.style.outlineOffset;
    }
    el.style.outline = '3px solid #f39c12';
    el.style.outlineOffset = '2px';
    return [el];
  }
  let fragment: TextFragment | undefined;
  try {
    fragment = parseFragmentDirectives(getFragmentDirectives(new URL(clip.url).hash)).text?.[0];
    if (fragment?.textStart) {
      const ranges = processTextFragmentDirective(fragment);
      if (ranges.length) {
        trimRangeToText(ranges[0], clip.text);
        return markRange(ranges[0]);
      }
    }
  } catch {
    /* malformed URL */
  }
  // 兜底仅覆盖"fragment 曾存在但失配"(页面改动);裸 URL clip 无 fragment,保持旧行为不高亮
  if (!fragment?.textStart) return [];
  try {
    const range = findTextRange(clip.text, fragment.prefix, fragment.suffix);
    return range ? markRange(range) : []; // the text is no longer on the page
  } catch {
    return []; // 异常 DOM(失效节点/非常规文档)下兜底定位失败:静默降级为不高亮
  }
}

/** Undo highlightClip for both shapes: IMG inline outline vs polyfill <mark>s. */
export function unhighlightClip(els: Element[]) {
  for (const el of els)
    if (el.tagName === 'IMG') {
      const img = el as HTMLElement;
      // restore the pre-highlight inline outline (highlightClip stashed it), don't clobber
      img.style.outline = img.dataset.tabAgentOutline ?? '';
      img.style.outlineOffset = img.dataset.tabAgentOutlineOffset ?? '';
      delete img.dataset.tabAgentOutline;
      delete img.dataset.tabAgentOutlineOffset;
    }
  const marks = els.filter((el) => el.tagName !== 'IMG');
  if (marks.length) removeMarks(marks);
}
