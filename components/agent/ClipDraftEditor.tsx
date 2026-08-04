import type { FormEvent } from 'react';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { CardHeader } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import type { I18nKey } from '@/lib/i18n';
import { commitDraft, type ClipDraft } from '@/lib/marks';
import { panelHeaderClass } from '@/components/agent/ChatPanel';

export function ClipDraftEditor({
  t,
  draft,
  onCancel,
}: {
  t: (key: I18nKey) => string;
  draft: ClipDraft;
  onCancel: () => void;
}) {
  // 与 options Clips 页同款解析：换行分备注，空则不写字段
  const saveDraft = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const f = new FormData(event.currentTarget);
    const notes = String(f.get('notes') ?? '').split('\n').map((s) => s.trim()).filter(Boolean);
    void commitDraft({
      ...draft,
      title: String(f.get('title') ?? '').trim() || draft.title,
      notes: notes.length ? notes : undefined,
    });
    onCancel();
  };

  return (
    <>
      <CardHeader className={panelHeaderClass}>
        <span className="font-bold">{t('clips.editor.heading')}</span>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={onCancel}
          aria-label={t('clips.cancel')}
        >
          <X />
        </Button>
      </CardHeader>
      <form onSubmit={saveDraft} className="flex flex-col gap-2 overflow-y-auto p-4">
        <p className="line-clamp-2 text-xs text-muted-foreground">{draft.text}</p>
        <Input name="title" defaultValue={draft.title} placeholder={t('clips.editor.title')} autoFocus aria-label={t('clips.editor.title')} />
        <Textarea name="notes" rows={2} placeholder={t('clips.notePlaceholder')} aria-label={t('clips.notePlaceholder')} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" size="sm" onClick={onCancel}>
            {t('clips.cancel')}
          </Button>
          <Button type="submit" size="sm">
            {t('clips.save')}
          </Button>
        </div>
      </form>
    </>
  );
}
