import { lazy, Suspense, useState, type ReactNode } from 'react';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { ErrorBoundary } from '@/components/error-boundary';
import { useI18n, dict } from '@/lib/i18n';

// every tab page lazy-loads: popup modulepreloads the shared popup/options chunk,
// so static page imports would tax every popup open with options-only code
// (alert-dialog, clips list)
const SettingsPage = lazy(() => import('./pages/settings'));
const ClipsPage = lazy(() => import('./pages/clips'));
const PrivacyPage = lazy(() => import('./pages/privacy'));

// boundary sits OUTSIDE Suspense so a rejected lazy chunk load is caught too;
// per-page: a crash in one tab keeps the others navigable
const LazyPage = ({ children }: { children: ReactNode }) => (
  <ErrorBoundary>
    <Suspense fallback={<p className="text-sm text-muted-foreground">Loading…</p>}>
      {children}
    </Suspense>
  </ErrorBoundary>
);

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
  const { t } = useI18n(dict);

  return (
    <div className="mx-auto max-w-lg p-8">
      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)} className="items-center">
        <TabsList className="mb-8">
          {tabs.map((tb) => (
            <TabsTrigger key={tb} value={tb}>{t(`nav.${tb}`)}</TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="settings" className="w-full">
          <LazyPage><SettingsPage /></LazyPage>
        </TabsContent>
        <TabsContent value="clips" className="w-full">
          <LazyPage><ClipsPage /></LazyPage>
        </TabsContent>
        <TabsContent value="privacy" className="w-full">
          <LazyPage><PrivacyPage /></LazyPage>
        </TabsContent>
      </Tabs>
    </div>
  );
}

export default App;
