import { useState } from 'react';
import { Zap, Trash2, Settings } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';

function App() {
  const [count, setCount] = useState(0);
  const { t } = useI18n();

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 p-8">
      <h1 className="font-head text-2xl">{t('app.title')}</h1>

      <div className="flex items-center gap-3">
        <Button onClick={() => setCount((c) => c + 1)}>
          <Zap />
          {t('popup.count', { n: count })}
        </Button>
        <Button variant="destructive" size="icon" onClick={() => setCount(0)}>
          <Trash2 />
        </Button>
        <Button variant="outline" size="icon" onClick={() => browser.runtime.openOptionsPage()}>
          <Settings />
        </Button>
      </div>

    </div>
  );
}

export default App;
