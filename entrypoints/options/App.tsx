import { useEffect, useState } from 'react';
import { ChevronDown, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from '@/components/ui/dropdown-menu';
import { useI18n, langLabels, type Lang } from '@/lib/i18n';
import { clipsItem, removeClip, type Clip } from '@/lib/clips';
import { themeItem, patItem, agentIdItem, envIdItem, vaultIdItem, type Theme } from '@/lib/settings';

type Tab = 'settings' | 'clips' | 'privacy';

const tabs: Tab[] = ['settings', 'clips', 'privacy'];

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
        <TabsContent value="clips" className="w-full"><ClipsPage /></TabsContent>
        <TabsContent value="privacy" className="w-full"><PrivacyPage /></TabsContent>
      </Tabs>
    </div>
  );
}

function ClipsPage() {
  const { t } = useI18n();
  const [clips, setClips] = useState<Clip[]>([]);
  const [query, setQuery] = useState('');

  useEffect(() => {
    clipsItem.getValue().then(setClips);
    return clipsItem.watch(setClips);
  }, []);

  const q = query.trim().toLowerCase();
  const shown = q
    ? clips.filter((c) => [c.text, c.title, c.pageUrl].some((v) => v.toLowerCase().includes(q)))
    : clips;

  return (
    <>
      <div className="flex items-center gap-2">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('clips.search')}
        />
        <Button
          variant="outline"
          size="sm"
          disabled={clips.length === 0}
          onClick={() => clipsItem.setValue([])}
        >
          {t('clips.clear')}
        </Button>
      </div>

      {shown.length === 0 && (
        <p className="mt-6 text-sm text-muted-foreground">{t('clips.empty')}</p>
      )}
      <div className="mt-4 flex flex-col">
        {shown.map((clip) => (
          <div key={clip.id} className="flex items-center gap-2 border-b border-border py-3">
            <button
              type="button"
              className="min-w-0 flex-1 cursor-pointer text-left"
              onClick={() => browser.tabs.create({ url: clip.url })}
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
              onClick={() => removeClip(clip.id)}
              aria-label={t('clips.delete')}
            >
              <Trash2 />
            </Button>
          </div>
        ))}
      </div>
    </>
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
        <li>{t('settings.pageCarry')}</li>
        <li>{t('settings.pat')} / {t('settings.agentId')} / {t('settings.envId')} / {t('settings.vaultId')}</li>
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

// Qoder Cloud Agents connection fields: i18n key, storage item, placeholder
const connFields = [
  ['pat', patItem, 'pt-...'],
  ['agentId', agentIdItem, 'agent_...'],
  ['envId', envIdItem, 'env_...'],
  ['vaultId', vaultIdItem, 'vault_...'],
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

      <Separator className="my-6" />

      <div className="flex flex-col gap-4">
        {connFields.map(([key, item, placeholder]) => (
          <div key={key} className="flex items-center justify-between gap-4">
            <span className="shrink-0 text-sm font-medium">{t(`settings.${key}`)}</span>
            <Input
              value={conn[key] ?? ''}
              onChange={(e) => setConn((c) => ({ ...c, [key]: e.target.value }))}
              onBlur={() => item.setValue((conn[key] ?? '').trim())}
              placeholder={placeholder}
              type="password"
              className="max-w-60"
            />
          </div>
        ))}
      </div>
    </>
  );
}

export default App;
