import { useEffect, useState } from 'react';
import { Settings, ChevronDown, MessageSquare, Shield, HelpCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Input } from '@/components/ui/input';
import { Menubar, MenubarMenu, MenubarTrigger } from '@/components/ui/menubar';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from '@/components/ui/dropdown-menu';
import { useI18n, langLabels, type Lang } from '@/lib/i18n';
import { themeItem, autoUpdateItem, petEnabledItem, serverUrlItem, patItem, agentIdItem, envIdItem, type Theme } from '@/lib/settings';

type Tab = 'settings' | 'sessions' | 'privacy' | 'support';

const tabs: Tab[] = ['settings', 'sessions', 'privacy', 'support'];

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
      <Menubar className="mb-8 justify-center">
        <MenubarMenu>
          <MenubarTrigger className={tab === 'settings' ? 'bg-accent' : ''} onClick={() => setTab('settings')}>{t('nav.settings')}</MenubarTrigger>
        </MenubarMenu>
        <MenubarMenu>
          <MenubarTrigger className={tab === 'sessions' ? 'bg-accent' : ''} onClick={() => setTab('sessions')}>{t('nav.sessions')}</MenubarTrigger>
        </MenubarMenu>
        <MenubarMenu>
          <MenubarTrigger className={tab === 'privacy' ? 'bg-accent' : ''} onClick={() => setTab('privacy')}>{t('nav.privacy')}</MenubarTrigger>
        </MenubarMenu>
        <MenubarMenu>
          <MenubarTrigger className={tab === 'support' ? 'bg-accent' : ''} onClick={() => setTab('support')}>{t('nav.support')}</MenubarTrigger>
        </MenubarMenu>
      </Menubar>

      {tab === 'settings' && <SettingsPage />}
      {tab === 'sessions' && <PlaceholderPage icon={<MessageSquare className="size-6" />} title={t('nav.sessions')} />}
      {tab === 'privacy' && <PrivacyPage />}
      {tab === 'support' && <PlaceholderPage icon={<HelpCircle className="size-6" />} title={t('nav.support')} />}

      <footer className="mt-16 text-center text-sm text-muted-foreground">
        {t('footer.builtWith').split('{link}')[0]}<a href="https://qoder.com/" target="_blank" rel="noopener" className="underline hover:text-foreground">Qoder</a>{t('footer.builtWith').split('{link}')[1]}
      </footer>
    </div>
  );
}

function PlaceholderPage({ icon, title }: { icon: React.ReactNode; title: string }) {
  return (
    <>
      <div className="mb-8 flex items-center gap-3">
        {icon}
        <h1 className="font-head text-2xl">{title}</h1>
      </div>
      <p className="text-sm text-muted-foreground">Coming soon.</p>
    </>
  );
}

function PrivacyPage() {
  const { t } = useI18n();
  // RetroUI typography: utility-class recipes, not an installable component
  return (
    <>
      <div className="mb-2 flex items-center gap-3">
        <Shield className="size-6" />
        <h1 className="font-head text-2xl">{t('nav.privacy')}</h1>
      </div>
      <p className="text-sm text-muted-foreground">{t('privacy.updated')}</p>
      <p className="text-sm leading-6 [&:not(:first-child)]:mt-6">{t('privacy.intro')}</p>

      <h3 className="mt-8 scroll-m-20 text-xl font-semibold tracking-tight">{t('privacy.collect.title')}</h3>
      <p className="text-sm leading-6 mt-2">{t('privacy.collect.body')}</p>
      <ul className="text-sm my-4 ml-6 list-disc [&>li]:mt-2">
        <li>{t('settings.language')}</li>
        <li>{t('settings.theme')}</li>
        <li>{t('settings.autoUpdate')}</li>
      </ul>

      <h3 className="mt-8 scroll-m-20 text-xl font-semibold tracking-tight">{t('privacy.permission.title')}</h3>
      <p className="text-sm leading-6 mt-2">{t('privacy.permission.body')}</p>

      <h3 className="mt-8 scroll-m-20 text-xl font-semibold tracking-tight">{t('privacy.share.title')}</h3>
      <p className="text-sm leading-6 mt-2">{t('privacy.share.body')}</p>

      <blockquote className="text-sm mt-6 border-l-2 border-border pl-6 italic">{t('privacy.promise')}</blockquote>

      <h3 className="mt-8 scroll-m-20 text-xl font-semibold tracking-tight">{t('privacy.contact.title')}</h3>
      <p className="text-sm leading-6 mt-2">{t('privacy.contact.body')}</p>
    </>
  );
}

// Qoder Cloud Agents connection fields: i18n key, storage item, placeholder, input type
const connFields = [
  ['serverUrl', serverUrlItem, 'https://api.qoder.com/api/v1/cloud', 'url'],
  ['pat', patItem, 'pt-...', 'password'],
  ['agentId', agentIdItem, 'agent_...', 'text'],
  ['envId', envIdItem, 'env_...', 'text'],
] as const;

function SettingsPage() {
  const [theme, setTheme] = useState<Theme>('system');
  const [autoUpdate, setAutoUpdate] = useState(true);
  const [petEnabled, setPetEnabled] = useState(true);
  const [conn, setConn] = useState<Record<string, string>>({});
  const { lang, setLang, t } = useI18n();

  useEffect(() => {
    themeItem.getValue().then(setTheme);
    autoUpdateItem.getValue().then(setAutoUpdate);
    petEnabledItem.getValue().then(setPetEnabled);
    connFields.forEach(([key, item]) => {
      item.getValue().then((v) => setConn((c) => ({ ...c, [key]: v })));
    });
  }, []);

  const onThemeChange = (th: Theme) => {
    setTheme(th);
    themeItem.setValue(th); // initTheme() watcher applies it everywhere
  };

  const onAutoUpdateChange = (v: boolean) => {
    setAutoUpdate(v);
    autoUpdateItem.setValue(v);
  };

  const onPetEnabledChange = (v: boolean) => {
    setPetEnabled(v);
    petEnabledItem.setValue(v);
  };

  return (
    <>
      <div className="mb-8 flex items-center gap-3">
        <Settings className="size-6" />
        <h1 className="font-head text-2xl">{t('settings.title')}</h1>
      </div>

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
        <div className="flex items-center justify-between">
          <span className="shrink-0 text-sm font-medium">{t('settings.pet')}</span>
          <Switch checked={petEnabled} onCheckedChange={onPetEnabledChange} />
        </div>

        <div className="flex items-center justify-between">
          <span className="shrink-0 text-sm font-medium">{t('settings.autoUpdate')}</span>
          <Switch checked={autoUpdate} onCheckedChange={onAutoUpdateChange} />
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
