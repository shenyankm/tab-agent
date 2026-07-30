import { useEffect, useRef, useState, type FormEvent } from 'react';
import ReactDOM from 'react-dom/client';
import { CheckCircle2, LoaderCircle, Send, Sparkles, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { useI18n } from '@/lib/i18n';
import { themeItem, type Theme } from '@/lib/settings';
import '@/assets/content.css';

type AgentState = 'idle' | 'thinking' | 'done';

// ponytail: prototype reuses the supplied sheet; export these three frames if per-tab memory matters.
const sheet = { width: 1536, height: 2288 };
const faces: Record<AgentState, { x: number; y: number }> = {
  idle: { x: 772, y: 852 },
  thinking: { x: 772, y: 1892 },
  done: { x: 388, y: 852 },
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

function FloatingAgent() {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<AgentState>('idle');
  const [theme, setTheme] = useState<Theme>('system');
  const [query, setQuery] = useState('');
  const [lastQuery, setLastQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const launcherRef = useRef<HTMLButtonElement>(null);
  const timerRef = useRef<number | undefined>(undefined);
  const { t } = useI18n();

  useEffect(() => {
    themeItem.getValue().then(setTheme);
    return themeItem.watch(setTheme);
  }, []);

  useEffect(() => {
    if (open) requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  useEffect(() => () => window.clearTimeout(timerRef.current), []);

  const isDark = theme === 'dark'
    || (theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const message = query.trim();
    if (!message || state === 'thinking') return;

    window.clearTimeout(timerRef.current);
    setLastQuery(message);
    setQuery('');
    setState('thinking');
    timerRef.current = window.setTimeout(() => setState('done'), 900);
  };

  const response = state === 'idle'
    ? t('widget.greeting')
    : state === 'thinking'
      ? `${t('widget.status.thinking')}…`
      : t('widget.reply', { message: lastQuery });

  const closePanel = () => {
    setOpen(false);
    requestAnimationFrame(() => launcherRef.current?.focus());
  };

  return (
    <div
      className={`pixel-agent-shell${isDark ? ' dark' : ''}`}
      onKeyDown={(event) => {
        if (event.key === 'Escape') closePanel();
      }}
    >
      {open && (
        <Card
          id="pixel-agent-panel"
          className="pixel-agent-panel gap-0 py-0"
          role="dialog"
          aria-label="Pixel Agent"
        >
          <CardHeader className="flex flex-row items-center gap-3 border-b-2 bg-primary p-3 text-primary-foreground">
            <Mascot state={state} size={48} />
            <div className="min-w-0 flex-1">
              <CardTitle className="font-head text-base">Pixel Agent</CardTitle>
              <div className="mt-0.5 flex items-center gap-1.5 text-xs">
                {state === 'thinking' ? (
                  <LoaderCircle className="size-3.5 animate-spin" />
                ) : state === 'done' ? (
                  <CheckCircle2 className="size-3.5" />
                ) : (
                  <Sparkles className="size-3.5" />
                )}
                {t(`widget.status.${state}`)}
              </div>
            </div>
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

          <CardContent className="p-4">
            <div className="pixel-agent-response" aria-live="polite">
              {response}
            </div>
            <p className="mt-3 text-xs text-muted-foreground">{t('widget.note')}</p>
          </CardContent>

          <CardFooter className="p-3">
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
                disabled={!query.trim() || state === 'thinking'}
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
        onClick={() => setOpen((value) => !value)}
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
