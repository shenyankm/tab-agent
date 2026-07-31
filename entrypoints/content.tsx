import { useEffect, useRef, useState, type FormEvent, type PointerEvent } from 'react';
import ReactDOM from 'react-dom/client';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Send, X } from 'lucide-react';
import { Readability } from '@mozilla/readability';
import TurndownService from 'turndown';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Menubar, MenubarTrigger } from '@/components/ui/menubar';
import { useI18n } from '@/lib/i18n';
import { useStorageValue } from '@/lib/utils';
import { addClip, buildClipUrl, clipsItem, highlightClip, removeMarks, clipNavUrl, stripHash, type Clip } from '@/lib/clips';
import { themeItem, petEnabledItem, petPosItem, pageCarryItem, clipHighlightItem, isDark } from '@/lib/settings';
import '@/assets/content.css';

type AgentState = 'idle' | 'thinking' | 'done';

// 3-frame strip cropped from the full sheet (184×168 each) — keeps decoded RAM tiny per tab
const sheet = { width: 552, height: 168 };
const faces: Record<AgentState, { x: number; y: number }> = {
  idle: { x: 0, y: 0 },
  thinking: { x: 184, y: 0 },
  done: { x: 368, y: 0 },
};

function Mascot({ state, size }: { state: AgentState; size: number }) {
  const face = faces[state];
  const scale = size / 184;

  return (
    <span
      className={`pixel-agent-mascot pixel-agent-mascot--${state}`}
      style={{ width: size, height: 168 * scale }}
      aria-hidden="true"
    >
      <img
        src={browser.runtime.getURL('/mascot-expressions.webp')}
        alt=""
        draggable={false}
        style={{
          width: sheet.width * scale,
          height: sheet.height * scale,
          transform: `translate(${-face.x * scale}px, ${-face.y * scale}px)`,
        }}
      />
    </span>
  );
}

// keep the pet fully on screen regardless of viewport size; clamp order matters:
// a viewport narrower than the pet must pin it to 0, not push it off-screen
const clampPos = (p: { right: number; bottom: number }) => ({
  right: Math.max(0, Math.min(p.right, window.innerWidth - 84)),
  bottom: Math.max(0, Math.min(p.bottom, window.innerHeight - 78)),
});

type ChatMessage = { role: 'user' | 'agent'; text: string; at?: number };

// ponytail: everything ships eagerly — WXT bundles content scripts as one IIFE and
// inlines dynamic imports (verified: lazy-loading grew the bundle); revisit if WXT
// ever supports content-script code splitting

// Readability mutates its input, so it gets a clone; null/throw (non-article pages,
// framesets) falls back to raw innerText
function pageMarkdown() {
  try {
    const article = new Readability(document.cloneNode(true) as Document).parse();
    if (article?.content) return new TurndownService().turndown(article.content);
  } catch { /* fall through */ }
  return document.body.innerText;
}

// clip id → its <mark>s: re-clicks scroll to the existing marks instead of nesting new ones
const markByClip = new Map<string, Element[]>();

