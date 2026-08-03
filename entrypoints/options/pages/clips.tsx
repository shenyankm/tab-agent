import { useState } from 'react';
import { ChevronDown, Trash2, ChevronLeft, ChevronRight, Pencil } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
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
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { useI18n } from '@/lib/i18n';
import { useStorageValue } from '@/lib/utils';
import { clipsItem, removeClip, updateClip, clipNavUrl, type Clip } from '@/lib/clips';

const PAGE_SIZE = 10;

// category color palette — deterministic by category name
export const COLORS = ['#e74c3c', '#3498db', '#2ecc71', '#f39c12', '#9b59b6', '#1abc9c', '#e67e22', '#34495e', '#16a085', '#c0392b'];
export const colorFor = (cat: string, cats: string[]) => COLORS[cats.indexOf(cat) % COLORS.length];

export default function ClipsPage() {
  const { t } = useI18n();
  const clips = useStorageValue(clipsItem, []);
  const [query, setQuery] = useState('');
  const [view, setView] = useState<'time' | 'site'>('time');
  const [page, setPage] = useState(1);
  const [cat, setCat] = useState<string | null>(null);
  const [editingNote, setEditingNote] = useState<string | null>(null);
  const [noteText, setNoteText] = useState('');

  const cats = [...new Set(clips.map((c) => c.category).filter((v): v is string => !!v))].sort();
  const q = query.trim().toLowerCase();
  const shown = q
    ? clips.filter((c) => [c.text, c.title, c.pageUrl].some((v) => v.toLowerCase().includes(q)))
    : clips;
  // category filter composes with search; site view groups the same filtered set
  const filtered = cat ? shown.filter((c) => c.category === cat) : shown;
  // no re-sort: getClipsDirect already returns newest-first, watches re-fetch the same order

  // deletions/search can shrink the list under the cursor: clamp instead of resetting
  const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const cur = Math.min(page, pages);
  const paged = filtered.slice((cur - 1) * PAGE_SIZE, cur * PAGE_SIZE);

  // site view: newest-first inside groups, groups ordered by their newest clip
  const bySite = new Map<string, Clip[]>();
  for (const c of view === 'site' ? filtered : []) {
    const host = new URL(c.pageUrl).hostname;
    bySite.set(host, [...(bySite.get(host) ?? []), c]);
  }

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
        </span>
      </button>
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={() => {
          setEditingNote(editingNote === clip.id ? null : clip.id);
          setNoteText(clip.notes?.join('\n') ?? '');
        }}
        aria-label={t('clips.notePlaceholder')}
        title={t('clips.notePlaceholder')}
      >
        <Pencil />
      </Button>
      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label={t('clips.delete')}>
            <Trash2 />
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('clips.confirmDelete')}</AlertDialogTitle>
            <AlertDialogDescription className="line-clamp-2">{clip.text}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('clips.cancel')}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => removeClip(clip.id)}>
              {t('clips.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
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
              updateClip(clip.id, { notes: noteText.split('\n').map((s) => s.trim()).filter(Boolean) })
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
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" className="shrink-0">
              {t(`clips.view.${view}`)}
              <ChevronDown className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuRadioGroup
              value={view}
              onValueChange={(v) => { setView(v as 'time' | 'site'); setPage(1); }}
            >
              <DropdownMenuRadioItem value="time">{t('clips.view.time')}</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="site">{t('clips.view.site')}</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {cats.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          <button
            type="button"
            className={`rounded px-2 py-0.5 text-xs ${!cat ? 'bg-primary text-primary-foreground' : 'bg-muted'}`}
            onClick={() => setCat(null)}
          >
            {t('clips.all')}
          </button>
          {cats.map((c) => (
            <button
              key={c}
              type="button"
              className={`rounded px-2 py-0.5 text-xs ${cat === c ? 'bg-primary text-primary-foreground' : 'bg-muted'}`}
              style={cat === c ? {} : { borderLeft: `3px solid ${colorFor(c, cats)}` }}
              onClick={() => setCat(cat === c ? null : c)}
            >
              {c}
            </button>
          ))}
        </div>
      )}

      {filtered.length === 0 && (
        <p className="mt-6 text-sm text-muted-foreground">{t('clips.empty')}</p>
      )}

      {view === 'time' ? (
        <>
          <div className="mt-4 flex flex-col">{paged.map(row)}</div>
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
        </>
      ) : (
        [...bySite].map(([host, list]) => (
          <div key={host} className="mt-4">
            <h4 className="text-sm font-medium">{host}</h4>
            <div className="flex flex-col">{list.map(row)}</div>
          </div>
        ))
      )}
    </>
  );
}
