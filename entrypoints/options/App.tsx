import { lazy, Suspense, useState } from 'react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { useI18n } from '@/lib/i18n';
import SettingsPage from './pages/settings';
import ClipsPage from './pages/clips';
import PrivacyPage from './pages/privacy';

// d3 (~30KB gz) only loads when the user visits the graph tab
const GraphPage = lazy(() => import('./pages/graph'));

type Tab = 'settings' | 'clips' | 'graph' | 'privacy';

const tabs: Tab[] = ['settings', 'clips', 'graph', 'privacy'];

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

        <TabsContent value="settings" className="w-full"><SettingsPage /></TabsContent>
        <TabsContent value="clips" className="w-full"><ClipsPage /></TabsContent>
        <TabsContent value="graph" className="w-full">
          <Suspense fallback={null}><GraphPage /></Suspense>
        </TabsContent>
        <TabsContent value="privacy" className="w-full"><PrivacyPage /></TabsContent>
      </Tabs>
    </div>
  );
}

export default App;
