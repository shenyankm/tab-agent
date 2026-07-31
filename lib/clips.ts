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
} from 'text-fragments-polyfill/text-fragment-utils';

export type Clip = {
  id: string;
  url: string; // pageUrl + #:~:text= fragment (bare pageUrl when generation failed)
  pageUrl: string;
  title: string;
  text: string;
  createdAt: number;
};

export const clipsItem = storage.defineItem<Clip[]>('local:clips', { fallback: [] });

export const stripHash = (url: string) => url.split('#')[0];

export async function addClip(clip: Omit<Clip, 'id' | 'createdAt'>): Promise<Clip> {
  const full = { ...clip, id: crypto.randomUUID(), createdAt: Date.now() };
  const clips = await clipsItem.getValue();
  await clipsItem.setValue([full, ...clips]);
  return full;
}

export async function removeClip(id: string) {
  const clips = await clipsItem.getValue();
  await clipsItem.setValue(clips.filter((c) => c.id !== id));
}

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

/** 跨页跳转用 URL：不带 text fragment（原生 ::target-text 高亮无法编程清除，
 * “摘录高亮关闭时淡出”会失效），改带 clip id，由目标页 content script 走 showClip
 * 同一条定位/高亮/淡出路径。 */
export const clipNavUrl = (clip: Clip) => `${stripHash(clip.pageUrl)}#pixel-agent-clip=${clip.id}`;

/** Locate the clip's text on the current page and wrap it in <mark>s; [] if not found. */
export function highlightClip(clip: Clip): Element[] {
  try {
    const fragment = parseFragmentDirectives(getFragmentDirectives(new URL(clip.url).hash)).text?.[0];
    if (!fragment?.textStart) return [];
    const ranges = processTextFragmentDirective(fragment);
    if (!ranges.length) return [];
    trimRangeToText(ranges[0], clip.text);
    return markRange(ranges[0]);
  } catch {
    return []; // malformed URL, or the text is no longer on the page
  }
}

export { removeMarks } from 'text-fragments-polyfill/text-fragment-utils';
