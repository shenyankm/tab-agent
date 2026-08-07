// Clip storage: IndexedDB layer + message facade + URL utils. No DOM/polyfill
// imports — background bundles this module; the highlight half lives in
// clips-highlight.ts (content script only).
import { CLIPS_CHANGED, sendRequest } from '@/lib/messages';

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
  notes?: string[]; // user annotations, appended to exports
};

// --- IndexedDB storage ---
// Clips live in the EXTENSION origin's IndexedDB: background is the sole writer,
// options (same origin) reads directly. Content scripts run in the PAGE origin,
// where IndexedDB would be per-site isolated — so they proxy over runtime messages.
// chrome.storage keeps only settings.

const DB_NAME = 'tab-agent';
const LEGACY_DB_NAME = 'pixel-agent';
const STORE = 'clips';

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

async function readLegacyClips(): Promise<Clip[]> {
  // Avoid creating an empty legacy database on new installs when the browser
  // exposes the database inventory API.
  if (typeof indexedDB.databases === 'function') {
    const databases = await indexedDB.databases();
    if (!databases.some(({ name }) => name === LEGACY_DB_NAME)) return [];
  }
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(LEGACY_DB_NAME);
    let created = false;
    req.onupgradeneeded = () => { created = true; };
    req.onsuccess = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.close();
        if (created) indexedDB.deleteDatabase(LEGACY_DB_NAME);
        resolve([]);
        return;
      }
      req2p(db.transaction(STORE).objectStore(STORE).getAll())
        .then((clips) => { db.close(); resolve(clips); }, (error) => { db.close(); reject(error); });
    };
    req.onblocked = () => reject(new Error('legacy database is busy'));
    req.onerror = () => reject(req.error);
  });
}

async function migrateLegacyClips(db: IDBDatabase) {
  const legacy = await readLegacyClips();
  if (!legacy.length) return;

  const tx = db.transaction(STORE, 'readwrite');
  const done = txDone(tx);
  done.catch(() => {}); // an early request failure rejects the work below first
  const store = tx.objectStore(STORE);
  await new Promise<void>((resolve, reject) => {
    let pending = legacy.length;
    for (const clip of legacy) {
      const request = store.get(clip.id);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        if (!request.result) {
          store.put(clip);
          lastCreatedAt = Math.max(lastCreatedAt, clip.createdAt);
        }
        if (--pending === 0) resolve();
      };
    }
  });
  await done;
  // The target database now owns the records. Removing the old name prevents
  // repeating the read on every service-worker restart.
  indexedDB.deleteDatabase(LEGACY_DB_NAME);
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
      req.onsuccess = async () => {
        const db = req.result;
        // don't block a later upgrade (another context holding the old version
        // open): close and let the next call reopen at the new version
        db.onversionchange = () => {
          db.close();
          if (dbPromise === p) dbPromise = null;
        };
        if (!isContentScript()) {
          try {
            await migrateLegacyClips(db);
          } catch (error) {
            // Keep the new store usable if a stale/locked legacy database cannot
            // be read; the old data remains available for a later retry.
            console.warn('[tab-agent] legacy clip migration failed:', error);
          }
        }
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

// ---- extension-origin direct access (background writer, options reader) ----
// This layer never broadcasts changes itself: the background handler fans out
// once per user action, so per-write notification
// here would multiply traffic. Options pages only read through this path.

export async function getClipsDirect(): Promise<Clip[]> {
  const db = await openDB();
  // index read is already createdAt-ascending; reverse instead of getAll+sort
  const clips = await req2p(db.transaction(STORE).objectStore(STORE).index('createdAt').getAll());
  return clips.reverse(); // newest first
}

export type ClipPage = { clips: Clip[]; total: number };

/** Read one newest-first window without loading older rows into memory. */
export async function getClipsPageDirect(offset: number, limit: number): Promise<ClipPage> {
  const db = await openDB();
  const tx = db.transaction(STORE);
  const index = tx.objectStore(STORE).index('createdAt');
  const totalRequest = index.count();
  const clips: Clip[] = [];
  const skip = Math.max(0, Math.floor(offset));
  const take = Math.max(1, Math.floor(limit));
  let skipped = 0;
  const cursorDone = new Promise<void>((resolve, reject) => {
    const request = index.openCursor(null, 'prev');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor || clips.length >= take) {
        resolve();
        return;
      }
      if (skipped++ < skip) {
        cursor.continue();
        return;
      }
      clips.push(cursor.value as Clip);
      if (clips.length < take) cursor.continue();
      else resolve();
    };
  });
  const done = txDone(tx);
  const [total] = await Promise.all([req2p(totalRequest), cursorDone, done]);
  return { clips, total };
}

