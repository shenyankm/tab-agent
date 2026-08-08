// 划词草稿事件总线:content.js 主包与各懒加载 chunk 是独立模块图(同一隔离世界),
 // 模块级 EventTarget 会每 chunk 一份、草稿事件跨 chunk 丢失——单例挂 globalThis。
import { addClip, type Clip } from '@/lib/clips-store';
import { clipHighlightItem } from '@/lib/settings';
import { loadMarksChunk } from '@/lib/lazy';

export type ClipDraft = Omit<Clip, 'id' | 'createdAt'>;

type DraftBus = { events: EventTarget; editorMounted: boolean };
const g = globalThis as { __tabAgentDraftBus?: DraftBus };
const bus = (g.__tabAgentDraftBus ??= { events: new EventTarget(), editorMounted: false });

export const draftEvents = bus.events;

// the floating editor flips this on mount/unmount
export function setEditorMounted(mounted: boolean) {
  bus.editorMounted = mounted;
}

export const commitDraft = async (draft: ClipDraft) => {
  const clip = await addClip(draft);
  // mark right away as save feedback, unless highlighting is switched off
  if (await clipHighlightItem.getValue()) {
    const { marks } = await loadMarksChunk();
    marks.showClip(clip, false);
  }
};

/** 划词保存入口(content.tsx 调用):编辑卡片在挂载就弹出卡片编辑后再入库,
 *  否则(宠物关闭、UI 未挂载)直接保存,保持旧行为。 */
export function saveClipDraft(draft: ClipDraft) {
  if (bus.editorMounted) draftEvents.dispatchEvent(new CustomEvent('draft', { detail: draft }));
  // 无 UI 反馈面的直存路径:写入失败(上下文失效/IDB 错误)只能留痕
  else void commitDraft(draft).catch((e) => console.warn('[tab-agent] draft save failed:', e));
}
