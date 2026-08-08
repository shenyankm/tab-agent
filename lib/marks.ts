import { type Clip } from '@/lib/clips-store';
import { highlightClip, highlightClipFast, unhighlightClip } from '@/lib/clips-highlight';
import { clipHighlightItem, highlightColorItem, HIGHLIGHT_COLORS, type HighlightColor } from '@/lib/settings';

// clip id → its <mark>s: re-clicks scroll to the existing marks instead of nesting
// new ones; isConnected drops SPA-navigation leftovers and re-highlights on demand
const markByClip = new Map<string, Element[]>();
// clip id → pending fade timer: a re-click re-arms the fade instead of stacking
// independent timers — the first one would delete the freshly re-shown marks early
const fadeTimers = new Map<string, ReturnType<typeof setTimeout>>();
let currentColor: HighlightColor | null = null;

const paint = (marks: Element[], color: HighlightColor) => {
  const bg = HIGHLIGHT_COLORS[color] ?? HIGHLIGHT_COLORS.yellow; // storage 可能被手改成非法值
  for (const m of marks) if (m.tagName !== 'IMG') (m as HTMLElement).style.backgroundColor = bg;
};

const applyColor = (marks: Element[]) => {
  if (currentColor) paint(marks, currentColor);
  else {
    // 新建 mark 补上选中的高亮色;读取失败(上下文失效)保持浏览器默认黄
    highlightColorItem.getValue().then((c) => {
      currentColor = c;
      paint(marks, c);
    }).catch(() => {});
  }
};

/** 高亮色变更后给在页 mark 补色(content.tsx watch 调用) */
export function restyleMarks(color: HighlightColor) {
  currentColor = color;
  for (const marks of markByClip.values()) paint(marks, color);
}

export function showClip(clip: Clip, scroll = true): boolean {
  const oldFade = fadeTimers.get(clip.id);
  if (oldFade) {
    clearTimeout(oldFade);
    fadeTimers.delete(clip.id);
  }
  let marks = markByClip.get(clip.id);
  // SPA 导航后旧 mark 已失连:先清残留再重建,避免嵌套
  if (!marks?.length || !marks.every((el) => el.isConnected)) {
    if (marks?.length) unhighlightClip(marks);
    marks = highlightClip(clip);
    if (!marks.length) return false;
    markByClip.set(clip.id, marks);
    applyColor(marks);
  }
  if (scroll) {
    marks[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
    // highlighting off = locate-only: flash the marks, then fade them out
    clipHighlightItem.getValue().then((on) => {
      if (on) return;
      const shownMarks = marks!;
      const timer = setTimeout(() => {
        if (fadeTimers.get(clip.id) !== timer || markByClip.get(clip.id) !== shownMarks) return;
        fadeTimers.delete(clip.id);
        if (markByClip.delete(clip.id)) unhighlightClip(shownMarks); // already-gone marks no-op
      }, 3000);
      fadeTimers.set(clip.id, timer);
    }).catch(() => { /* invalidated context */ });
  }
  return true;
}

/** 批量重放(高亮开关开启时 content.tsx 的 idle 分片调用):与逐条 showClip(scroll=false)
 *  同语义,但定位先走共享全文索引(highlightClipFast),仅失配条目回退 polyfill 全树扫描,
 *  N 条摘录的重放不再付 N 次全树遍历。 */
export function showClips(clips: Clip[]) {
  for (const clip of clips) {
    const oldFade = fadeTimers.get(clip.id);
    if (oldFade) {
      clearTimeout(oldFade);
      fadeTimers.delete(clip.id);
    }
    let marks = markByClip.get(clip.id);
    if (marks?.length && marks.every((el) => el.isConnected)) continue;
    if (marks?.length) unhighlightClip(marks);
    marks = highlightClipFast(clip) ?? highlightClip(clip);
    if (!marks.length) continue; // 定位失败:残留已清,等 pruneMarks/下次重放再试
    markByClip.set(clip.id, marks);
    applyColor(marks);
  }
}

/** Remove all highlight marks and reset the cache (used when highlighting is toggled off). */
export function clearAllMarks() {
  for (const timer of fadeTimers.values()) clearTimeout(timer);
  fadeTimers.clear();
  for (const marks of markByClip.values()) unhighlightClip(marks);
  markByClip.clear();
}

/** 广播刷新后清理已删除 clip 的残留 mark(keep = 现存 clip id 集,replay 前调用)。
 *  单独删除时不影响其他 clip 的 mark/淡出定时器。 */
export function pruneMarks(keep: Set<string>) {
  for (const [id, marks] of markByClip) {
    if (keep.has(id)) continue;
    clearTimeout(fadeTimers.get(id));
    fadeTimers.delete(id);
    unhighlightClip(marks);
    markByClip.delete(id);
  }
}