/** Read category labels without copying every clip's text into the UI. */
export async function getClipCategoriesDirect(): Promise<string[]> {
  const db = await openDB();
  const tx = db.transaction(STORE);
  const categories = new Set<string>();
  const cursorDone = new Promise<void>((resolve, reject) => {
    const request = tx.objectStore(STORE).openCursor();
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve();
        return;
      }
      const category = (cursor.value as Clip).category;
      if (category) categories.add(category);
      cursor.continue();
    };
  });
  const done = txDone(tx);
  await Promise.all([cursorDone, done]);
  return [...categories].sort();
}

/** Read only one page's clips via the pageUrl index (values are normalized at write). */
export async function getClipsForPageDirect(page: string): Promise<Clip[]> {
  const db = await openDB();
  const clips = await req2p(
    db.transaction(STORE).objectStore(STORE).index('pageUrl').getAll(normalizeUrl(page)),
  );
  return clips.sort((a, b) => b.createdAt - a.createdAt); // newest first
}

// a selection can be the whole page (Ctrl+A): cap it so megabytes don't land in
// IDB and ride every clipsGetForPage reply afterwards
const TEXT_CAP = 20_000;

export async function addClipDirect(clip: Omit<Clip, 'id' | 'createdAt'>): Promise<Clip> {
  const full = {
    ...clip,
    text: clip.text.slice(0, TEXT_CAP),
    pageUrl: normalizeUrl(clip.pageUrl),
    id: crypto.randomUUID(),
    createdAt: (lastCreatedAt = Math.max(Date.now(), lastCreatedAt + 1)),
  };
  const db = await openDB();
  const tx = db.transaction(STORE, 'readwrite');
  tx.objectStore(STORE).put(full);
  await txDone(tx);
  return full;
}

/** Delete one clip; resolves its pageUrl (for the caller's fan-out payload). */
export async function removeClipDirect(id: string): Promise<string | undefined> {
  const db = await openDB();
  const tx = db.transaction(STORE, 'readwrite');
  const store = tx.objectStore(STORE);
  // issued back-to-back with the delete so the tx stays active; the read only
  // feeds the broadcast payload
  let pageUrl: string | undefined;
  const get = store.get(id);
  get.onsuccess = () => { pageUrl = (get.result as Clip | undefined)?.pageUrl; };
  store.delete(id);
  await txDone(tx);
  return pageUrl;
}

// patch 来自页面消息(不可信):白名单 + 类型校验。id 是 keyPath,
// 不校验的话可整体覆盖另一条记录;脏类型(如 notes 非数组)会击穿渲染。
const PATCH_KEYS = ['category', 'notes', 'tags'] as const;
export type ClipPatch = Partial<Pick<Clip, 'category' | 'notes' | 'tags'>>;

function sanitizePatch(patch: ClipPatch): Partial<Clip> {
  const safe: Partial<Clip> = {};
  for (const k of PATCH_KEYS) {
    const v = (patch as Record<string, unknown>)[k];
    if (v === undefined) continue;
    if (k === 'notes' && !(Array.isArray(v) && v.every((n) => typeof n === 'string'))) continue;
    if (k === 'tags' && !(Array.isArray(v) && v.every((n) => typeof n === 'string'))) continue;
    if (k === 'category' && typeof v !== 'string') continue;
    safe[k] = v as never;
  }
  return safe;
}

/** Single patch; resolves the clip's pageUrl (for the caller's fan-out payload). */
export async function updateClipDirect(id: string, patch: ClipPatch): Promise<string | undefined> {
  return (await updateClipsDirect([{ id, patch }]))[0];
}

/** Batch patch in one readwrite transaction; resolves
 *  the pageUrls of the clips actually patched. */
export async function updateClipsDirect(patches: { id: string; patch: ClipPatch }[]): Promise<string[]> {
  if (!patches.length) return [];
  const db = await openDB();
  const tx = db.transaction(STORE, 'readwrite');
  const store = tx.objectStore(STORE);
  const done = txDone(tx);
  done.catch(() => {}); // pre-handled: an early reject below must not leave this dangling
  // per-id gets issued synchronously in one task, puts fired from inside the last
  // get's onsuccess. Crossing an await between get→put lets the tx go inactive at
  // the task boundary (Firefox throws TransactionInactiveError), and a getAll
  // would read the whole store to patch a handful of records.
  const pages = new Set<string>();
  await new Promise<void>((resolve, reject) => {
    const rows = new Map<string, Clip>();
    let pending = patches.length;
    for (const { id } of patches) {
      const req = store.get(id);
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        try {
          if (req.result) rows.set(id, req.result as Clip);
          if (--pending > 0) return;
          for (const { id, patch } of patches) {
            const safe = sanitizePatch(patch);
            if (!Object.keys(safe).length) continue;
            const clip = rows.get(id);
            if (!clip) continue;
            const merged = { ...clip, ...safe };
            rows.set(id, merged); // two patches to one id accumulate instead of clobbering
            pages.add(clip.pageUrl);
            store.put(merged);
          }
          resolve();
        } catch (e) {
          reject(e);
        }
      };
    }
  });
  await done;
  return [...pages];
}

