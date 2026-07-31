import { useEffect, useState } from 'react';
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
import { petEnabledItem, pageCarryItem, type PageCarry } from '@/lib/settings';

const carries: PageCarry[] = ['none', 'article', 'screenshot'];

function App() {
  const { t } = useI18n();
  const [petEnabled, setPetEnabled] = useState(true);
  const [carry, setCarry] = useState<PageCarry>('article');

  // watch keeps the popup in sync with the options page
  useEffect(() => {
    petEnabledItem.getValue().then(setPetEnabled);
    return petEnabledItem.watch(setPetEnabled);
  }, []);

  useEffect(() => {
    pageCarryItem.getValue().then(setCarry);
    return pageCarryItem.watch(setCarry);
  }, []);

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
        <span className="shrink-0 text-sm font-medium">{t('settings.pageCarry')}</span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm">
              {t(`carry.${carry}`)}
              <ChevronDown className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuRadioGroup value={carry} onValueChange={(v) => pageCarryItem.setValue(v as PageCarry)}>
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
