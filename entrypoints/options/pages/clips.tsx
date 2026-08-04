import { useState } from 'react';
import { Trash2, ChevronLeft, ChevronRight, Pencil, Link, EllipsisVertical } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { RadioDropdown } from '@/components/radio-dropdown';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { CategoryChips } from '@/components/category-chips';
import { useI18n } from '@/lib/i18n';
import { parseNoteLines, useStorageValue } from '@/lib/utils';
import { clipsItem, removeClip, updateClip, clipNavUrl, type Clip } from '@/lib/clips-store';

const PAGE_SIZE = 10;

export default function ClipsPage() {
  const { t } = useI18n();
  const clips = useStorageValue(clipsItem, []);
  const [query, setQuery] = useState('');
  const [view, setView] = useState<'time' | 'site'>('time');
  const [page, setPage] = useState(1);
  const [cat, setCat] = useState<string | null>(null);
  const [editingNote, setEditingNote] = useState<string | null>(null);
  const [noteText, setNoteText] = useState('');
  const [deleting, setDeleting] = useState<Clip | null>(null);

  const cats = useMemo(
    () => [...new Set(clips.map((c) => c.category).filter((v): v is string => !!v))].sort(),
    [clips],
  );
  const q = query.trim().toLowerCase();
  const shown = useMemo(
    () => q
      ? clips.filter((c) => [c.text, c.title, c.pageUrl, ...(c.tags ?? [])].some((v) => v.toLowerCase().includes(q)))
      : clips,
    [clips, q],
  );
  // category filter composes with search; site view groups the same filtered set
  const filtered = useMemo(() => (cat ? shown.filter((c) => c.category === cat) : shown), [shown, cat]);
  // no re-sort: getClipsDirect already returns newest-first, watches re-fetch the same order

  // deletions/search can shrink the list under the cursor: clamp instead of resetting
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const cur = Math.min(page, pages);
  const paged = filtered.slice((cur - 1) * PAGE_SIZE, cur * PAGE_SIZE);

  // site view groups the CURRENT PAGE (not the full list): thousands of clips must
  // not mount thousands of rows at once. newest-first inside groups, groups ordered
  // by their newest clip
  const bySite = useMemo(() => {
    const map = new Map<string, Clip[]>();
    for (const c of view === 'site' ? paged : []) {
      let host: string;
      try {
        host = new URL(c.pageUrl).hostname;
      } catch {
        host = c.pageUrl; // dirty legacy data: group under the raw value, don't crash the page
      }
      if (!map.has(host)) map.set(host, []);
      map.get(host)!.push(c);
    }
    return map;
  }, [view, paged]);

  const row = (clip: Clip) => (
    <div key={clip.id}>
    <div className="flex items-center gap-2 border-b border-border py-3">
      <button
        type="button"
        className="min-w-0 flex-1 cursor-pointer text-left"
        onClick={() => browser.tabs.create({ url: clipNavUrl(clip) })}
        title={clip.text}
      >
        <span className="line-clamp-2 text-sm">{clip.text}</span>
        <span className="mt-1 block truncate text-xs text-muted-foreground">
          {clip.title} · {clip.pageUrl} · {new Date(clip.createdAt).toLocaleString()}
          {clip.tags?.length ? ` · ${clip.tags.map((tag) => `#${tag}`).join(' ')}` : ''}
        </span>
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label={t('clips.moreActions')}>
            <EllipsisVertical />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-0">
          <DropdownMenuItem onClick={() => navigator.clipboard.writeText(clip.url)}>
            <Link /> {t('clips.copyLink')}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => {
            setEditingNote(editingNote === clip.id ? null : clip.id);
            setNoteText(clip.notes?.join('\n') ?? '');
          }}>
            <Pencil /> {t('clips.editNote')}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => setDeleting(clip)}>
            <Trash2 /> {t('clips.delete')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
    {editingNote === clip.id && (
      <div className="border-b border-border pb-3">
        <Textarea
          value={noteText}
          onChange={(e) => setNoteText(e.target.value)}
          rows={3}
          placeholder={t('clips.notePlaceholder')}
        />
        <div className="mt-2 flex justify-end gap-2">
          <Button variant="outline" size="sm" onClick={() => setEditingNote(null)}>
            {t('clips.cancel')}
          </Button>
          <Button
            variant="default"
            size="sm"
            onClick={() => {
              updateClip(clip.id, { notes: parseNoteLines(noteText) })
                .then(() => setEditingNote(null))
                .catch(() => { /* 保存失败:编辑器保持打开,可重试 */ });
            }}
          >
            {t('clips.save')}
          </Button>
        </div>
      </div>
    )}
    </div>
  );

  return (
    <>
      <div className="flex items-center gap-2">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('clips.search')}
        />
        <RadioDropdown
          className="shrink-0"
          value={view}
          onChange={(v) => { setView(v); setPage(1); }}
          options={[
            ['time', t('clips.view.time')],
            ['site', t('clips.view.site')],
          ]}
        />
      </div>

      {cats.length > 0 && (
        <div className="mt-2">
          <CategoryChips cats={cats} selected={cat} onToggle={setCat} />
        </div>
      )}

      {filtered.length === 0 && (
        <p className="mt-6 text-sm text-muted-foreground">{t('clips.empty')}</p>
      )}

      {view === 'site' ? (
        [...bySite].map(([host, list]) => (
          <div key={host} className="mt-4">
            <h4 className="text-sm font-medium">{host}</h4>
            <div className="flex flex-col">{list.map(row)}</div>
          </div>
        ))
      ) : (
        <div className="mt-4 flex flex-col">{paged.map(row)}</div>
      )}

      {pages > 1 && (
        <div className="mt-6 flex items-center justify-center gap-0.5">
          <Button
            variant="outline"
            size="sm"
            disabled={cur === 1}
            onClick={() => setPage(cur - 1)}
            aria-label={t('clips.prev')}
          >
            <ChevronLeft className="size-4" />
            <span className="hidden sm:inline">{t('clips.prev')}</span>
          </Button>
          {/* ponytail: every page number rendered, no ellipsis windowing; add it if clip counts ever reach thousands */}
          {Array.from({ length: pages }, (_, i) => (
            <Button
              key={i}
              variant={i + 1 === cur ? 'default' : 'ghost'}
              size="icon-sm"
              onClick={() => setPage(i + 1)}
              aria-current={i + 1 === cur ? 'page' : undefined}
            >
              {i + 1}
            </Button>
          ))}
          <Button
            variant="outline"
            size="sm"
            disabled={cur === pages}
            onClick={() => setPage(cur + 1)}
            aria-label={t('clips.next')}
          >
            <ChevronRight className="size-4" />
            <span className="hidden sm:inline">{t('clips.next')}</span>
          </Button>
        </div>
      )}

      <AlertDialog open={!!deleting} onOpenChange={(open) => { if (!open) setDeleting(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('clips.confirmDelete')}</AlertDialogTitle>
            <AlertDialogDescription className="line-clamp-2">{deleting?.text}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('clips.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={(e) => {
                if (!deleting) return;
                e.preventDefault(); // 手动控制关闭时机:失败时对话框保持打开
                removeClip(deleting.id)
                  .then(() => setDeleting(null))
                  .catch(() => { /* 删除失败:对话框保持打开,可重试 */ });
              }}
            >
              {t('clips.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
