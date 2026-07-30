import { useEffect, useState } from 'react';
import { ChevronDown, ChevronLeft, ChevronRight, Search, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent } from '@/components/ui/card';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from '@/components/ui/dropdown-menu';
import { useI18n, langLabels, type Lang } from '@/lib/i18n';
import { GATEWAY, themeItem, patItem, agentIdItem, envIdItem, vaultIdItem, type Theme } from '@/lib/settings';

type Tab = 'settings' | 'sessions' | 'guide' | 'privacy';

const tabs: Tab[] = ['settings', 'sessions', 'guide', 'privacy'];

function App() {
  // tab persisted in URL hash so refresh keeps the current page
  const [tab, setTabState] = useState<Tab>(() => {
    const h = location.hash.slice(1) as Tab;
    return tabs.includes(h) ? h : 'settings';
  });
  const setTab = (t: Tab) => {
    setTabState(t);
    location.hash = t;
  };
  const { t } = useI18n();

  return (
    <div className="mx-auto max-w-lg p-8">
      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)} className="items-center">
        <TabsList className="mb-8">
          {tabs.map((tb) => (
            <TabsTrigger key={tb} value={tb}>{t(`nav.${tb}`)}</TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="settings" className="w-full"><SettingsPage /></TabsContent>
        <TabsContent value="sessions" className="w-full"><SessionsPage /></TabsContent>
        <TabsContent value="guide" className="w-full">
          <p className="text-sm leading-6">{t('guide.intro')}</p>
          <p className="mt-8 text-sm text-muted-foreground">
            {t('footer.builtWith').split('{link}')[0]}<a href="https://qoder.com/" target="_blank" rel="noopener" className="underline hover:text-foreground">Qoder</a>{t('footer.builtWith').split('{link}')[1]}
          </p>
        </TabsContent>
        <TabsContent value="privacy" className="w-full"><PrivacyPage /></TabsContent>
      </Tabs>
    </div>
  );
}

function PrivacyPage() {
  const { t } = useI18n();
  // RetroUI typography: utility-class recipes, not an installable component
  return (
    <>
      <p className="text-sm text-muted-foreground">{t('privacy.updated')}</p>
      <p className="text-sm leading-6 [&:not(:first-child)]:mt-6">{t('privacy.intro')}</p>

      <h3 className="mt-8 scroll-m-20 text-xl font-semibold tracking-tight">{t('privacy.collect.title')}</h3>
      <p className="text-sm leading-6 mt-2">{t('privacy.collect.body')}</p>
      <ul className="text-sm my-4 ml-6 list-disc [&>li]:mt-2">
        <li>{t('settings.language')}</li>
        <li>{t('settings.theme')}</li>
        <li>{t('settings.pet')}</li>
        <li>{t('settings.pat')} / {t('settings.agentId')} / {t('settings.envId')}</li>
      </ul>

      <h3 className="mt-8 scroll-m-20 text-xl font-semibold tracking-tight">{t('privacy.network.title')}</h3>
      <p className="text-sm leading-6 mt-2">{t('privacy.network.body')}</p>

      <h3 className="mt-8 scroll-m-20 text-xl font-semibold tracking-tight">{t('privacy.permission.title')}</h3>
      <p className="text-sm leading-6 mt-2">{t('privacy.permission.body')}</p>

      <h3 className="mt-8 scroll-m-20 text-xl font-semibold tracking-tight">{t('privacy.share.title')}</h3>
      <p className="text-sm leading-6 mt-2">{t('privacy.share.body')}</p>

      <blockquote className="text-sm mt-6 border-l-2 border-border pl-6 italic">{t('privacy.promise')}</blockquote>
    </>
  );
}

type Session = { id: string; title?: string; status: string; created_at: string };

function SessionsPage() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [query, setQuery] = useState('');
  // cursor stack: cursors[i] loads page i+1; empty stack = first page
  const [cursors, setCursors] = useState<string[]>([]);
  const [nextPage, setNextPage] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const { t } = useI18n();

  const cursor = cursors[cursors.length - 1];

  useEffect(() => {
    let stale = false;
    (async () => {
      setLoading(true);
      setError('');
      try {
        const pat = await patItem.getValue();
        if (!pat) throw Object.assign(new Error(), { code: 'unconfigured' });
        const params = new URLSearchParams({ limit: '20' });
        if (cursor) params.set('page', cursor);
        const res = await fetch(`${GATEWAY}/sessions?${params}`, {
          headers: { Authorization: `Bearer ${pat}` },
        });
        if (res.status === 401 || res.status === 403)
          throw Object.assign(new Error(`HTTP ${res.status}`), { code: 'auth' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = await res.json();
        if (stale) return;
        setSessions(body.data ?? []);
        setNextPage(body.has_more ? body.next_page : null);
      } catch (err: any) {
        if (stale) return;
        setError(
          err.code === 'unconfigured' || err.code === 'auth'
            ? t(`widget.error.${err.code}`)
            : t('widget.error.generic', { message: String(err?.message ?? err) }),
        );
      } finally {
        if (!stale) setLoading(false);
      }
    })();
    return () => {
      stale = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cursor]);

  // ponytail: API has no search param; filters the current 20-item page only
  const filtered = sessions.filter((s) =>
    (s.title || s.id).toLowerCase().includes(query.trim().toLowerCase()),
  );

  return (
    <>
      <div className="relative mb-4">
        <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('sessions.search')}
          className="pl-9"
        />
      </div>

      {loading ? (
        <div className="flex justify-center py-12"><Loader2 className="size-6 animate-spin" /></div>
      ) : error ? (
        <p className="py-8 text-center text-sm text-muted-foreground">{error}</p>
      ) : filtered.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">{t('sessions.empty')}</p>
      ) : (
        <div className="flex flex-col gap-3">
          {filtered.map((s) => (
            <Card key={s.id} size="sm">
              <CardContent className="flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <p className="truncate font-medium">{s.title || s.id}</p>
                  <p className="text-xs text-muted-foreground">
                    {new Date(s.created_at).toLocaleString()}
                  </p>
                </div>
                <span className="shrink-0 text-xs text-muted-foreground">{s.status}</span>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <div className="mt-6 flex justify-center gap-2">
        <Button
          variant="outline"
          size="icon"
          disabled={loading || cursors.length === 0}
          onClick={() => setCursors((c) => c.slice(0, -1))}
        >
          <ChevronLeft className="size-4" />
        </Button>
        <Button
          variant="outline"
          size="icon"
          disabled={loading || !nextPage}
          onClick={() => setCursors((c) => [...c, nextPage!])}
        >
          <ChevronRight className="size-4" />
        </Button>
      </div>
    </>
  );
}

// Qoder Cloud Agents connection fields: i18n key, storage item, placeholder, input type
const connFields = [
  ['pat', patItem, 'pt-...', 'password'],
  ['agentId', agentIdItem, 'agent_...', 'password'],
  ['envId', envIdItem, 'env_...', 'password'],
  ['vaultId', vaultIdItem, 'vault_...', 'password'],
] as const;

function SettingsPage() {
  const [theme, setTheme] = useState<Theme>('system');
  const [conn, setConn] = useState<Record<string, string>>({});
  const { lang, setLang, t } = useI18n();

  useEffect(() => {
    themeItem.getValue().then(setTheme);
    connFields.forEach(([key, item]) => {
      item.getValue().then((v) => setConn((c) => ({ ...c, [key]: v })));
    });
  }, []);

  const onThemeChange = (th: Theme) => {
    setTheme(th);
    themeItem.setValue(th); // initTheme() watcher applies it everywhere
  };

  return (
    <>
      <div className="flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <span className="shrink-0 text-sm font-medium">{t('settings.language')}</span>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm">
                {langLabels[lang]}
                <ChevronDown className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuRadioGroup value={lang} onValueChange={(v) => setLang(v as Lang)}>
                {Object.entries(langLabels).map(([value, label]) => (
                  <DropdownMenuRadioItem key={value} value={value}>{label}</DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <div className="flex items-center justify-between">
          <span className="shrink-0 text-sm font-medium">{t('settings.theme')}</span>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm">
                {t(`theme.${theme}`)}
                <ChevronDown className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuRadioGroup value={theme} onValueChange={(v) => onThemeChange(v as Theme)}>
                <DropdownMenuRadioItem value="system">{t('theme.system')}</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="dark">{t('theme.dark')}</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="light">{t('theme.light')}</DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <hr className="my-6 border-border" />

      <div className="flex flex-col gap-4">
        {connFields.map(([key, item, placeholder, type]) => (
          <div key={key} className="flex items-center justify-between gap-4">
            <span className="shrink-0 text-sm font-medium">{t(`settings.${key}`)}</span>
            <Input
              value={conn[key] ?? ''}
              onChange={(e) => setConn((c) => ({ ...c, [key]: e.target.value }))}
              onBlur={() => item.setValue((conn[key] ?? '').trim())}
              // credentials: block copy/cut to clipboard; select-all + delete still works
              onCopy={(e) => e.preventDefault()}
              onCut={(e) => e.preventDefault()}
              placeholder={placeholder}
              type={type}
              className="max-w-60"
            />
          </div>
        ))}
      </div>
    </>
  );
}

export default App;
