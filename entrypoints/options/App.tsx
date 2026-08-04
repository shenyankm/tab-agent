import { lazy, Suspense, useState } from 'react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { useI18n } from '@/lib/i18n';

// every tab page lazy-loads: popup modulepreloads the shared popup/options chunk,
// so static page imports would tax every popup open with options-only code
// (alert-dialog, clips list)
const SettingsPage = lazy(() => import('./pages/settings'));
const ClipsPage = lazy(() => import('./pages/clips'));
const PrivacyPage = lazy(() => import('./pages/privacy'));

type Tab = 'settings' | 'clips' | 'privacy';

const tabs: Tab[] = ['settings', 'clips', 'privacy'];

function App() {
  // tab persisted in URL hash so refresh keeps the current page
  const [tab, setTabState] = useState<Tab>(() => {
    const h = location.hash.slice(1) as Tab;
    return tabs.includes(h) ? h : 'settings';
  });
  const setTab = (t: Tab) => {
    setTabState(t);
    location.hash = t;
  };
  const { t } = useI18n();

  return (
    <div className="mx-auto max-w-lg p-8">
      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)} className="items-center">
        <TabsList className="mb-8">
          {tabs.map((tb) => (
            <TabsTrigger key={tb} value={tb}>{t(`nav.${tb}`)}</TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="settings" className="w-full">
          <Suspense fallback={null}><SettingsPage /></Suspense>
        </TabsContent>
        <TabsContent value="clips" className="w-full">
          <Suspense fallback={null}><ClipsPage /></Suspense>
        </TabsContent>
        <TabsContent value="privacy" className="w-full">
          <Suspense fallback={null}><PrivacyPage /></Suspense>
        </TabsContent>
      </Tabs>
    </div>
  );
}

export default App;
