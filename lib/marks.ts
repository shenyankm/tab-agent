import { addClip, type Clip } from '@/lib/clips-store';
import { highlightClip, unhighlightClip } from '@/lib/clips-highlight';
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

/** 高亮色变更后给在页 mark 补色(content.tsx watch 调用) */
export function restyleMarks(color: HighlightColor) {
  currentColor = color;
  for (const marks of markByClip.values()) paint(marks, color);
}

export function showClip(clip: Clip, scroll = true): boolean {
  let marks = markByClip.get(clip.id);
  // SPA 导航后旧 mark 已失连：先清残留再重建，避免嵌套
  if (!marks?.length || !marks.every((el) => el.isConnected)) {
    if (marks?.length) unhighlightClip(marks);
    marks = highlightClip(clip);
    if (!marks.length) return false;
    markByClip.set(clip.id, marks);
    if (currentColor) paint(marks, currentColor);
    else {
      // 新建 mark 补上选中的高亮色;读取失败(上下文失效)保持浏览器默认黄
      highlightColorItem.getValue().then((c) => {
        currentColor = c;
        paint(marks!, c);
      }).catch(() => {});
    }
  }
  if (scroll) {
    marks[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
    // highlighting off = locate-only: flash the marks, then fade them out
    clipHighlightItem.getValue().then((on) => {
      if (on) return;
      clearTimeout(fadeTimers.get(clip.id));
      fadeTimers.set(clip.id, setTimeout(() => {
        fadeTimers.delete(clip.id);
        if (markByClip.delete(clip.id)) unhighlightClip(marks); // already-gone marks no-op
      }, 3000));
    }).catch(() => { /* invalidated context */ });
  }
  return true;
}

export type ClipDraft = Omit<Clip, 'id' | 'createdAt'>;

const draftEvents = new EventTarget();
let editorMounted = false;

export { draftEvents };

// the floating editor flips this on mount/unmount (ES-module bindings are read-only
// to importers, so the write goes through a setter)
export function setEditorMounted(mounted: boolean) {
  editorMounted = mounted;
}

export const commitDraft = async (draft: ClipDraft) => {
  const clip = await addClip(draft);
  // mark right away as save feedback, unless highlighting is switched off
  if (await clipHighlightItem.getValue()) showClip(clip, false);
};

/** 划词保存入口（content.tsx 调用）：编辑卡片在挂载就弹出卡片编辑后再入库，
 *  否则（宠物关闭、UI 未挂载）直接保存，保持旧行为。 */
export function saveClipDraft(draft: ClipDraft) {
  if (editorMounted) draftEvents.dispatchEvent(new CustomEvent('draft', { detail: draft }));
  // 无 UI 反馈面的直存路径:写入失败(上下文失效/IDB 错误)只能静默
  else void commitDraft(draft).catch(() => {});
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
