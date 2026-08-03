import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Separator } from '@/components/ui/separator';
import { RadioDropdown } from '@/components/radio-dropdown';
import { useI18n, langLabels } from '@/lib/i18n';
import { themeItem, patItem, agentIdItem, envIdItem, vaultIdItem, categoriesItem, mdTemplateItem, type Theme } from '@/lib/settings';

// Connection/API-key fields: i18n key, storage item, placeholder
const connFields = [
  ['pat', patItem, 'pt-...'],
  ['agentId', agentIdItem, 'agent_...'],
  ['envId', envIdItem, 'env_...'],
  ['vaultId', vaultIdItem, 'vault_...'],
] as const;

export default function SettingsPage() {
  const [theme, setTheme] = useState<Theme>('system');
  const [conn, setConn] = useState<Record<string, string>>({});
  const [categories, setCategories] = useState('');
  const [template, setTemplate] = useState('');
  const { lang, setLang, t } = useI18n();

  useEffect(() => {
    themeItem.getValue().then(setTheme);
    connFields.forEach(([key, item]) => {
      item.getValue().then((v) => setConn((c) => ({ ...c, [key]: v })));
    });
    categoriesItem.getValue().then(setCategories);
    mdTemplateItem.getValue().then(setTemplate);
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
          <RadioDropdown
            value={lang}
            onChange={setLang}
            options={Object.entries(langLabels) as [typeof lang, string][]}
          />
        </div>

        <div className="flex items-center justify-between">
          <span className="shrink-0 text-sm font-medium">{t('settings.theme')}</span>
          <RadioDropdown
            value={theme}
            onChange={onThemeChange}
            options={[
              ['system', t('theme.system')],
              ['dark', t('theme.dark')],
              ['light', t('theme.light')],
            ]}
          />
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

        <div className="flex items-center justify-between gap-4">
          <span className="shrink-0 text-sm font-medium">{t('settings.categories')}</span>
          <Input
            value={categories}
            onChange={(e) => setCategories(e.target.value)}
            onBlur={() => categoriesItem.setValue(categories.trim())}
            placeholder="concept, tutorial, news"
            className="max-w-60"
          />
        </div>
      </div>

      <Separator className="my-6" />

      <div className="flex flex-col gap-1">
        <span className="text-sm font-medium">{t('settings.mdTemplate')}</span>
        <Textarea
          value={template}
          onChange={(e) => setTemplate(e.target.value)}
          onBlur={() => mdTemplateItem.setValue(template)}
          rows={10}
          className="font-mono text-xs"
        />
        <span className="text-xs text-muted-foreground">{t('settings.mdTemplateHint')}</span>
      </div>
    </>
  );
}
