import { useEffect, useState } from 'react';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { RadioDropdown } from '@/components/radio-dropdown';
import { useI18n, langLabels, dict } from '@/lib/i18n';
import { useStorageValue } from '@/lib/utils';
import { themeItem, patItem, agentIdItem, envIdItem, vaultIdItem, highlightColorItem } from '@/lib/settings';

// Connection/API-key fields: i18n key, storage item, placeholder
const connFields = [
  ['pat', patItem, 'pt-...'],
  ['agentId', agentIdItem, 'agent_...'],
  ['envId', envIdItem, 'env_...'],
  ['vaultId', vaultIdItem, 'vault_...'],
] as const;

export default function SettingsPage() {
  const theme = useStorageValue(themeItem, 'system');
  const highlightColor = useStorageValue(highlightColorItem, 'yellow');
  const [conn, setConn] = useState<Record<string, string>>({});
  const { lang, setLang, t } = useI18n(dict);

  useEffect(() => {
    // 不 watch 是有意的:另一个标签页的改动不应覆盖这里正在输入的值;
    // 一次性提交也避免四个配置项分别触发渲染。
    Promise.all(connFields.map(async ([key, item]) => [key, await item.getValue()] as const))
      .then((values) => setConn(Object.fromEntries(values)))
      .catch(() => {});
  }, []);

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
            // initTheme() watcher applies it everywhere
            onChange={(v) => themeItem.setValue(v)}
            options={[
              ['system', t('theme.system')],
              ['dark', t('theme.dark')],
              ['light', t('theme.light')],
            ]}
          />
        </div>

        <div className="flex items-center justify-between">
          <span className="shrink-0 text-sm font-medium">{t('settings.highlightColor')}</span>
          <RadioDropdown
            value={highlightColor}
            // content.tsx watcher restyles live marks on open tabs
            onChange={(v) => highlightColorItem.setValue(v)}
            options={[
              ['yellow', t('hlcolor.yellow')],
              ['purple', t('hlcolor.purple')],
              ['green', t('hlcolor.green')],
              ['blue', t('hlcolor.blue')],
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
              onBlur={() => item.setValue((conn[key] ?? '').trim()).catch(() => { /* storage 写失败:内存中的输入值保留,下次 blur 重试 */ })}
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
