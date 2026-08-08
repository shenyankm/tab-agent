import { useEffect } from 'react';
import { Settings } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { RadioDropdown } from '@/components/radio-dropdown';
import { useFullI18n } from '@/lib/i18n-full';
import { useStorageValue } from '@/lib/utils';
import { petEnabledItem, pageCarryItem, clipHighlightItem, type PageCarry } from '@/lib/settings';

const carries: PageCarry[] = ['none', 'article', 'screenshot'];
const ALL_URLS = { origins: ['<all_urls>'] as string[] };

function App() {
  const { t } = useFullI18n();
  // watch keeps the popup in sync with the options page
  const petEnabled = useStorageValue(petEnabledItem, true);
  const carry = useStorageValue(pageCarryItem, 'article');
  const highlight = useStorageValue(clipHighlightItem, true);

  // the <all_urls> grant can be revoked outside the popup (chrome://settings):
  // don't keep offering a "screenshot" mode the extension can no longer perform
  useEffect(() => {
    if (carry !== 'screenshot') return;
    void browser.permissions.contains(ALL_URLS).then((granted) => {
      if (granted) return;
      pageCarryItem.setValue('article').catch(() => { /* storage write failed */ });
    }).catch(() => { /* permissions query failed */ });
  }, [carry]);

  // screenshot capture needs <all_urls>: ask inside the click gesture; denied = keep
  // old choice. Least privilege both ways: switching away releases the grant.
  const onCarryChange = async (v: PageCarry) => {
    try {
      if (v === 'screenshot' && !(await browser.permissions.request(ALL_URLS))) return;
    } catch { return; } // permissions API rejected; keep the old choice
    if (v !== 'screenshot' && carry === 'screenshot')
      await browser.permissions.remove(ALL_URLS).catch(() => { /* 权限已被外部移除:幂等 */ });
    pageCarryItem.setValue(v).catch(() => { /* storage write failed */ });
  };

  return (
    <div className="flex min-h-screen flex-col gap-6 p-4">
      <div className="flex items-center justify-between">
        <h1 className="font-head text-2xl">{t('app.title')}</h1>
        <Button
          variant="outline"
          size="icon"
          onClick={() => { void browser.runtime.openOptionsPage().catch(() => {}); }}
          aria-label={t('nav.settings')}
        >
          <Settings />
        </Button>
      </div>

      <div className="flex w-full items-center justify-between gap-4">
        <span className="shrink-0 text-sm font-medium">{t('settings.pet')}</span>
        <Switch aria-label={t('settings.pet')} checked={petEnabled} onCheckedChange={(v) => petEnabledItem.setValue(v).catch(() => {})} />
      </div>

      <div className="flex w-full items-center justify-between gap-4">
        <span className="shrink-0 text-sm font-medium">{t('settings.clipHighlight')}</span>
        <Switch aria-label={t('settings.clipHighlight')} checked={highlight} onCheckedChange={(v) => clipHighlightItem.setValue(v).catch(() => {})} />
      </div>

      <div className="flex w-full items-center justify-between gap-4">
        <span className="shrink-0 text-sm font-medium">{t('settings.pageCarry')}</span>
        <RadioDropdown
          aria-label={t('settings.pageCarry')}
          value={carry}
          onChange={onCarryChange}
          options={carries.map((c): [PageCarry, string] => [c, t(`carry.${c}`)])}
        />
      </div>

    </div>
  );
}

export default App;