function showClip(clip: Clip, scroll = true): boolean {
  const marks = markByClip.get(clip.id) ?? highlightClip(clip);
  if (!marks.length) return false;
  markByClip.set(clip.id, marks);
  if (scroll) {
    marks[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
    // highlighting off = locate-only: flash the marks, then fade them out
    clipHighlightItem.getValue().then((on) => {
      if (on) return;
      setTimeout(() => {
        if (markByClip.delete(clip.id)) removeMarks(marks); // already-gone marks no-op
      }, 3000);
    });
  }
  return true;
}

// clips saved on this page (hash-insensitive match); clicking jumps in-page to the
// re-marked text — new-tab navigation only as fallback when the text is gone
function ClipList({ clips, t }: { clips: Clip[]; t: (key: string) => string }) {
  const page = stripHash(location.href);
  const pageClips = clips.filter((c) => stripHash(c.pageUrl) === page);

  if (pageClips.length === 0)
    return <p className="text-xs text-muted-foreground">{t('clips.empty')}</p>;

  return pageClips.map((clip) => (
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

export function FloatingAgent() {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<AgentState>('idle');
  const theme = useStorageValue(themeItem, 'system');
  const enabled = useStorageValue(petEnabledItem, true);
  const [pos, setPos] = useState({ right: 20, bottom: 20 });
  const [query, setQuery] = useState('');
  const carry = useStorageValue(pageCarryItem, 'article');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [tab, setTab] = useState<'chat' | 'clips'>('chat');
  const clips = useStorageValue(clipsItem, []);
  const [now, setNow] = useState(0); // 1s tick while thinking, drives the elapsed counter
  const startRef = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const launcherRef = useRef<HTMLButtonElement>(null);
  const portRef = useRef<ReturnType<typeof browser.runtime.connect> | null>(null);
  const dragRef = useRef<{ x: number; y: number; right: number; bottom: number; moved: boolean } | null>(null);
  const movedRef = useRef(false);
  const selRef = useRef(''); // page selection captured at pointerdown (click collapses it)
  const { t } = useI18n();

  useEffect(() => {
    petPosItem.getValue().then((p) => setPos(clampPos(p)));
  }, []);

  // devtools, split screen and window resizes shrink the viewport; without this the
  // pet stays parked outside it and looks like it vanished
  useEffect(() => {
    const onResize = () => setPos(clampPos);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  useEffect(() => {
    if (open) requestAnimationFrame(() => inputRef.current?.focus());
    // greet on first open
    if (open) setMessages((m) => (m.length ? m : [{ role: 'agent', text: t('widget.greeting') }]));
    // 划词翻译: selected text pre-fills a translate prompt; target language rides the UI locale
    if (open && selRef.current) setQuery(t('widget.translate', { text: selRef.current }));
  }, [open]);

  // keep the newest message in view
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  useEffect(() => () => portRef.current?.disconnect(), []);

  useEffect(() => {
    if (state !== 'thinking') return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [state]);

  // append streamed text to the trailing agent message
  const patchLast = (text: string, replace = false) =>
    setMessages((m) => m.map((msg, i) => (
      i === m.length - 1 ? { ...msg, text: replace ? text : msg.text + text } : msg
    )));

  // stamp the trailing agent message with its receive time
  const stampLast = () =>
    setMessages((m) => m.map((msg, i) => (i === m.length - 1 ? { ...msg, at: Date.now() } : msg)));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const message = query.trim();
    if (!message) return; // re-submit while thinking = cancel + new turn (background cancels via 409)

    portRef.current?.disconnect();
    setQuery('');
    // drop the aborted turn's empty agent bubble so it doesn't sit on "Thinking…" forever
    setMessages((m) => [
      ...(m.at(-1)?.role === 'agent' && !m.at(-1)!.text ? m.slice(0, -1) : m),
      { role: 'user', text: message, at: Date.now() },
      { role: 'agent', text: '' },
    ]);
    setState('thinking');
    startRef.current = Date.now();
    setNow(Date.now());

    const port = browser.runtime.connect({ name: 'chat' });
    portRef.current = port;
    let settled = false; // done/error already rendered — a later disconnect is normal teardown
    port.onMessage.addListener((msg: { type: string; text?: string; code?: string; message?: string }) => {
      if (msg.type === 'delta') {
        patchLast(msg.text ?? '');
      } else if (msg.type === 'done') {
        settled = true;
        stampLast();
        setState('done');
        port.disconnect();
      } else if (msg.type === 'error') {
        settled = true;
        patchLast(msg.code === 'auth'
          ? t('widget.error.auth')
          : msg.code === 'unconfigured'
            ? t('widget.error.unconfigured')
            : t('widget.error.generic', { message: msg.message ?? '' }), true);
        stampLast();
        setState('done');
        port.disconnect();
      }
    });
    // background worker died mid-turn (MV3 idle kill, update, crash): surface it
    // instead of hanging on "Thinking…" — only the remote end firing lands here
    port.onDisconnect.addListener(() => {
      if (settled) return;
      patchLast(t('widget.error.disconnected'), true);
      stampLast();
      setState('done');
    });
    port.postMessage({
      text: message,
      // 'screenshot' is captured by the background (content scripts can't)
      screenshot: carry === 'screenshot' || undefined,
      // page context so the cloud agent can actually see the current page
      page: {
        url: location.href,
        title: document.title,
        // ponytail: 20k char cap; per-section chunking if long articles get truncated
        text: carry === 'article' ? pageMarkdown().slice(0, 20000) : '',
      },
    });
  };

  const closePanel = () => {
    setOpen(false);
    requestAnimationFrame(() => launcherRef.current?.focus());
  };

  if (!enabled) return null;

  const onPointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    // ponytail: 2k cap keeps the single-line input sane; raise if long-form translation matters
    selRef.current = window.getSelection()?.toString().trim().slice(0, 2000) ?? '';
    dragRef.current = { x: event.clientX, y: event.clientY, ...pos, moved: false };
    movedRef.current = false; // a dropped pointerup must not swallow this click too
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: PointerEvent<HTMLButtonElement>) => {
    const d = dragRef.current;
    // buttons === 0 is a plain hover: whichever release event went missing (cancel,
    // failed pointer capture, blur), a hover can never be a drag
    if (!d || !event.buttons) {
      dragRef.current = null;
      return;
    }
    const dx = event.clientX - d.x;
    const dy = event.clientY - d.y;
    if (!d.moved && Math.hypot(dx, dy) < 4) return; // below threshold: still a click
    d.moved = true;
    setPos(clampPos({ right: d.right - dx, bottom: d.bottom - dy }));
  };

  // also handles pointercancel (window blur while held, native drag, Esc): leaving
  // dragRef set makes the pet chase the cursor on plain hover and eats every later click
  const onPointerUp = (event: PointerEvent<HTMLButtonElement>) => {
    const d = dragRef.current;
    dragRef.current = null;
    movedRef.current = !!d?.moved;
    if (!d?.moved) return;
    petPosItem.setValue(clampPos({
      right: d.right - (event.clientX - d.x),
      bottom: d.bottom - (event.clientY - d.y),
    }));
  };

  // open the panel toward the roomier half of the viewport so it never gets clipped
  const below = window.innerHeight - pos.bottom - 39 < window.innerHeight / 2;
  const alignLeft = window.innerWidth - pos.right - 42 < window.innerWidth / 2;

  return (
    <div
      className={`pixel-agent-shell${isDark(theme) ? ' dark' : ''}`}
      style={{ right: pos.right, bottom: pos.bottom }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') closePanel();
      }}
    >
      {open && (
        <Card
          id="pixel-agent-panel"
          className={`pixel-agent-panel${below ? ' pixel-agent-panel--below' : ''}${alignLeft ? ' pixel-agent-panel--left' : ''} gap-0 py-0`}
          style={{ maxHeight: Math.min(480, Math.max(180, below ? pos.bottom - 20 : window.innerHeight - pos.bottom - 98)) }}
          role="dialog"
          aria-label="Pixel Agent"
        >
          <CardHeader className="flex flex-row items-center justify-between border-b-2 bg-primary p-3 text-primary-foreground">
            <Menubar>
              <MenubarTrigger active={tab === 'chat'} onClick={() => setTab('chat')}>
                {t('widget.tab.chat')}
              </MenubarTrigger>
              <MenubarTrigger active={tab === 'clips'} onClick={() => setTab('clips')}>
                {t('nav.clips')}
              </MenubarTrigger>
            </Menubar>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={closePanel}
              aria-label={t('widget.close')}
            >
              <X />
            </Button>
          </CardHeader>

          <CardContent ref={scrollRef} className="pixel-agent-messages p-4" aria-live="polite">
            {tab === 'clips' ? (
              <ClipList clips={clips} t={t} />
            ) : messages.map((msg, i) => (
              msg.role === 'user' ? (
                <div key={i} className="flex flex-col items-end">
                  <div className="pixel-agent-bubble-user">{msg.text}</div>
                  {msg.at && <span className="mt-1 text-[10px] text-muted-foreground">{new Date(msg.at).toLocaleTimeString()}</span>}
                </div>
              ) : (
                <div key={i}>
                  <div className="pixel-agent-md">
                    {msg.text
                      ? <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.text}</ReactMarkdown>
                      : `${t('widget.status.thinking')}… ${Math.max(0, Math.floor(((now || Date.now()) - startRef.current) / 1000))}s`}
                  </div>
                  {msg.at && <span className="mt-1 block text-[10px] text-muted-foreground">{new Date(msg.at).toLocaleTimeString()}</span>}
                </div>
              )
            ))}
          </CardContent>

          {tab === 'chat' && (
          <CardFooter className="flex-col gap-2 p-3">
            <form className="flex w-full gap-2" onSubmit={submit}>
              <label className="sr-only" htmlFor="pixel-agent-query">
                {t('widget.placeholder')}
              </label>
              <Input
                ref={inputRef}
                id="pixel-agent-query"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t('widget.placeholder')}
                autoComplete="off"
              />
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
        </Card>
      )}

      <Button
        ref={launcherRef}
        type="button"
        variant="ghost"
        className="pixel-agent-launcher"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onClick={() => {
          if (movedRef.current) return; // drag, not a click
          setOpen((value) => !value);
        }}
        aria-label={open ? t('widget.close') : t('widget.open')}
        aria-expanded={open}
        aria-controls="pixel-agent-panel"
      >
        <Mascot state={state} size={72} />
      </Button>
    </div>
  );
}

export default defineContentScript({
  matches: ['<all_urls>'],
  cssInjectionMode: 'ui',
  async main(ctx) {
    // "save clip" from the background context menu: selection → text-fragment URL → storage
    browser.runtime.onMessage.addListener((msg: { type?: string }) => {
      if (msg?.type !== 'saveClip') return;
      const sel = window.getSelection();
      const text = sel?.toString().trim();
      if (!sel || !text) return;
      addClip({
        url: buildClipUrl(location.href, sel),
        pageUrl: location.href,
        title: document.title,
        text,
      }).then(async (clip) => {
        // mark right away as save feedback, unless highlighting is switched off
        if (await clipHighlightItem.getValue()) showClip(clip, false);
      });
    });

    // re-apply saved highlights: text fragments only fire on navigation, not on reload
    // ponytail: one shot at document_idle; SPA content rendered later stays unmarked until clicked
    const page = stripHash(location.href);
    const applyAll = async () => {
      for (const clip of await clipsItem.getValue())
        if (stripHash(clip.pageUrl) === page) showClip(clip, false);
    };
    clipHighlightItem.getValue().then((on) => { if (on) applyAll(); });

    // 跨页跳转落地（options/面板回退打开的 #pixel-agent-clip=id）：走 showClip 同一条
    // 定位+滚动路径，高亮开关关闭时照常 3s 淡出；消费后清 hash，刷新不重闪
    const navClip = location.hash.match(/^#pixel-agent-clip=(.+)/)?.[1];
    if (navClip) {
      clipsItem.getValue().then((clips) => {
        const clip = clips.find((c) => c.id === navClip);
        if (clip) showClip(clip);
      });
      history.replaceState(null, '', page);
    }
    // the popup switch takes effect live on open tabs
    clipHighlightItem.watch((on) => {
      if (on) return void applyAll();
      for (const marks of markByClip.values()) removeMarks(marks);
      markByClip.clear();
    });

    const ui = await createShadowRootUi(ctx, {
      name: 'pixel-agent-floating-ui',
      position: 'inline',
      isolateEvents: true,
      onMount(container) {
        const root = ReactDOM.createRoot(container);
        root.render(<FloatingAgent />);
        return root;
      },
      onRemove(root) {
        root?.unmount();
      },
    });

    ui.mount();
  },
});
