// Clip storage: IndexedDB layer + message facade + URL utils. No DOM/polyfill
// imports — background bundles this module; the highlight half lives in
// clips-highlight.ts (content script only).

export type Clip = {
  id: string;
  url: string; // pageUrl + #:~:text= fragment (bare pageUrl when generation failed)
  pageUrl: string;
  title: string;
  text: string;
  createdAt: number;
  kind?: 'page' | 'image'; // absent = selection excerpt
  imageSrc?: string; // image clips only
  tags?: string[];
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

// content scripts share the page's origin; extension pages are chrome-extension:
// (moz-extension: on Firefox). Computed lazily — at build time (vite-node)
// location may be undefined.
const isContentScript = () =>
  typeof location !== 'undefined' &&
  !location.protocol.startsWith('chrome-extension') &&
  !location.protocol.startsWith('moz-extension');

let dbPromise: Promise<IDBDatabase> | null = null;
let lastCreatedAt = 0; // keep createdAt monotonic so newest-first order is stable

function req2p<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Resolve when the transaction commits — request success alone can still abort. */
function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function openDB(): Promise<IDBDatabase> {
  if (!dbPromise) {
    const p = new Promise<IDBDatabase>((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 2);
      req.onupgradeneeded = () => {
        const db = req.result;
        const store = db.objectStoreNames.contains(STORE)
          ? req.transaction!.objectStore(STORE) // v1 → v2 upgrade
          : db.createObjectStore(STORE, { keyPath: 'id' });
        // createdAt: newest-first reads without getAll+sort; pageUrl: per-page
        // reads (clipsGetForPage) without scanning the whole store
        if (!store.indexNames.contains('createdAt')) store.createIndex('createdAt', 'createdAt');
        if (!store.indexNames.contains('pageUrl')) store.createIndex('pageUrl', 'pageUrl');
      };
      req.onsuccess = () => {
        const db = req.result;
        // don't block a later upgrade (another context holding the old version
        // open): close and let the next call reopen at the new version
        db.onversionchange = () => {
          db.close();
          if (dbPromise === p) dbPromise = null;
        };
        resolve(db);
      };
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
  // index read is already createdAt-ascending; reverse instead of getAll+sort
  const clips = await req2p(db.transaction(STORE).objectStore(STORE).index('createdAt').getAll());
  return clips.reverse(); // newest first
}

/** Read only one page's clips via the pageUrl index (values are normalized at write). */
export async function getClipsForPageDirect(page: string): Promise<Clip[]> {
  const db = await openDB();
  const clips = await req2p(
    db.transaction(STORE).objectStore(STORE).index('pageUrl').getAll(normalizeUrl(page)),
  );
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
  const tx = db.transaction(STORE, 'readwrite');
  tx.objectStore(STORE).put(full);
  await txDone(tx);
  broadcastClipsChanged();
  return full;
}

export async function removeClipDirect(id: string): Promise<void> {
  const db = await openDB();
  const tx = db.transaction(STORE, 'readwrite');
  tx.objectStore(STORE).delete(id);
  await txDone(tx);
  broadcastClipsChanged();
}

// patch 来自页面消息(不可信)与 classify 响应:白名单 + 类型校验。id 是 keyPath,
// 不校验的话可整体覆盖另一条记录;脏类型(如 notes 非数组)会击穿渲染。
const PATCH_KEYS = ['category', 'relatedIds', 'notes', 'tags'] as const;
export type ClipPatch = Partial<Pick<Clip, 'category' | 'relatedIds' | 'notes' | 'tags'>>;

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

export async function updateClipDirect(id: string, patch: ClipPatch): Promise<void> {
  return updateClipsDirect([{ id, patch }]);
}

/** Batch patch in one readwrite transaction (classify writes hundreds); broadcasts once. */
export async function updateClipsDirect(patches: { id: string; patch: ClipPatch }[]): Promise<void> {
  if (!patches.length) return;
  const db = await openDB();
  const tx = db.transaction(STORE, 'readwrite');
  const store = tx.objectStore(STORE);
  // one getAll + in-memory merge, then all puts issued synchronously: awaiting
  // individual get→put pairs inside the transaction lets it go inactive at the
  // microtask boundary (Firefox throws TransactionInactiveError)
  const all = (await req2p(store.getAll())) as Clip[];
  const byId = new Map(all.map((c) => [c.id, c]));
  const done = txDone(tx);
  for (const { id, patch } of patches) {
    const safe = sanitizePatch(patch);
    if (!Object.keys(safe).length) continue;
    const clip = byId.get(id);
    if (!clip) continue;
    const merged = { ...clip, ...safe };
    byId.set(id, merged); // two patches to one id accumulate instead of clobbering
    store.put(merged);
  }
  await done;
  broadcastClipsChanged();
}

// ---- unified facade: direct in the extension origin, message proxy in content scripts ----

/** Same shape as a WXT storage item, so useStorageValue keeps working unchanged. */
export const clipsItem = {
  getValue: (): Promise<Clip[]> =>
    isContentScript() ? write<Clip[]>({ type: 'clipsGet' }) : getClipsDirect(),
  // refresh rejections (invalidated context after reload/update) are non-fatal:
  // swallow them instead of flooding the page console with unhandled rejections
  watch: (cb: (clips: Clip[]) => void) =>
    watchChanges(() => void clipsItem.getValue().then(cb).catch(() => {})),
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
        : getClipsForPageDirect(page);
    item = { getValue, watch: (cb) => watchChanges(() => void getValue().then(cb).catch(() => {})) };
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

export const stripHash = (url: string) => url.split('#')[0];

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

/** 跨页跳转用 URL：不带 text fragment（原生 ::target-text 高亮无法编程清除，
 * “摘录高亮关闭时淡出”会失效），改带 clip id，由目标页 content script 走 showClip
 * 同一条定位/高亮/淡出路径。 */
export const clipNavUrl = (clip: Clip) => `${stripHash(clip.pageUrl)}#pixel-agent-clip=${clip.id}`;

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

export function updateClip(id: string, patch: ClipPatch): Promise<void> {
  return write<void>({ type: 'clipUpdate', id, patch });
}
