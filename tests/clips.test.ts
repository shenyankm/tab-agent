import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing';
import {
  addClip,
  removeClip,
  updateClip,
  clipsItem,
  getClipsDirect,
  getClipsPageDirect,
  getClipCategoriesDirect,
  getClipsForPageDirect,
  addClipDirect,
  searchClipsDirect,
  removeClipDirect,
  updateClipDirect,
  updateClipsDirect,
  clipsPageItem,
  closeClipsDB,
} from '@/lib/clips-store';
import { buildClipUrl, highlightClip, unhighlightClip } from '@/lib/clips-highlight';

function deleteDB(): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase('tab-agent');
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

describe('buildClipUrl', () => {
  it('replaces an existing hash with a text fragment', () => {
    document.body.innerHTML = '<p>some unique paragraph text</p>';
    const range = document.createRange();
    range.selectNodeContents(document.querySelector('p')!);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);

    const url = buildClipUrl('https://example.com/page#old-hash', sel);
    expect(url.startsWith('https://example.com/page#:~:text=')).toBe(true);
  });

  it('returns the bare URL for an empty selection', () => {
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    expect(buildClipUrl('https://example.com/page#x', sel)).toBe('https://example.com/page');
  });
});

describe('highlightClip', () => {
  it('re-marks the stored fragment text on the page', () => {
    document.body.innerHTML = '<p>alpha bravo charlie</p>';
    const clip = { id: 'x', url: 'https://e.com/p#:~:text=bravo', pageUrl: 'https://e.com/p', title: '', text: 'bravo', createdAt: 0 };
    const marks = highlightClip(clip);
    expect(marks[0]?.tagName).toBe('MARK');
    expect(document.querySelector('mark')?.textContent).toBe('bravo');
  });

  // regression: generateFragment word-expands the selection (CJK 「下表」), so the
  // URL fragment can be wider than the stored text — marks must shrink back to it
  it('marks only the stored text when the fragment is word-expanded', () => {
    document.body.innerHTML = '<p>alpha bravado charlie</p>';
    const clip = { id: 'x', url: 'https://e.com/p#:~:text=bravado', pageUrl: 'https://e.com/p', title: '', text: 'ravad', createdAt: 0 };
    const marks = highlightClip(clip);
    expect(marks.map((m) => m.textContent).join('')).toBe('ravad');
  });

  it('returns null when the text is gone', () => {
    document.body.innerHTML = '<p>nothing to see</p>';
    const clip = { id: 'x', url: 'https://e.com/p#:~:text=vanished', pageUrl: 'https://e.com/p', title: '', text: 'vanished', createdAt: 0 };
    expect(highlightClip(clip)).toEqual([]);
  });

  // fallback: page text shifted (dynamic render, whitespace drift) so the fragment
  // directive no longer matches — locate clip.text directly (textQuote-style)
  it('falls back to locating clip.text when the fragment directive is stale', () => {
    document.body.innerHTML = '<p>alpha bravo charlie</p>';
    const clip = { id: 'x', url: 'https://e.com/p#:~:text=expired-term', pageUrl: 'https://e.com/p', title: '', text: 'bravo', createdAt: 0 };
    const marks = highlightClip(clip);
    expect(marks[0]?.tagName).toBe('MARK');
    expect(document.querySelector('mark')?.textContent).toBe('bravo');
  });

  // regression: a hit spanning inline elements (<p>hello <b>world</b></p>) must map
  // start/end to separate nodes — packing both into one node made setEnd throw
  // IndexSizeError, crashing the click handler (unprotected fallback path)
  it('marks a hit spanning multiple text nodes in the fallback', () => {
    document.body.innerHTML = '<p>hello <b>world</b></p>';
    const clip = { id: 'x', url: 'https://e.com/p#:~:text=stale', pageUrl: 'https://e.com/p', title: '', text: 'hello world', createdAt: 0 };
    const marks = highlightClip(clip);
    expect(marks.length).toBeGreaterThan(0);
    expect(marks.map((m) => m.textContent).join('')).toBe('hello world');
  });

  it('returns null when neither the fragment nor the text is on the page', () => {
    document.body.innerHTML = '<p>nothing to see</p>';
    const clip = { id: 'x', url: 'https://e.com/p#:~:text=gone', pageUrl: 'https://e.com/p', title: '', text: 'vanished', createdAt: 0 };
    expect(highlightClip(clip)).toEqual([]);
  });

  // bare-URL clip (no fragment directive): keep the old no-highlight behavior,
  // the fallback text search only covers "fragment existed but went stale"
  it('does not text-search for clips without a fragment directive', () => {
    document.body.innerHTML = '<p>alpha bravo charlie</p>';
    const clip = { id: 'x', url: 'https://e.com/p', pageUrl: 'https://e.com/p', title: '', text: 'bravo', createdAt: 0 };
    expect(highlightClip(clip)).toEqual([]);
  });

  it('skips script text nodes in the fallback search', () => {
    document.body.innerHTML = '<script>const secret = "top-secret";</script><p>top-secret visible</p>';
    const clip = { id: 'x', url: 'https://e.com/p#:~:text=stale', pageUrl: 'https://e.com/p', title: '', text: 'top-secret', createdAt: 0 };
    const marks = highlightClip(clip);
    expect(marks.length).toBe(1);
    expect(marks[0].parentElement?.tagName).toBe('P'); // 命中正文而非 script
  });

  // multiple occurrences: the fragment's prefix/suffix context picks the right one
  it('disambiguates repeated text with the fragment prefix/suffix in the fallback', () => {
    document.body.innerHTML = '<p>bravo decoy</p><p>start alpha bravo charlie end</p>';
    const clip = { id: 'x', url: 'https://e.com/p#:~:text=start%20alpha-,expired,-charlie%20end', pageUrl: 'https://e.com/p', title: '', text: 'bravo', createdAt: 0 };
    const marks = highlightClip(clip);
    expect(marks.map((m) => m.textContent).join('')).toBe('bravo');
    expect(marks[0].closest('p')?.textContent).toBe('start alpha bravo charlie end');
  });

  describe('image clips', () => {
    const imgClip = {
      id: 'x', url: 'https://e.com/i.png', pageUrl: 'https://e.com/p', title: '', text: 'i.png',
      createdAt: 0, kind: 'image' as const, imageSrc: 'https://e.com/i.png',
    };

    it('outlines the matching img; unhighlightClip resets it', () => {
      document.body.innerHTML = '<img src="https://e.com/i.png">';
      const img = document.querySelector('img')!;
      const marks = highlightClip(imgClip);
      expect(marks).toEqual([img]);
      expect(img.style.outline).toContain('#f39c12');
      unhighlightClip(marks);
      expect(img.style.outline).toBe('');
    });

    it('returns [] when the image is gone (same contract as stale text fragments)', () => {
      document.body.innerHTML = '<p>no image here</p>';
      expect(highlightClip(imgClip)).toEqual([]);
    });
  });
});

