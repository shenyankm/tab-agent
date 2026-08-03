import type { Clip } from '@/lib/clips';

// 模板变量用 {{key}} 双花括号,与 i18n t() 的单花括号 {key} 插值区分。
// 替换逻辑只此一处;未知 token 原样保留,缺失值置空。

// frontmatter 值压平换行,避免撑破 YAML;正文类字段(text/fullText/notes)保留原样
const flat = (s: string) => s.replace(/\s*\n\s*/g, ' ').trim();

export function renderTemplate(template: string, clip: Clip): string {
  const vars: Record<string, string> = {
    title: flat(clip.title),
    url: clip.pageUrl,
    text: clip.text,
    fullText: clip.fullText ?? '',
    author: flat(clip.author ?? ''),
    description: flat(clip.description ?? ''),
    published: flat(clip.published ?? ''),
    category: flat(clip.category ?? ''),
    tags: (clip.tags ?? []).join(', '),
    notes: (clip.notes ?? []).join('\n'),
    createdAt: new Date(clip.createdAt).toISOString().slice(0, 10),
  };
  return template.replace(/\{\{(\w+)\}\}/g, (m, k: string) => vars[k] ?? m);
}

export const clipsToMarkdown = (clips: Clip[], template: string) =>
  clips.map((c) => renderTemplate(template, c)).join('\n\n---\n\n');

/** Extension-page download: object URL + a[download], no downloads permission needed. */
export function downloadFile(name: string, mime: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}
