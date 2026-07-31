import { ChevronDown, Settings } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from '@/components/ui/dropdown-menu';
import { useI18n } from '@/lib/i18n';
import { useStorageValue } from '@/lib/utils';
import { petEnabledItem, pageCarryItem, clipHighlightItem, type PageCarry } from '@/lib/settings';

const carries: PageCarry[] = ['none', 'article', 'screenshot'];

function App() {
  const { t } = useI18n();
  // watch keeps the popup in sync with the options page
  const petEnabled = useStorageValue(petEnabledItem, true);
  const carry = useStorageValue(pageCarryItem, 'article');
  const highlight = useStorageValue(clipHighlightItem, true);

  // screenshot capture needs <all_urls>: ask inside the click gesture; denied = keep old choice
  const onCarryChange = async (v: string) => {
    if (v === 'screenshot' && !(await browser.permissions.request({ origins: ['<all_urls>'] }))) return;
    pageCarryItem.setValue(v as PageCarry);
  };

  return (
    <div className="flex min-h-screen flex-col gap-6 p-4">
      <div className="flex items-center justify-between">
        <h1 className="font-head text-2xl">{t('app.title')}</h1>
        <Button
          variant="outline"
          size="icon"
          onClick={() => browser.runtime.openOptionsPage()}
          aria-label={t('nav.settings')}
        >
          <Settings />
        </Button>
      </div>

      <div className="flex w-full items-center justify-between gap-4">
        <span className="shrink-0 text-sm font-medium">{t('settings.pet')}</span>
        <Switch checked={petEnabled} onCheckedChange={(v) => petEnabledItem.setValue(v)} />
      </div>

      <div className="flex w-full items-center justify-between gap-4">
        <span className="shrink-0 text-sm font-medium">{t('settings.clipHighlight')}</span>
        <Switch checked={highlight} onCheckedChange={(v) => clipHighlightItem.setValue(v)} />
      </div>

      <div className="flex w-full items-center justify-between gap-4">
        <span className="shrink-0 text-sm font-medium">{t('settings.pageCarry')}</span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm">
              {t(`carry.${carry}`)}
              <ChevronDown className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuRadioGroup value={carry} onValueChange={onCarryChange}>
              {carries.map((c) => (
                <DropdownMenuRadioItem key={c} value={c}>{t(`carry.${c}`)}</DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

    </div>
  );
}

export default App;
