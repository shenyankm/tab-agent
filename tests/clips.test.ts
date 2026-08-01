import { describe, it, expect, beforeEach, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing';
import {
  buildClipUrl,
  highlightClip,
  addClip,
  removeClip,
  clipsItem,
  getClipsDirect,
  addClipDirect,
  removeClipDirect,
  closeClipsDB,
} from '@/lib/clips';

function deleteDB(): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase('pixel-agent');
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

  it('migrates legacy clips once, sets the flag and clears the old key', async () => {
    const legacy = [
      { id: 'old-1', url: 'https://a#:~:text=a', pageUrl: 'https://a', title: 'A', text: 'a', createdAt: 1 },
      { id: 'old-2', url: 'https://b#:~:text=b', pageUrl: 'https://b', title: 'B', text: 'b', createdAt: 2 },
    ];
    await storage.setItem('local:clips', legacy);

    const clips = await getClipsDirect();

    expect(clips.map((c) => c.id)).toEqual(['old-2', 'old-1']); // newest first
    expect(await storage.getItem('local:clips')).toBeNull();
    expect(await storage.getItem('local:clipsMigrated')).toBe(true);

    // second open is a no-op: re-seeding the legacy key must NOT re-import
    await closeClipsDB();
    await storage.setItem('local:clips', legacy);
    await getClipsDirect();
    expect((await getClipsDirect()).filter((c) => c.id === 'old-1')).toHaveLength(1); // no duplicate
  });

});

// content-script side: the facade must proxy over runtime messages and NEVER touch
// the page-origin IndexedDB (regression for the cross-site isolation bug)
describe('clip storage (content script proxy)', () => {
  beforeEach(() => fakeBrowser.reset());

  it('getValue/addClip/removeClip send messages and do not open IndexedDB', async () => {
    const openSpy = vi.spyOn(indexedDB, 'open');
    const sendSpy = vi.fn((msg: { type: string; clip?: object; id?: string }) => {
      // background replies with the {ok,data} envelope the facade unwraps
      if (msg.type === 'clipsGet') return Promise.resolve({ ok: true, data: [] });
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

      await addClip({ url: 'u', pageUrl: 'p', title: 't', text: 's' });
      expect(sendSpy).toHaveBeenCalledWith({
        type: 'clipAdd',
        clip: { url: 'u', pageUrl: 'p', title: 't', text: 's' },
      });

      await removeClip('x');
      expect(sendSpy).toHaveBeenCalledWith({ type: 'clipDel', id: 'x' });

      expect(openSpy).not.toHaveBeenCalled(); // the whole point: no page-origin DB
    } finally {
      browser.runtime.sendMessage = original;
      vi.restoreAllMocks();
    }
  });
});
