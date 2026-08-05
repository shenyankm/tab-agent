import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// spy on Readability: cache invalidation is observable as a re-parse
const { mockParse } = vi.hoisted(() => ({ mockParse: vi.fn() }));
vi.mock('@mozilla/readability', () => ({
  Readability: class {
    parse() {
      return mockParse();
    }
  },
}));

import { pageText } from '@/lib/page-text';

const MARK_CLASS = 'text-fragments-polyfill-target-text';

// 扩展自己的 <mark>(polyfill 特征 class)插入/删除/着色不废缓存;
// 页面真实内容变化照常失效。回归保护:childList 突变的 target 是 mark 的
// 父元素而非 mark 本身,过滤必须看 addedNodes/removedNodes
describe('pageText cache invalidation', () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<p id="p">hello world</p>';
    // MutationObserver 回调是 microtask:先 flush 再推 debounce,
    // 让 textGen 在新测试里回到与 textGenAt 一致的基线
    await Promise.resolve();
    vi.advanceTimersByTime(1100);
    mockParse.mockReset();
    mockParse.mockReturnValue({ textContent: 'hello world' });
  });
  afterEach(() => vi.useRealTimers());

  it('own-mark insertion does not invalidate the cache', () => {
    pageText(); // first parse, caches
    expect(mockParse).toHaveBeenCalledTimes(1);

    // polyfill-style insertion: mark is added under <p>, the mutation target
    const mark = document.createElement('mark');
    mark.className = MARK_CLASS;
    document.querySelector('#p')!.appendChild(mark);
    vi.advanceTimersByTime(1100);

    expect(pageText()).toBe('hello world'); // cache hit
    expect(mockParse).toHaveBeenCalledTimes(1); // no re-parse
  });

  it('mark-internal text changes do not invalidate the cache', () => {
    pageText();
    const mark = document.createElement('mark');
    mark.className = MARK_CLASS;
    mark.textContent = 'hello';
    document.querySelector('#p')!.appendChild(mark);
    vi.advanceTimersByTime(1100);
    mockParse.mockClear();

    mark.firstChild!.textContent = 'changed'; // characterData inside our mark
    vi.advanceTimersByTime(1100);
    expect(mockParse).not.toHaveBeenCalled();
  });

  it('page text changes outside marks invalidate the cache', async () => {
    pageText();
    document.querySelector('#p')!.appendChild(document.createTextNode(' fresh'));
    await Promise.resolve(); // flush MutationObserver microtask before advancing
    vi.advanceTimersByTime(1100);

    pageText();
    expect(mockParse).toHaveBeenCalledTimes(2); // re-parsed
  });

  it('a non-extension <mark> (no polyfill class) still invalidates', async () => {
    pageText();
    const mark = document.createElement('mark'); // no class → not ours
    mark.textContent = 'x';
    document.querySelector('#p')!.appendChild(mark);
    await Promise.resolve();
    vi.advanceTimersByTime(1100);

    pageText();
    expect(mockParse).toHaveBeenCalledTimes(2);
  });
});