// extension-origin storage: exercise the direct API (jsdom's location is http:,
// so the facade would take the content-script message path — tested separately)
describe('clip storage (extension origin)', () => {
  beforeEach(async () => {
    fakeBrowser.reset();
    // close the previous test's connection first, else deleteDatabase stays blocked
    await closeClipsDB();
    await deleteDB();
  });

  it('adds newest first and removes by id', async () => {
    await addClipDirect({ url: 'https://a#:~:text=a', pageUrl: 'https://a', title: 'A', text: 'a' });
    await addClipDirect({ url: 'https://b#:~:text=b', pageUrl: 'https://b', title: 'B', text: 'b' });

    let clips = await getClipsDirect();
    expect(clips.map((c) => c.text)).toEqual(['b', 'a']);

    await removeClipDirect(clips[1].id);
    clips = await getClipsDirect();
    expect(clips.map((c) => c.text)).toEqual(['b']);
  });

  it('keeps createdAt monotonic so same-millisecond adds order stably', async () => {
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now); // freeze the clock: both adds share a ms
    const a = await addClipDirect({ url: 'https://a', pageUrl: 'https://a', title: 'A', text: 'a' });
    const b = await addClipDirect({ url: 'https://b', pageUrl: 'https://b', title: 'B', text: 'b' });
    vi.restoreAllMocks();

    expect(b.createdAt).toBeGreaterThan(a.createdAt);
    const clips = await getClipsDirect();
    expect(clips.map((c) => c.text)).toEqual(['b', 'a']);
  });

  it('reads a newest-first page and total without returning older rows', async () => {
    await addClipDirect({ url: 'https://a', pageUrl: 'https://a', title: 'A', text: 'a' });
    await addClipDirect({ url: 'https://b', pageUrl: 'https://b', title: 'B', text: 'b' });
    await addClipDirect({ url: 'https://c', pageUrl: 'https://c', title: 'C', text: 'c' });

    const result = await getClipsPageDirect(1, 1);
    expect(result.total).toBe(3);
    expect(result.clips.map((c) => c.text)).toEqual(['b']);
  });

  it('reads distinct categories without copying clip rows', async () => {
    await addClipDirect({ url: 'https://a', pageUrl: 'https://a', title: 'A', text: 'a', category: 'z' });
    await addClipDirect({ url: 'https://b', pageUrl: 'https://b', title: 'B', text: 'b', category: 'a' });
    await addClipDirect({ url: 'https://c', pageUrl: 'https://c', title: 'C', text: 'c', category: 'z' });

    expect(await getClipCategoriesDirect()).toEqual(['a', 'z']);
  });

  it('searchClipsDirect filters by substring/category newest-first', async () => {
    await addClipDirect({ url: 'https://a', pageUrl: 'https://a', title: 'Alpha', text: 'hello world', category: 'x', tags: ['t1'] });
    await addClipDirect({ url: 'https://b', pageUrl: 'https://b', title: 'Beta', text: 'world peace', category: 'y', tags: ['hello-tag'] });
    await addClipDirect({ url: 'https://c', pageUrl: 'https://c', title: 'Gamma', text: 'nothing alike', category: 'x' });

    // 子串命中 text/title/pageUrl/tags 任一字段,大小写不敏感,最新在前
    expect((await searchClipsDirect({ q: 'HELLO' })).map((c) => c.title)).toEqual(['Beta', 'Alpha']);
    expect((await searchClipsDirect({ q: 'gamma' })).map((c) => c.title)).toEqual(['Gamma']);
    expect((await searchClipsDirect({ q: 'https://b' })).map((c) => c.title)).toEqual(['Beta']);
    // 分类过滤及其与子串的组合
    expect((await searchClipsDirect({ category: 'x' })).map((c) => c.title)).toEqual(['Gamma', 'Alpha']);
    expect((await searchClipsDirect({ q: 'hello', category: 'x' })).map((c) => c.title)).toEqual(['Alpha']);
    // 无过滤条件 = newest-first 全量;无命中 = 空
    expect((await searchClipsDirect({})).map((c) => c.title)).toEqual(['Gamma', 'Beta', 'Alpha']);
    expect(await searchClipsDirect({ q: 'nonexistent' })).toEqual([]);
  });

  it('normalizes tracking params on save', async () => {
    const clip = await addClipDirect({ url: 'https://x.com/a?utm_source=tw#:~:text=hi', pageUrl: 'https://x.com/a?utm_source=tw', title: 'T', text: 'hi' });
    expect(clip.pageUrl).toBe('https://x.com/a');
  });

  it('updateClipDirect merges patch and ignores missing ids', async () => {
    const clip = await addClipDirect({ url: 'https://a', pageUrl: 'https://a', title: 'A', text: 'hello' });
    await updateClipDirect(clip.id, { category: 'concept' });
    const [updated] = await getClipsDirect();
    expect(updated.category).toBe('concept');
    expect(updated.text).toBe('hello'); // untouched fields preserved
    // non-existent id: no throw
    await updateClipDirect('ghost', { category: 'x' });
  });

  it('updateClipDirect whitelists patch keys and validates types', async () => {
    const clip = await addClipDirect({ url: 'https://a', pageUrl: 'https://a', title: 'A', text: 'hello' });
    // 越权字段(消息层不可信)与脏类型必须被丢弃,不能覆盖 keyPath/保护字段
    await updateClipDirect(clip.id, {
      category: 'x',
      notes: 'boom',
      id: 'stolen',
      createdAt: 0,
      pageUrl: 'https://evil.com',
    } as any);
    const [updated] = await getClipsDirect();
    expect(updated.category).toBe('x');
    expect(updated.id).toBe(clip.id);
    expect(updated.createdAt).toBe(clip.createdAt);
    expect(updated.pageUrl).toBe(clip.pageUrl); // 未被越权字段覆盖
    expect(updated.notes).toBeUndefined(); // 非数组 notes 被丢弃
    // 合法 notes 数组照常写入
    await updateClipDirect(clip.id, { notes: ['note one'] });
    const [u2] = await getClipsDirect();
    expect(u2.notes).toEqual(['note one']);
  });

  it('updateClipDirect accepts tags and drops dirty tags payloads', async () => {
    const clip = await addClipDirect({ url: 'https://a', pageUrl: 'https://a', title: 'A', text: 'hello' });
    await updateClipDirect(clip.id, { tags: ['ai', 'web'] });
    expect((await getClipsDirect())[0].tags).toEqual(['ai', 'web']);
    // 脏类型(非字符串数组)必须被丢弃,同 notes 契约
    await updateClipDirect(clip.id, { tags: 'boom' as any });
    expect((await getClipsDirect())[0].tags).toEqual(['ai', 'web']);
  });

  it('addClipDirect passes through the new optional fields', async () => {
    const clip = await addClipDirect({
      url: 'https://a', pageUrl: 'https://a', title: 'A', text: 'summary',
      kind: 'page', tags: ['x'],
    });
    expect(clip).toMatchObject({ kind: 'page', tags: ['x'] });
  });

  it('updateClipsDirect patches many clips in one call and skips unknown/dirty entries', async () => {
    const a = await addClipDirect({ url: 'https://a', pageUrl: 'https://a', title: 'A', text: 'a' });
    const b = await addClipDirect({ url: 'https://b', pageUrl: 'https://b', title: 'B', text: 'b' });
    await updateClipsDirect([
      { id: a.id, patch: { category: 'concept' } },
      { id: b.id, patch: { category: 'data' } },
      { id: 'ghost', patch: { category: 'x' } }, // 不存在的 id:不抛错
      { id: a.id, patch: { notes: 'boom' as any } }, // 脏 patch:sanitize 后无可写字段,跳过
    ]);
    const clips = await getClipsDirect();
    expect(clips.find((c) => c.id === a.id)?.category).toBe('concept');
    expect(clips.find((c) => c.id === b.id)).toMatchObject({ category: 'data' });
    expect(clips.find((c) => c.id === a.id)?.notes).toBeUndefined();
  });

  it('updateClipsDirect accumulates two patches to the same id instead of clobbering', async () => {
    const a = await addClipDirect({ url: 'https://a', pageUrl: 'https://a', title: 'A', text: 'a' });
    await updateClipsDirect([
      { id: a.id, patch: { category: 'concept' } },
      { id: a.id, patch: { tags: ['ai'] } },
    ]);
    const [updated] = await getClipsDirect();
    expect(updated).toMatchObject({ category: 'concept', tags: ['ai'] });
  });

  it('getClipsForPageDirect reads one page via the index, newest first', async () => {
    await addClipDirect({ url: 'https://a', pageUrl: 'https://a?utm_source=tw', title: 'A', text: 'first' });
    await addClipDirect({ url: 'https://a', pageUrl: 'https://a', title: 'A', text: 'second' });
    await addClipDirect({ url: 'https://b', pageUrl: 'https://b', title: 'B', text: 'other page' });

    const clips = await getClipsForPageDirect('https://a');
    expect(clips.map((c) => c.text)).toEqual(['second', 'first']); // tracking params normalized at write
  });

  it('migrates a v1 database: rows intact, indexes usable', async () => {
    // build a v1-shaped DB (store only, no indexes), then close it
    await new Promise<void>((resolve, reject) => {
      const req = indexedDB.open('tab-agent', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('clips', { keyPath: 'id' });
      req.onsuccess = () => {
        const db = req.result;
        const tx = db.transaction('clips', 'readwrite');
        tx.objectStore('clips').put({ id: 'old', url: 'https://a/', pageUrl: 'https://a/', title: 'A', text: 'legacy', createdAt: 5 });
        tx.oncomplete = () => { db.close(); resolve(); };
        tx.onerror = () => reject(tx.error);
      };
      req.onerror = () => reject(req.error);
    });

    // the module opens at v2 → onupgradeneeded adds the indexes around the old row
    const clips = await getClipsDirect();
    expect(clips.map((c) => c.id)).toEqual(['old']);
    expect((await getClipsForPageDirect('https://a')).map((c) => c.id)).toEqual(['old']);
  });

});

