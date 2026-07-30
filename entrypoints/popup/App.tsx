import { Settings } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';

function App() {
  const { t } = useI18n();

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 p-8">
      <h1 className="font-head text-2xl">{t('app.title')}</h1>

      <Button variant="outline" onClick={() => browser.runtime.openOptionsPage()}>
        <Settings />
        {t('nav.settings')}
      </Button>

    </div>
  );
}

export default App;
