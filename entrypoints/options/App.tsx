import { useEffect, useState } from 'react';
import { Settings, ChevronDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from '@/components/ui/dropdown-menu';
import { useI18n, type Lang } from '@/lib/i18n';

type Theme = 'system' | 'dark' | 'light';

const langLabels: Record<Lang, string> = {
  en: 'English',
  'zh-CN': '简体中文',
  'zh-TW': '繁体中文',
  ja: '日本語',
};

function applyTheme(theme: Theme) {
  const isDark = theme === 'dark' || (theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', isDark);
}

function App() {
  const [theme, setTheme] = useState<Theme>('system');
  const [autoUpdate, setAutoUpdate] = useState(true);
  const { lang, setLang, t } = useI18n();

  useEffect(() => {
    browser.storage.local.get(['theme', 'autoUpdate']).then((r) => {
      const th = (r.theme as Theme) || 'system';
      setTheme(th);
      applyTheme(th);
      if (r.autoUpdate !== undefined) setAutoUpdate(r.autoUpdate);
    });
  }, []);

  const onThemeChange = (th: Theme) => {
    setTheme(th);
    applyTheme(th);
    browser.storage.local.set({ theme: th });
  };

  const onLangChange = (l: Lang) => {
    setLang(l);
    browser.storage.local.set({ lang: l });
  };

  const onAutoUpdateChange = (v: boolean) => {
    setAutoUpdate(v);
    browser.storage.local.set({ autoUpdate: v });
  };

  return (
    <div className="mx-auto max-w-lg p-8">
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
              <DropdownMenuRadioGroup value={lang} onValueChange={(v) => onLangChange(v as Lang)}>
                <DropdownMenuRadioItem value="en">English</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="zh-CN">简体中文</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="zh-TW">繁体中文</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="ja">日本語</DropdownMenuRadioItem>
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

      <div className="flex items-center justify-between">
        <span className="shrink-0 text-sm font-medium">{t('settings.autoUpdate')}</span>
        <Switch checked={autoUpdate} onCheckedChange={onAutoUpdateChange} />
      </div>

      <footer className="mt-16 text-center text-sm text-muted-foreground">
        {t('footer.builtWith').split('{link}')[0]}<a href="https://qoder.com/" target="_blank" rel="noopener" className="underline hover:text-foreground">Qoder</a>{t('footer.builtWith').split('{link}')[1]}
      </footer>
    </div>
  );
}

export default App;
