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

export type Clip = {
  id: string;
  url: string; // pageUrl + #:~:text= fragment (bare pageUrl when generation failed)
  pageUrl: string;
  title: string;
  text: string;
  createdAt: number;
  kind?: 'page' | 'image'; // absent = selection excerpt
  fullText?: string; // page clips only, capped at save time
  imageSrc?: string; // image clips only
  tags?: string[];
  // page metadata captured at save time (untrusted input: display/export only)
  author?: string;
  description?: string;
  published?: string;
  category?: string;
  relatedIds?: string[];
  notes?: string[]; // user annotations, appended to exports
};

// --- IndexedDB storage ---
// Clips live in the EXTENSION origin's IndexedDB: background is the sole writer,
// options (same origin) reads directly. Content scripts run in the PAGE origin,
// where IndexedDB would be per-site isolated — so they proxy over runtime messages.
// chrome.storage keeps only settings.

const DB_NAME = 'pixel-agent';
const STORE = 'clips';
const CHANGED = 'clipsChanged';

// content scripts share the page's origin; extension pages are chrome-extension:.
// Computed lazily — at build time (vite-node) location may be undefined.
const isContentScript = () =>
  typeof location !== 'undefined' && !location.protocol.startsWith('chrome-extension');

let dbPromise: Promise<IDBDatabase> | null = null;
let lastCreatedAt = 0; // keep createdAt monotonic so newest-first order is stable

function req2p<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function openDB(): Promise<IDBDatabase> {
  if (!dbPromise) {
    const p = new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    // reset the cache once on failure so a later call retries, instead of caching
    // the rejection forever; the returned promise still rejects for this caller.
    p.catch(() => {
      if (dbPromise === p) dbPromise = null;
    });
    dbPromise = p;
  }
  return dbPromise;
}

/** Test-only: drop the cached connection so deleteDatabase can proceed. */
export async function closeClipsDB() {
  const db = await dbPromise?.catch(() => null);
  db?.close();
  dbPromise = null;
}

// extension-origin local writes don't cross contexts via tabs.sendMessage, so fan
// out locally for background/options' own watchers; tabs get the broadcast instead
const localChanges = new EventTarget();

function broadcastClipsChanged() {
  localChanges.dispatchEvent(new Event(CHANGED));
}

// ---- extension-origin direct access (background writer, options reader) ----

export async function getClipsDirect(): Promise<Clip[]> {
  const db = await openDB();
  const clips = await req2p(db.transaction(STORE).objectStore(STORE).getAll());
  return clips.sort((a, b) => b.createdAt - a.createdAt); // newest first
}

export async function addClipDirect(clip: Omit<Clip, 'id' | 'createdAt'>): Promise<Clip> {
  const full = {
    ...clip,
    pageUrl: normalizeUrl(clip.pageUrl),
    id: crypto.randomUUID(),
    createdAt: (lastCreatedAt = Math.max(Date.now(), lastCreatedAt + 1)),
  };
  const db = await openDB();
  await req2p(db.transaction(STORE, 'readwrite').objectStore(STORE).put(full));
  broadcastClipsChanged();
  return full;
}

export async function removeClipDirect(id: string): Promise<void> {
  const db = await openDB();
  await req2p(db.transaction(STORE, 'readwrite').objectStore(STORE).delete(id));
  broadcastClipsChanged();
}

// patch 来自页面消息(不可信)与 classify 响应:白名单 + 类型校验。id 是 keyPath,
// 不校验的话可整体覆盖另一条记录;脏类型(如 notes 非数组)会击穿渲染。
const PATCH_KEYS = ['category', 'relatedIds', 'notes', 'tags'] as const;
type ClipPatch = Partial<Pick<Clip, 'category' | 'relatedIds' | 'notes' | 'tags'>>;

function sanitizePatch(patch: ClipPatch): Partial<Clip> {
  const safe: Partial<Clip> = {};
  for (const k of PATCH_KEYS) {
    const v = (patch as Record<string, unknown>)[k];
    if (v === undefined) continue;
    if (k === 'notes' && !(Array.isArray(v) && v.every((n) => typeof n === 'string'))) continue;
    if (k === 'tags' && !(Array.isArray(v) && v.every((n) => typeof n === 'string'))) continue;
    if (k === 'relatedIds' && !(Array.isArray(v) && v.every((id) => typeof id === 'string'))) continue;
    if (k === 'category' && typeof v !== 'string') continue;
    safe[k] = v as never;
  }
  return safe;
}

