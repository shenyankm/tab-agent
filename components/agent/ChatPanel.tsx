import { memo, useEffect, useState, type FormEvent, type RefObject } from 'react';
import { Send, X, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  CardContent,
  CardFooter,
  CardHeader,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import type { I18nKey } from '@/lib/i18n';
import { Markdown } from '@/lib/markdown';
import { clipsPageItem, clipNavUrl, normalizeUrl } from '@/lib/clips-store';
import { showClip } from '@/lib/marks';
import { cn, onPageNav, useStorageValue } from '@/lib/utils';

export type ChatMessage = { role: 'user' | 'agent'; text: string; at?: number };

// shared by the draft-editor and chat panel headers
export const panelHeaderClass = 'flex flex-row items-center justify-between border-b-2 bg-primary p-3 text-primary-foreground';

// memoized bubbles: dragging the pet (pointermove → setPos) and the 1s thinking
// tick re-render FloatingAgent constantly; without memo, every done bubble would
// re-run the markdown parse on each of those frames
const UserBubble = memo(function UserBubble({ msg }: { msg: ChatMessage }) {
  return (
    <div className="flex flex-col items-end">
      <div className="tab-agent-bubble-user">{msg.text}</div>
      {msg.at && <span className="mt-1 text-[10px] text-muted-foreground">{new Date(msg.at).toLocaleTimeString()}</span>}
    </div>
  );
});

const AgentBubble = memo(function AgentBubble({ msg, thinking, status }: { msg: ChatMessage; thinking: boolean; status?: string }) {
  return (
    <div>
      <div className="tab-agent-md">
        {msg.text
          // streaming bubble renders plain text — one markdown parse per
          // turn, on done (parsing every delta was O(n²) on long replies)
          ? thinking && !msg.at
            ? <span className="whitespace-pre-wrap">{msg.text}</span>
            : <Markdown text={msg.text} />
          : status}
      </div>
      {msg.at && <span className="mt-1 block text-[10px] text-muted-foreground">{new Date(msg.at).toLocaleTimeString()}</span>}
    </div>
  );
});

// clips saved on this page (hash-insensitive match); clicking jumps in-page to the
// re-marked text — new-tab navigation only as fallback when the text is gone.
// 订阅挂在列表自身:面板/页签没打开时不随 clipsChanged 全量重读
function ClipList({ t }: { t: (key: I18nKey) => string }) {
  // re-anchor to the new pageUrl after SPA same-document navigations
  const [page, setPage] = useState(() => normalizeUrl(location.href));
  useEffect(() => onPageNav(() => setPage(normalizeUrl(location.href))), []);
  const clips = useStorageValue(clipsPageItem(page), []);

  if (clips.length === 0)
    return <p className="text-xs text-muted-foreground">{t('clips.empty')}</p>;

  return clips.map((clip) => (
    <button
      key={clip.id}
      type="button"
      className="min-w-0 cursor-pointer text-left"
      onClick={() => showClip(clip) || window.open(clipNavUrl(clip))}
      title={clip.text}
    >
      <span className="line-clamp-2 text-sm">{clip.text}</span>
      <span className="mt-1 block truncate text-[10px] text-muted-foreground">
        {new Date(clip.createdAt).toLocaleString()}
      </span>
    </button>
  ));
}

// presentational panel: the chat state machine (messages, port streaming, refs)
// stays in FloatingAgent — it must outlive panel open/close and drives the mascot
export function ChatPanel({
  t,
  tab,
  onTabChange,
  onClose,
  scrollRef,
  srStatus,
  messages,
  thinking,
  startRef,
  query,
  onQueryChange,
  inputRef,
  onSubmit,
  onSummarize,
}: {
  t: (key: I18nKey) => string;
  tab: 'chat' | 'clips';
  onTabChange: (tab: 'chat' | 'clips') => void;
  onClose: () => void;
  scrollRef: RefObject<HTMLDivElement | null>;
  srStatus: string;
  messages: ChatMessage[];
  thinking: boolean;
  startRef: RefObject<number>;
  query: string;
  onQueryChange: (value: string) => void;
  inputRef: RefObject<HTMLInputElement | null>;
  onSubmit: (event: FormEvent) => void;
  onSummarize: () => void;
}) {
  const [now, setNow] = useState(0);
  useEffect(() => {
    if (!thinking) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [thinking]);

  return (
    <>
    <CardHeader className={panelHeaderClass}>
      <div className="flex h-8 items-center gap-0.5 rounded border-2 bg-background p-[3px] text-foreground shadow-md">
        {([['chat', t('widget.tab.chat')], ['clips', t('nav.clips')]] as const).map(([v, label]) => (
          <button
            key={v}
            type="button"
            aria-pressed={tab === v}
            className={cn(
              'flex cursor-pointer items-center rounded-sm px-1.5 py-[2px] text-sm font-medium outline-none select-none hover:bg-accent hover:text-accent-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary',
              tab === v && 'bg-accent text-accent-foreground',
            )}
            onClick={() => onTabChange(v)}
          >
            {label}
          </button>
        ))}
      </div>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        onClick={onClose}
        aria-label={t('widget.close')}
      >
        <X />
      </Button>
    </CardHeader>

    <CardContent ref={scrollRef} className="tab-agent-messages p-4" aria-live="off">
      {/* screen-reader status: the full message area can't be a live region —
          streaming deltas + the 1s thinking ticker would announce every second */}
      <div aria-live="polite" className="sr-only">
        {srStatus}
      </div>
      {tab === 'clips' ? (
        <ClipList t={t} />
      ) : messages.map((msg, i) => (
        msg.role === 'user' ? (
          <UserBubble key={i} msg={msg} />
        ) : (
          <AgentBubble
            key={i}
            msg={msg}
            thinking={thinking && i === messages.length - 1}
            // only the live thinking bubble receives the ticking status, so the
            // 1s elapsed counter doesn't bust memoization of done bubbles
            status={!msg.text
              ? `${t('widget.status.thinking')}… ${Math.max(0, Math.floor(((now || Date.now()) - startRef.current) / 1000))}s`
              : undefined}
          />
        )
      ))}
    </CardContent>

    {tab === 'chat' && (
    <CardFooter className="flex-col gap-2 p-3">
      <form className="flex w-full gap-2" onSubmit={onSubmit}>
        <label className="sr-only" htmlFor="tab-agent-query">
          {t('widget.placeholder')}
        </label>
        <Input
          ref={inputRef}
          id="tab-agent-query"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder={t('widget.placeholder')}
          autoComplete="off"
        />
        <Button
          type="button"
          size="icon"
          variant="outline"
          onClick={onSummarize}
          aria-label={t('widget.summarize.btn')}
          title={t('widget.summarize.btn')}
        >
          <Sparkles />
        </Button>
        <Button
          type="submit"
          size="icon"
          disabled={!query.trim()}
          aria-label={t('widget.send')}
        >
          <Send />
        </Button>
      </form>
    </CardFooter>
    )}
    </>
  );
}