// content-script side: the facade must proxy over runtime messages and NEVER touch
// the page-origin IndexedDB (regression for the cross-site isolation bug)
describe('clip storage (content script proxy)', () => {
  beforeEach(() => fakeBrowser.reset());

  it('getValue/addClip/removeClip send messages and do not open IndexedDB', async () => {
    const openSpy = vi.spyOn(indexedDB, 'open');
    const sendSpy = vi.fn((msg: { type: string; clip?: object; id?: string; page?: string }) => {
      // background replies with the {ok,data} envelope the facade unwraps
      if (msg.type === 'clipsGet') return Promise.resolve({ ok: true, data: [] });
      if (msg.type === 'clipsGetForPage') return Promise.resolve({ ok: true, data: [] });
      if (msg.type === 'clipAdd')
        return Promise.resolve({ ok: true, data: { ...msg.clip, id: 'x', createdAt: 1 } });
      return Promise.resolve({ ok: true, data: undefined });
    });
    // replace the method on the fakeBrowser object the module under test actually
    // holds (WXT auto-import binds the reference, so stubGlobal can't reach it).
    // WXT types sendMessage with 4 overloads — cast to swap in a single-signature fn.
    const original = browser.runtime.sendMessage;
    browser.runtime.sendMessage = sendSpy as unknown as typeof original;

    try {
      await clipsItem.getValue();
      expect(sendSpy).toHaveBeenCalledWith({ type: 'clipsGet' });

      // per-page reads carry the page key so background can filter before replying
      await clipsPageItem('https://e.com/p').getValue();
      expect(sendSpy).toHaveBeenCalledWith({ type: 'clipsGetForPage', page: 'https://e.com/p' });

      await addClip({ url: 'u', pageUrl: 'p', title: 't', text: 's' });
      expect(sendSpy).toHaveBeenCalledWith({
        type: 'clipAdd',
        clip: { url: 'u', pageUrl: 'p', title: 't', text: 's' },
      });

      await removeClip('x');
      expect(sendSpy).toHaveBeenCalledWith({ type: 'clipDel', id: 'x' });

      await updateClip('x', { notes: ['note'] });
      expect(sendSpy).toHaveBeenCalledWith({ type: 'clipUpdate', id: 'x', patch: { notes: ['note'] } });

      expect(openSpy).not.toHaveBeenCalled(); // the whole point: no page-origin DB
    } finally {
      browser.runtime.sendMessage = original;
      vi.restoreAllMocks();
    }
  });

  it('caps the per-page item cache at 20 and reorders on hit (LRU eviction)', async () => {
    // 填充 20 页并记住 p1 的引用;命中 p0(重排为最新)后插入第 21 页,
    // 被淘汰的是 p1(最久未用)而非 p0
    const p1 = clipsPageItem('https://e.com/p1');
    for (let i = 0; i < 20; i++) clipsPageItem(`https://e.com/p${i}`);
    const p0 = clipsPageItem('https://e.com/p0'); // hit: reorders
    expect(clipsPageItem('https://e.com/p0')).toBe(p0); // same instance while cached

    clipsPageItem('https://e.com/p20'); // over the cap → evict LRU (p1)
    expect(clipsPageItem('https://e.com/p1')).not.toBe(p1); // rebuilt after eviction
    expect(clipsPageItem('https://e.com/p0')).toBe(p0); // recently used survives
  });
});