// ---- unified facade: direct in the extension origin, message proxy in content scripts ----

/** Same shape as a WXT storage item, so useStorageValue keeps working unchanged. */
export const clipsItem = {
  getValue: (() => {
    let inFlight: Promise<Clip[]> | null = null;
    return () => {
      if (inFlight) return inFlight;
      inFlight = (isContentScript() ? sendRequest<Clip[]>({ type: 'clipsGet' }) : getClipsDirect())
        .finally(() => { inFlight = null; });
      return inFlight;
    };
  })(),
  // refresh rejections (invalidated context after reload/update) are non-fatal:
  // swallow them instead of flooding the page console with unhandled rejections
  watch: (cb: (clips: Clip[]) => void) =>
    watchChanges(() => clipsItem.getValue().then(cb).catch(() => {})),
};

// content script 的每次 clipsChanged 只关心本页:background 过滤后回传,payload
// 从 O(全部摘录) 降到 O(本页)。Map 保证同一 page 返回同一对象,否则
// useStorageValue 的 [item] 依赖每次渲染都是新对象,会退订/重订阅死循环。
const pageItems = new Map<string, { getValue: () => Promise<Clip[]>; watch: typeof clipsItem.watch }>();
// SPA 长逛会按页累积 item 对象(每个持有 watch 闭包与消息监听):上限 20,超出丢最旧。
// 被丢弃页的组件因 useStorageValue 的 [item] 依赖变化会重订阅新 item,安全
const PAGE_ITEMS_MAX = 20;
export function clipsPageItem(page: string) {
  let item = pageItems.get(page);
  if (!item) {
    // 广播携带的 page 是写入时规范化后的 pageUrl,这里按同一规则预规范化再比对
    const np = normalizeUrl(page);
    let inFlight: Promise<Clip[]> | null = null;
    const getValue = (): Promise<Clip[]> => {
      if (inFlight) return inFlight;
      inFlight = (isContentScript()
        ? sendRequest<Clip[]>({ type: 'clipsGetForPage', page: np })
        : getClipsForPageDirect(np))
        .finally(() => { inFlight = null; });
      return inFlight;
    };
    item = { getValue, watch: (cb) => watchChanges(() => getValue().then(cb).catch(() => {}), np) };
    pageItems.set(page, item);
    if (pageItems.size > PAGE_ITEMS_MAX) pageItems.delete(pageItems.keys().next().value!);
  } else {
    // 命中即重排为最近使用(Map 按插入序迭代,FIFO 会淘汰刚回访的页)
    pageItems.delete(page);
    pageItems.set(page, item);
  }
  return item;
}

// refresh is coalesced: a broadcast landing while a re-read is in flight sets a
// dirty flag for exactly one follow-up read — rapid consecutive writes must not
// resolve out of order and leave the UI on a stale snapshot. page (normalized on
// both sides) lets page watchers skip other pages' changes; a bare broadcast
// refreshes everyone.
function watchChanges(refresh: () => Promise<unknown>, page?: string): () => void {
  let inFlight = false;
  let dirty = false;
  const run = () => {
    if (inFlight) { dirty = true; return; }
    inFlight = true;
    void refresh().finally(() => {
      inFlight = false;
      if (dirty) { dirty = false; run(); }
    });
  };
  const onMessage = (msg: { type?: string; page?: string }) => {
    if (msg?.type !== CLIPS_CHANGED) return;
    if (page && msg.page && msg.page !== page) return; // another page's change
    run();
  };
  browser.runtime.onMessage.addListener(onMessage);
  return () => browser.runtime.onMessage.removeListener(onMessage);
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
export const clipNavUrl = (clip: Clip) => `${stripHash(clip.pageUrl)}#tab-agent-clip=${clip.id}`;

// Writes always go through background (the sole writer) so its fan-out reaches
// every context regardless of origin; only reads take the direct path in the
// extension origin. Background replies {ok:true,data} / {ok:false,error} —
// sendRequest (lib/messages) unwraps the envelope and rejects on failure.
export function addClip(clip: Omit<Clip, 'id' | 'createdAt'>): Promise<Clip> {
  return sendRequest<Clip>({ type: 'clipAdd', clip });
}

export function removeClip(id: string): Promise<void> {
  return sendRequest<void>({ type: 'clipDel', id });
}

export function updateClip(id: string, patch: ClipPatch): Promise<void> {
  return sendRequest<void>({ type: 'clipUpdate', id, patch });
}
