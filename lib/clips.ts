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

/** Naive single-term fragment; fallback when generateFragment can't disambiguate. */
export const naiveFragment = (text: string) => `#:~:text=${enc(text.trim())}`;

const fragmentDirective = (f: TextFragment) =>
  '#:~:text=' +
  (f.prefix ? `${enc(f.prefix)}-,` : '') +
  enc(f.textStart) +
  (f.textEnd ? `,${enc(f.textEnd)}` : '') +
  (f.suffix ? `,-${enc(f.suffix)}` : '');

/** Build the clip's target URL — same algorithm as Chrome's "Copy link to highlight". */
export function buildClipUrl(pageUrl: string, selection: Selection): string {
  const base = pageUrl.split('#')[0];
  try {
    const { status, fragment } = generateFragment(selection);
    if (status === GenerateFragmentStatus.SUCCESS && fragment)
      return base + fragmentDirective(fragment);
  } catch {
    /* fall through to naive */
  }
  const text = selection.toString().trim();
  return text ? base + naiveFragment(text) : base; // bare URL: opens page top, no highlight
}

/** Locate the clip's text on the current page and wrap it in <mark>s; [] if not found. */
export function highlightClip(clip: Clip): Element[] {
  try {
    const fragment = parseFragmentDirectives(getFragmentDirectives(new URL(clip.url).hash)).text?.[0];
    if (!fragment?.textStart) return [];
    const ranges = processTextFragmentDirective(fragment);
    return ranges.length ? markRange(ranges[0]) : [];
  } catch {
    return []; // malformed URL, or the text is no longer on the page
  }
}

export { removeMarks } from 'text-fragments-polyfill/text-fragment-utils';
