import { describe, it, expect, beforeEach } from 'vitest';
import { fakeBrowser } from 'wxt/testing';
import { buildClipUrl, highlightClip, addClip, removeClip, clipsItem } from '@/lib/clips';

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

describe('clip storage', () => {
  beforeEach(() => fakeBrowser.reset());

  it('adds newest first and removes by id', async () => {
    await addClip({ url: 'https://a#:~:text=a', pageUrl: 'https://a', title: 'A', text: 'a' });
    await addClip({ url: 'https://b#:~:text=b', pageUrl: 'https://b', title: 'B', text: 'b' });

    let clips = await clipsItem.getValue();
    expect(clips.map((c) => c.text)).toEqual(['b', 'a']);

    await removeClip(clips[1].id);
    clips = await clipsItem.getValue();
    expect(clips.map((c) => c.text)).toEqual(['b']);
  });
});
