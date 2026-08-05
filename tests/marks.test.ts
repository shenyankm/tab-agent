import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockHighlightClip, mockUnhighlightClip } = vi.hoisted(() => ({
  mockHighlightClip: vi.fn(),
  mockUnhighlightClip: vi.fn(),
}));

vi.mock('@/lib/clips-highlight', () => ({
  highlightClip: (c: unknown) => mockHighlightClip(c),
  unhighlightClip: (els: unknown) => mockUnhighlightClip(els),
}));
vi.mock('@/lib/clips-store', () => ({ addClip: vi.fn() }));
vi.mock('@/lib/settings', () => ({
  clipHighlightItem: { getValue: () => Promise.resolve(true) },
  highlightColorItem: { getValue: () => Promise.resolve('yellow') },
  HIGHLIGHT_COLORS: { yellow: '#fef08a' },
}));

import { showClip, pruneMarks, clearAllMarks } from '@/lib/marks';
import type { Clip } from '@/lib/clips-store';

const clip = (id: string): Clip => ({
  id, url: `https://e.com/p#:~:text=${id}`, pageUrl: 'https://e.com/p',
  title: '', text: id, createdAt: 1,
});

// 广播刷新后:不在 keep 集的 clip 残留 mark 被清理,keep 内的保留;
// 对未高亮/重复清理幂等
describe('pruneMarks', () => {
  beforeEach(() => {
    clearAllMarks(); // 先清内部状态;其 unhighlightClip 调用会被下面的 clearAllMocks 抹掉
    vi.clearAllMocks();
    mockHighlightClip.mockImplementation(() => [document.createElement('mark')]);
  });

  it('removes marks of clips not in the keep set, keeps the rest', () => {
    const markA = document.createElement('mark');
    const markB = document.createElement('mark');
    markA.dataset.t = 'a';
    markB.dataset.t = 'b';
    mockHighlightClip.mockImplementation((c: { id: string }) => [c.id === 'a' ? markA : markB]);

    showClip(clip('a'), false);
    showClip(clip('b'), false);

    pruneMarks(new Set(['a']));
    // 只有 b 的 mark 被清理(引用相等)
    expect(mockUnhighlightClip).toHaveBeenCalledTimes(1);
    expect(mockUnhighlightClip.mock.calls[0][0][0]).toBe(markB);

    // 再次 prune 相同 keep 集:已清理的 clip 不再重复 unhighlight
    mockUnhighlightClip.mockClear();
    pruneMarks(new Set(['a']));
    expect(mockUnhighlightClip).not.toHaveBeenCalled();
  });

  it('keeps everything when all ids are still present', () => {
    showClip(clip('a'), false);
    pruneMarks(new Set(['a']));
    expect(mockUnhighlightClip).not.toHaveBeenCalled();
  });
});
