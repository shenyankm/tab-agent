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
import { useI18n } from '@/lib/i18n';
import { themeItem, petEnabledItem, petPosItem, pageCarryItem, isDark, type Theme, type PageCarry } from '@/lib/settings';
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

type ChatMessage = { role: 'user' | 'agent'; text: string };

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

export function FloatingAgent() {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<AgentState>('idle');
  const [theme, setTheme] = useState<Theme>('system');
  const [enabled, setEnabled] = useState(true);
  const [pos, setPos] = useState({ right: 20, bottom: 20 });
  const [query, setQuery] = useState('');
  const [carry, setCarry] = useState<PageCarry>('article');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const launcherRef = useRef<HTMLButtonElement>(null);
  const portRef = useRef<ReturnType<typeof browser.runtime.connect> | null>(null);
  const dragRef = useRef<{ x: number; y: number; right: number; bottom: number; moved: boolean } | null>(null);
  const movedRef = useRef(false);
  const selRef = useRef(''); // page selection captured at pointerdown (click collapses it)
  const { t } = useI18n();

  useEffect(() => {
    themeItem.getValue().then(setTheme);
    return themeItem.watch(setTheme);
  }, []);

  useEffect(() => {
    petEnabledItem.getValue().then(setEnabled);
    return petEnabledItem.watch(setEnabled);
  }, []);

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
    pageCarryItem.getValue().then(setCarry);
    return pageCarryItem.watch(setCarry);
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

  // append streamed text to the trailing agent message
  const patchLast = (text: string, replace = false) =>
    setMessages((m) => m.map((msg, i) => (
      i === m.length - 1 ? { ...msg, text: replace ? text : msg.text + text } : msg
    )));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const message = query.trim();
    if (!message) return; // re-submit while thinking = cancel + new turn (background cancels via 409)

    portRef.current?.disconnect();
    setQuery('');
    // drop the aborted turn's empty agent bubble so it doesn't sit on "Thinking…" forever
    setMessages((m) => [
      ...(m.at(-1)?.role === 'agent' && !m.at(-1)!.text ? m.slice(0, -1) : m),
      { role: 'user', text: message },
      { role: 'agent', text: '' },
    ]);
    setState('thinking');

    const port = browser.runtime.connect({ name: 'chat' });
    portRef.current = port;
    port.onMessage.addListener((msg: { type: string; text?: string; code?: string; message?: string }) => {
      if (msg.type === 'delta') {
        patchLast(msg.text ?? '');
      } else if (msg.type === 'done') {
        setState('done');
        port.disconnect();
      } else if (msg.type === 'error') {
        patchLast(msg.code === 'auth'
          ? t('widget.error.auth')
          : msg.code === 'unconfigured'
            ? t('widget.error.unconfigured')
            : t('widget.error.generic', { message: msg.message ?? '' }), true);
        setState('done');
        port.disconnect();
      }
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
          <CardHeader className="flex flex-row items-center justify-end border-b-2 bg-primary p-3 text-primary-foreground">
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
            {messages.map((msg, i) => (
              msg.role === 'user' ? (
                <div key={i} className="pixel-agent-bubble-user">{msg.text}</div>
              ) : (
                <div key={i} className="pixel-agent-md">
                  {msg.text
                    ? <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.text}</ReactMarkdown>
                    : `${t('widget.status.thinking')}…`}
                </div>
              )
            ))}
          </CardContent>

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