export async function updateClipDirect(id: string, patch: ClipPatch, broadcast = true): Promise<void> {
  const safe = sanitizePatch(patch);
  const db = await openDB();
  const store = db.transaction(STORE, 'readwrite').objectStore(STORE);
  const clip = await req2p(store.get(id)) as Clip | undefined;
  if (!clip) return;
  await req2p(store.put({ ...clip, ...safe }));
  if (broadcast) broadcastClipsChanged();
}

/** Batch patch in one readwrite transaction (classify writes hundreds); broadcasts once. */
export async function updateClipsDirect(patches: { id: string; patch: ClipPatch }[]): Promise<void> {
  if (!patches.length) return;
  const db = await openDB();
  const store = db.transaction(STORE, 'readwrite').objectStore(STORE);
  await Promise.all(patches.map(async ({ id, patch }) => {
    const safe = sanitizePatch(patch);
    if (!Object.keys(safe).length) return;
    const clip = await req2p(store.get(id)) as Clip | undefined;
    if (clip) await req2p(store.put({ ...clip, ...safe }));
  }));
  broadcastClipsChanged();
}

// ---- unified facade: direct in the extension origin, message proxy in content scripts ----

/** Same shape as a WXT storage item, so useStorageValue keeps working unchanged. */
export const clipsItem = {
  getValue: (): Promise<Clip[]> =>
    isContentScript() ? write<Clip[]>({ type: 'clipsGet' }) : getClipsDirect(),
  watch: (cb: (clips: Clip[]) => void) =>
    watchChanges(() => void clipsItem.getValue().then(cb)),
};

// content script 的每次 clipsChanged 只关心本页:background 过滤后回传,payload
// 从 O(全部摘录) 降到 O(本页)。Map 保证同一 page 返回同一对象,否则
// useStorageValue 的 [item] 依赖每次渲染都是新对象,会退订/重订阅死循环。
const pageItems = new Map<string, { getValue: () => Promise<Clip[]>; watch: typeof clipsItem.watch }>();
export function clipsPageItem(page: string) {
  let item = pageItems.get(page);
  if (!item) {
    const getValue = (): Promise<Clip[]> =>
      isContentScript()
        ? write<Clip[]>({ type: 'clipsGetForPage', page })
        : getClipsDirect().then((clips) => clips.filter((c) => normalizeUrl(c.pageUrl) === page));
    item = { getValue, watch: (cb) => watchChanges(() => void getValue().then(cb)) };
    pageItems.set(page, item);
  }
  return item;
}

// extension-origin local writes don't cross contexts via tabs.sendMessage, so fan
// out locally for background/options' own watchers; tabs get the broadcast instead
function watchChanges(refresh: () => void): () => void {
  const onMessage = (msg: { type?: string }) => {
    if (msg?.type === CHANGED) refresh();
  };
  browser.runtime.onMessage.addListener(onMessage);
  if (isContentScript()) {
    // content writes go through messages; background's broadcast covers this page
    return () => browser.runtime.onMessage.removeListener(onMessage);
  }
  localChanges.addEventListener(CHANGED, refresh);
  return () => {
    localChanges.removeEventListener(CHANGED, refresh);
    browser.runtime.onMessage.removeListener(onMessage);
  };
}

const stripHash = (url: string) => url.split('#')[0];

// Tracking params that don't identify content
const TRACKING = new Set([
  'utm_source','utm_medium','utm_campaign','utm_term','utm_content',
  'fbclid','gclid','dclid','msclkid','twclid',
  'mc_cid','mc_eid','_ga','_gl','ref','si',
]);

/** Strip hash + tracking params so the same article always maps to one key. */
export function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.hash = '';
    for (const k of [...u.searchParams.keys()])
      if (TRACKING.has(k)) u.searchParams.delete(k);
    return u.toString();
  } catch { return raw; }
}

