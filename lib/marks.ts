import { addClip, highlightClip, unhighlightClip, type Clip } from '@/lib/clips';
import { clipHighlightItem } from '@/lib/settings';

// clip id → its <mark>s: re-clicks scroll to the existing marks instead of nesting
// new ones; isConnected drops SPA-navigation leftovers and re-highlights on demand
const markByClip = new Map<string, Element[]>();

export function showClip(clip: Clip, scroll = true): boolean {
  let marks = markByClip.get(clip.id);
  // SPA 导航后旧 mark 已失连：先清残留再重建，避免嵌套
  if (!marks?.length || !marks.every((el) => el.isConnected)) {
    if (marks?.length) unhighlightClip(marks);
    marks = highlightClip(clip);
    if (!marks.length) return false;
    markByClip.set(clip.id, marks);
  }
  if (scroll) {
    marks[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
    // highlighting off = locate-only: flash the marks, then fade them out
    clipHighlightItem.getValue().then((on) => {
      if (on) return;
      setTimeout(() => {
        if (markByClip.delete(clip.id)) unhighlightClip(marks); // already-gone marks no-op
      }, 3000);
    });
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
  else void commitDraft(draft);
}

/** Remove all highlight marks and reset the cache (used when highlighting is toggled off). */
export function clearAllMarks() {
  for (const marks of markByClip.values()) unhighlightClip(marks);
  markByClip.clear();
}
