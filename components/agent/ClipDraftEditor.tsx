import { useState, type FormEvent } from 'react';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { CardHeader } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import type { I18nKey } from '@/lib/i18n';
import { commitDraft, type ClipDraft } from '@/lib/marks';
import { parseNoteLines } from '@/lib/utils';
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
  const [saving, setSaving] = useState(false);

  const saveDraft = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (saving) return;
    const f = new FormData(event.currentTarget);
    const notes = parseNoteLines(String(f.get('notes') ?? '')); // 换行分备注，空则不写字段
    setSaving(true);
    try {
      await commitDraft({
        ...draft,
        title: String(f.get('title') ?? '').trim() || draft.title,
        notes: notes.length ? notes : undefined,
      });
      setSaving(false);
      onCancel();
    } catch (e) {
      // Keep the form mounted so a transient IDB/context failure can be retried.
      setSaving(false);
      console.warn('[tab-agent] draft save failed:', e);
    }
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
          disabled={saving}
          aria-label={t('clips.cancel')}
        >
          <X />
        </Button>
      </CardHeader>
      <form onSubmit={saveDraft} className="flex flex-col gap-2 overflow-y-auto p-4" aria-busy={saving}>
        <p className="line-clamp-2 text-xs text-muted-foreground">{draft.text}</p>
        <Input name="title" defaultValue={draft.title} placeholder={t('clips.editor.title')} autoFocus aria-label={t('clips.editor.title')} />
        <Textarea name="notes" rows={2} placeholder={t('clips.notePlaceholder')} aria-label={t('clips.notePlaceholder')} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" size="sm" onClick={onCancel} disabled={saving}>
            {t('clips.cancel')}
          </Button>
          <Button type="submit" size="sm" disabled={saving}>
            {t('clips.save')}
          </Button>
        </div>
      </form>
    </>
  );
}