// Writes always go through background (the sole writer) so its fan-out reaches
// every context regardless of origin; only reads take the direct path in the
// extension origin. Background replies {ok:true,data} / {ok:false,error}.
type Reply<T> = { ok: true; data: T } | { ok: false; error?: string };

async function write<T>(msg: unknown): Promise<T> {
  const res = (await browser.runtime.sendMessage(msg)) as Reply<T>;
  if (!res?.ok) throw new Error(res?.error ?? 'clip write failed');
  return res.data;
}

export function addClip(clip: Omit<Clip, 'id' | 'createdAt'>): Promise<Clip> {
  return write<Clip>({ type: 'clipAdd', clip });
}

export function removeClip(id: string): Promise<void> {
  return write<void>({ type: 'clipDel', id });
}

export function updateClip(id: string, patch: Partial<Pick<Clip, 'category' | 'relatedIds' | 'notes' | 'tags'>>): Promise<void> {
  return write<void>({ type: 'clipUpdate', id, patch });
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

// script/style 等子树的文本节点不属于正文,命中会向脚本字符串插 <mark>(篡改页面)
const SKIP_TEXT_PARENTS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE']);

/** 兜底定位:文本片段失配(页面改动/动态渲染)时按 clip.text 在全文中查找
 * (textQuote 式重锚思路的简化版);多实例用 fragment 的
 * prefix/suffix 上下文消解,无吻合再退回第一个命中。
 * ponytail: 全文拼接 indexOf,命中可能跨元素边界;上下文仅空白归一后精确匹配——兜底路径,模糊匹配等失配报告再说 */
function findTextRange(text: string, prefix?: string, suffix?: string): Range | null {
  const q = text.trim();
  if (!q || !document.body) return null; // all_urls 匹配的 XML/SVG 页可能无 body
  const nodes: Text[] = [];
  let full = '';
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node: Node | null; (node = walker.nextNode()); ) {
    if (SKIP_TEXT_PARENTS.has((node.parentElement as HTMLElement | null)?.tagName ?? '')) continue;
    nodes.push(node as Text);
    full += (node as Text).data;
  }
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
  const np = prefix && norm(prefix);
  const ns = suffix && norm(suffix);
  const at = (i: number): Range => {
    // 偏移映射回节点:node 在 full 中起点 = 其之前各节点长度之和
    let base = 0, n = 0;
    while (n < nodes.length && base + nodes[n].data.length <= i) base += nodes[n++].data.length;
    const r = document.createRange();
    r.setStart(nodes[n], i - base);
    r.setEnd(nodes[n], i - base + q.length);
    return r;
  };
  let first: Range | null = null;
  for (let i = full.indexOf(q); i >= 0; i = full.indexOf(q, i + q.length)) {
    first ??= at(i);
    // 命中与上下文之间可能隔着空白,归一后用 endsWith/startsWith 比对
    if (np && !norm(full.slice(0, i)).endsWith(np)) continue;
    if (ns && !norm(full.slice(i + q.length)).startsWith(ns)) continue;
    return at(i);
  }
  return first; // 无上下文吻合:退回首个命中(旧行为)
}

/** Locate the clip's text on the current page and wrap it in <mark>s; [] if not found. */
export function highlightClip(clip: Clip): Element[] {
  if (clip.kind === 'image' && clip.imageSrc) {
    // ponytail: exact src/currentSrc match — lazy-load/srcset variants miss silently
    // (same as a stale text fragment); upgrade to normalized matching if reports come in
    const el = [...document.images].find((img) => img.src === clip.imageSrc || img.currentSrc === clip.imageSrc);
    if (!el) return [];
    // cssInjectionMode:'ui' styles only reach the Shadow Root — page imgs need inline styles
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
  const range = findTextRange(clip.text, fragment.prefix, fragment.suffix);
  return range ? markRange(range) : []; // the text is no longer on the page
}

/** Undo highlightClip for both shapes: IMG inline outline vs polyfill <mark>s. */
export function unhighlightClip(els: Element[]) {
  for (const el of els)
    if (el.tagName === 'IMG') {
      (el as HTMLElement).style.outline = '';
      (el as HTMLElement).style.outlineOffset = '';
    }
  const marks = els.filter((el) => el.tagName !== 'IMG');
  if (marks.length) removeMarks(marks);
}
