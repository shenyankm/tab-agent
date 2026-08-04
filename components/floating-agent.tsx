import { useEffect, useRef, useState, type FormEvent, type PointerEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { useI18n } from '@/lib/i18n';
import { cn, useStorageValue } from '@/lib/utils';
import { themeItem, petEnabledItem, petPosItem, pageCarryItem, isDark } from '@/lib/settings';
import { pageText } from '@/lib/page-text';
import { draftEvents, setEditorMounted, type ClipDraft } from '@/lib/marks';
import { Mascot, type AgentState } from '@/components/agent/Mascot';
import { ChatPanel, type ChatMessage } from '@/components/agent/ChatPanel';
import { ClipDraftEditor } from '@/components/agent/ClipDraftEditor';

// keep the pet fully on screen regardless of viewport size; clamp order matters:
// a viewport narrower than the pet must pin it to 0, not push it off-screen
const clampPos = (p: { right: number; bottom: number }) => ({
  right: Math.max(0, Math.min(p.right, window.innerWidth - 84)),
  bottom: Math.max(0, Math.min(p.bottom, window.innerHeight - 78)),
});

export function FloatingAgent() {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<AgentState>('idle');
  // compact screen-reader status (thinking / errors) — the message area itself
  // is aria-live="off" so streaming deltas don't announce every frame
  const [srStatus, setSrStatus] = useState('');
  // re-render trigger only: isDark(theme) reads matchMedia live at render time,
  // so theme:"system" follows OS flips without a page reload
  const [, setOsDark] = useState(() => matchMedia('(prefers-color-scheme: dark)').matches);
  useEffect(() => {
    const mq = matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => setOsDark(mq.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  const theme = useStorageValue(themeItem, 'system');
  const enabled = useStorageValue(petEnabledItem, true);
  const [pos, setPos] = useState({ right: 20, bottom: 20 });
  const [query, setQuery] = useState('');
  const carry = useStorageValue(pageCarryItem, 'article');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [tab, setTab] = useState<'chat' | 'clips'>('chat');
  const [draft, setDraft] = useState<ClipDraft | null>(null);
  const [now, setNow] = useState(0); // 1s tick while thinking, drives the elapsed counter
  const startRef = useRef(0);
  const shellRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const launcherRef = useRef<HTMLButtonElement>(null);
  const portRef = useRef<ReturnType<typeof browser.runtime.connect> | null>(null);
  const dragRef = useRef<{ x: number; y: number; right: number; bottom: number; moved: boolean } | null>(null);
  // latest clamped position during a drag, committed to state once on pointerup
  const dragPosRef = useRef<{ right: number; bottom: number } | null>(null);
  const movedRef = useRef(false);
  const selRef = useRef(''); // page selection captured at pointerdown (click collapses it)
  const { t } = useI18n();

  useEffect(() => {
    // invalidated context (reload/update) rejects the read: keep the default
    // position instead of an unhandled rejection in the page console
    petPosItem.getValue().then((p) => setPos(clampPos(p))).catch(() => {});
  }, []);

  useEffect(() => {
    setEditorMounted(true);
    const onDraft = (e: Event) => setDraft((e as CustomEvent<ClipDraft>).detail);
    draftEvents.addEventListener('draft', onDraft);
    return () => {
      setEditorMounted(false);
      draftEvents.removeEventListener('draft', onDraft);
    };
  }, []);

  // devtools, split screen and window resizes shrink the viewport; without this the
  // pet stays parked outside it and looks like it vanished
  useEffect(() => {
    // same-value bailout: clampPos allocates a fresh object per call, and an
    // unchanged position must not re-render the tree on every resize tick
    const onResize = () => setPos((p) => {
      const c = clampPos(p);
      return c.right === p.right && c.bottom === p.bottom ? p : c;
    });
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

  // warm the page-text cache at idle while the user types — the Readability pass
  // (full-DOM clone) must not run on the click path of the first question
  useEffect(() => {
    if (!open || carry !== 'article') return;
    // jsdom (tests) lacks requestIdleCallback
    const ric = window.requestIdleCallback ?? ((cb: () => void) => setTimeout(cb, 1) as unknown as number);
    const cic = window.cancelIdleCallback ?? clearTimeout;
    const id = ric(() => pageText());
    return () => cic(id);
  }, [open, carry]);

  // keep the newest message in view
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  useEffect(() => () => {
    portRef.current?.disconnect();
    cancelAnimationFrame(rafRef.current);
  }, []);

  useEffect(() => {
    if (state !== 'thinking') return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [state]);

  // append streamed text to the trailing agent message; deltas coalesce into one
  // setState per animation frame — re-parsing markdown on every delta was O(n²)
  // on long replies and blocked the page's main thread
  const pendingRef = useRef<{ text: string; replace: boolean } | null>(null);
  const rafRef = useRef(0);
  const applyPending = () => {
    rafRef.current = 0;
    const p = pendingRef.current!;
    pendingRef.current = null;
    setMessages((m) => m.map((msg, i) => (
      i === m.length - 1 ? { ...msg, text: p.replace ? p.text : msg.text + p.text } : msg
    )));
  };
  const flushPending = () => {
    if (!rafRef.current) return;
    cancelAnimationFrame(rafRef.current);
    applyPending();
  };
  const patchLast = (text: string, replace = false) => {
    pendingRef.current = replace
      ? { text, replace: true }
      : { text: (pendingRef.current?.text ?? '') + text, replace: false };
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(applyPending);
  };

  // stamp the trailing agent message with its receive time
  const stampLast = () =>
    setMessages((m) => m.map((msg, i) => (i === m.length - 1 ? { ...msg, at: Date.now() } : msg)));

  const send = (message: string) => {
    if (!message) return; // re-submit while thinking = cancel + new turn (background cancels via 409)

    portRef.current?.disconnect();
    // 取消旧回合：丢弃未落盘的 delta，防止泄漏进新回合气泡
    cancelAnimationFrame(rafRef.current);
    rafRef.current = 0;
    pendingRef.current = null;
    // drop the aborted turn's empty agent bubble so it doesn't sit on "Thinking…" forever
    setMessages((m) => [
      ...(m.at(-1)?.role === 'agent' && !m.at(-1)!.text ? m.slice(0, -1) : m),
      { role: 'user', text: message, at: Date.now() },
      { role: 'agent', text: '' },
    ]);
    setState('thinking');
    setSrStatus(t('widget.status.thinking'));
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
        flushPending(); // land any un-flushed deltas before the stamp
        stampLast();
        setState('done');
        setSrStatus('');
        port.disconnect();
      } else if (msg.type === 'error') {
        settled = true;
        const errText = msg.code === 'auth'
          ? t('widget.error.auth')
          : msg.code === 'unconfigured'
            ? t('widget.error.unconfigured')
            : t('widget.error.generic', { message: msg.message ?? '' });
        patchLast(errText, true);
        flushPending(); // the replace lands synchronously, before the stamp
        stampLast();
        setState('done');
        setSrStatus(errText);
        port.disconnect();
      }
    });
    // background worker died mid-turn (MV3 idle kill, update, crash): surface it
    // instead of hanging on "Thinking…" — only the remote end firing lands here
    port.onDisconnect.addListener(() => {
      // re-submit 替换掉的旧 port：其断开是取消的一部分，不渲染错误
      if (settled || portRef.current !== port) return;
      patchLast(t('widget.error.disconnected'), true);
      flushPending();
      stampLast();
      setState('done');
      setSrStatus(t('widget.error.disconnected'));
    });
    port.postMessage({
      text: message,
      // 'screenshot' is captured by the background (content scripts can't)
      screenshot: carry === 'screenshot' || undefined,
      // page context so the cloud agent can actually see the current page
      page: {
        url: location.href,
        title: document.title,
        // pageText() 缓存的已是 20k 截断形态(page-text.ts),无需再切
        text: carry === 'article' ? pageText() : '',
      },
    });
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    send(query.trim());
    setQuery('');
  };

  const closePanel = () => {
    setOpen(false);
    requestAnimationFrame(() => launcherRef.current?.focus());
  };

  if (!enabled) return null;

  const onPointerDown = (event: PointerEvent<HTMLButtonElement>) => {
    selRef.current = window.getSelection()?.toString().trim() ?? '';
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
    const c = clampPos({ right: d.right - dx, bottom: d.bottom - dy });
    dragPosRef.current = c;
    // write straight to the shell during the drag: a setPos per pointermove would
    // re-render the whole tree (panel + message list) at pointer rate; state and
    // storage commit once on pointerup
    const shell = shellRef.current;
    if (shell) {
      shell.style.right = `${c.right}px`;
      shell.style.bottom = `${c.bottom}px`;
    }
  };

  // also handles pointercancel (window blur while held, native drag, Esc): leaving
  // dragRef set makes the pet chase the cursor on plain hover and eats every later click
  const onPointerUp = (event: PointerEvent<HTMLButtonElement>) => {
    const d = dragRef.current;
    dragRef.current = null;
    movedRef.current = !!d?.moved;
    if (!d?.moved) return;
    const c = dragPosRef.current ?? clampPos({
      right: d.right - (event.clientX - d.x),
      bottom: d.bottom - (event.clientY - d.y),
    });
    dragPosRef.current = null;
    setPos(c); // one commit: panel side/maxHeight recompute on this render
    petPosItem.setValue(c);
  };

  // open the panel toward the roomier half of the viewport so it never gets clipped
  const below = window.innerHeight - pos.bottom - 39 < window.innerHeight / 2;
  const alignLeft = window.innerWidth - pos.right - 42 < window.innerWidth / 2;

  return (
    <div
      ref={shellRef}
      className={cn('tab-agent-shell', isDark(theme) ? 'dark' : '')}
      style={{ right: pos.right, bottom: pos.bottom }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') (draft ? setDraft(null) : closePanel());
      }}
    >
      {(open || draft) && (
        <Card
          id="tab-agent-panel"
          className={cn('tab-agent-panel gap-0 py-0', below && 'tab-agent-panel--below', alignLeft && 'tab-agent-panel--left')}
          style={{ maxHeight: Math.min(480, Math.max(180, below ? pos.bottom - 20 : window.innerHeight - pos.bottom - 98)) }}
          role="dialog"
          aria-label={draft ? t('clips.editor.heading') : 'Tab Agent'}
        >
          {draft ? (
            <ClipDraftEditor t={t} draft={draft} onCancel={() => setDraft(null)} />
          ) : (
            <ChatPanel
              t={t}
              tab={tab}
              onTabChange={setTab}
              onClose={closePanel}
              scrollRef={scrollRef}
              srStatus={srStatus}
              messages={messages}
              thinking={state === 'thinking'}
              now={now}
              startRef={startRef}
              query={query}
              onQueryChange={setQuery}
              inputRef={inputRef}
              onSubmit={submit}
              onSummarize={() => send(t('widget.summarize'))}
            />
          )}
        </Card>
      )}

      <Button
        ref={launcherRef}
        type="button"
        variant="ghost"
        className="tab-agent-launcher"
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
        aria-controls="tab-agent-panel"
      >
        <Mascot state={state} size={72} />
      </Button>
    </div>
  );
}
