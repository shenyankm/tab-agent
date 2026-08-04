import { useEffect, useState } from 'react';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { RadioDropdown } from '@/components/radio-dropdown';
import { useI18n, langLabels } from '@/lib/i18n';
import { useStorageValue } from '@/lib/utils';
import { sendRequest } from '@/lib/messages';
import { themeItem, patItem, agentIdItem, envIdItem, vaultIdItem, memorySyncItem, highlightColorItem } from '@/lib/settings';

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
  const memorySync = useStorageValue(memorySyncItem, false);
  const [syncing, setSyncing] = useState(false);
  const [synced, setSynced] = useState<number | null>(null);
  const [conn, setConn] = useState<Record<string, string>>({});
  const { lang, setLang, t } = useI18n();

  // 同步走 background(唯一写方 + keepalive);失败(如未配置 PAT)按 0 条展示
  const syncNow = () => {
    setSyncing(true);
    sendRequest<{ synced: number }>({ type: 'memorySync' })
      .then((r) => setSynced(r.synced))
      .catch(() => setSynced(0))
      .finally(() => setSyncing(false));
  };

  useEffect(() => {
    connFields.forEach(([key, item]) => {
      // 不 watch 是有意的:另一个标签页的改动不应覆盖这里正在输入的值;
      // invalidated-context 的 rejection 非致命,吞掉即可(与 useStorageValue 同款)
      item.getValue()
        .then((v) => setConn((c) => ({ ...c, [key]: v })))
        .catch(() => {});
    });
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
        <div className="flex items-center justify-between">
          <span className="shrink-0 text-sm font-medium">{t('settings.memorySync')}</span>
          <div className="flex items-center gap-3">
            {synced !== null && (
              <span className="text-xs text-muted-foreground">
                {t('settings.memorySyncResult', { n: synced })}
              </span>
            )}
            <Button size="sm" variant="outline" disabled={syncing} onClick={syncNow}>
              {t('settings.memorySyncNow')}
            </Button>
            <Switch
              checked={memorySync}
              onCheckedChange={(v) => memorySyncItem.setValue(v).catch(() => {})}
            />
          </div>
        </div>

        {connFields.map(([key, item, placeholder]) => (
          <div key={key} className="flex items-center justify-between gap-4">
            <span className="shrink-0 text-sm font-medium">{t(`settings.${key}`)}</span>
            <Input
              value={conn[key] ?? ''}
              onChange={(e) => setConn((c) => ({ ...c, [key]: e.target.value }))}
              onBlur={() => item.setValue((conn[key] ?? '').trim()).catch(() => {})}
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
