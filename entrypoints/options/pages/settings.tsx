import { useEffect, useState } from 'react';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { RadioDropdown } from '@/components/radio-dropdown';
import { useI18n, langLabels } from '@/lib/i18n';
import { useStorageValue } from '@/lib/utils';
import { sendRequest } from '@/lib/messages';
import { themeItem, patItem, agentIdItem, envIdItem, vaultIdItem, memorySyncItem, highlightColorItem, dailyReportItem, notionDbIdItem } from '@/lib/settings';

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
  const dailyReport = useStorageValue(dailyReportItem, false);
  const [reporting, setReporting] = useState(false);
  const [reportResult, setReportResult] = useState<string | null>(null);
  const [dbId, setDbId] = useState('');
  const [conn, setConn] = useState<Record<string, string>>({});
  const { lang, setLang, t } = useI18n();

  // 手动生成是一个完整 Agent 回合(总结 + 写 Notion),background keepalive 内跑
  const reportNow = () => {
    setReporting(true);
    setReportResult(null);
    sendRequest<{ day: string }>({ type: 'dailyReportNow' })
      .then((r) => setReportResult(t('settings.dailyReportResult', { day: r.day })))
      .catch((e: Error) => setReportResult(t('widget.error.generic', { message: String(e?.message ?? e) })))
      .finally(() => setReporting(false));
  };

  useEffect(() => {
    connFields.forEach(([key, item]) => {
      // 不 watch 是有意的:另一个标签页的改动不应覆盖这里正在输入的值;
      // invalidated-context 的 rejection 非致命,吞掉即可(与 useStorageValue 同款)
      item.getValue()
        .then((v) => setConn((c) => ({ ...c, [key]: v })))
        .catch(() => {});
    });
    notionDbIdItem.getValue().then(setDbId).catch(() => {});
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
          {/* 写入即自动镜像;开关打开时 background 对存量摘录补一次全量 */}
          <span className="shrink-0 text-sm font-medium">{t('settings.memorySync')}</span>
          <Switch
            checked={memorySync}
            onCheckedChange={(v) => memorySyncItem.setValue(v).catch(() => {})}
          />
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

      <Separator className="my-6" />

      {/* 每日日报:开关/DB ID 变更由 background watcher 收敛云端 Deployment */}
      <div className="flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <span className="shrink-0 text-sm font-medium">{t('settings.dailyReport')}</span>
          <div className="flex items-center gap-3">
            {reportResult !== null && (
              <span className="text-xs text-muted-foreground">{reportResult}</span>
            )}
            <Button size="sm" variant="outline" disabled={reporting || !dbId.trim()} onClick={reportNow}>
              {t('settings.dailyReportNow')}
            </Button>
            <Switch
              checked={dailyReport}
              onCheckedChange={(v) => dailyReportItem.setValue(v).catch(() => {})}
            />
          </div>
        </div>

        <div className="flex items-center justify-between gap-4">
          <span className="shrink-0 text-sm font-medium">{t('settings.notionDbId')}</span>
          <Input
            value={dbId}
            onChange={(e) => setDbId(e.target.value)}
            onBlur={() => notionDbIdItem.setValue(dbId.trim()).catch(() => {})}
            placeholder={t('settings.notionDbIdPlaceholder')}
            className="max-w-60"
          />
        </div>
      </div>
    </>
  );
}
