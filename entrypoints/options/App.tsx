import { useEffect, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from '@/components/ui/dropdown-menu';
import { useI18n, langLabels, type Lang } from '@/lib/i18n';
import { themeItem, patItem, agentIdItem, envIdItem, vaultIdItem, type Theme } from '@/lib/settings';

type Tab = 'settings' | 'guide' | 'privacy';

const tabs: Tab[] = ['settings', 'guide', 'privacy'];

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
