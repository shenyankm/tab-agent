import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, Trash2, Brain, Download } from 'lucide-react';
import { forceSimulation, forceLink, forceManyBody, forceCenter, forceCollide, type SimulationNodeDatum } from 'd3-force';
import { zoom as d3Zoom, zoomIdentity } from 'd3-zoom';
import { select } from 'd3-selection';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from '@/components/ui/dropdown-menu';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from '@/components/ui/pagination';
import { useI18n, langLabels, type Lang } from '@/lib/i18n';
import { useStorageValue } from '@/lib/utils';
import { clipsItem, removeClip, clipNavUrl, type Clip } from '@/lib/clips';
import { themeItem, patItem, agentIdItem, envIdItem, vaultIdItem, type Theme } from '@/lib/settings';

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
        <TabsContent value="graph" className="w-full"><GraphPage /></TabsContent>
        <TabsContent value="privacy" className="w-full"><PrivacyPage /></TabsContent>
      </Tabs>
    </div>
  );
}

const PAGE_SIZE = 10;

function ClipsPage() {
  const { t } = useI18n();
  const clips = useStorageValue(clipsItem, []);
  const [query, setQuery] = useState('');
  const [view, setView] = useState<'time' | 'site'>('time');
  const [page, setPage] = useState(1);

  const q = query.trim().toLowerCase();
  const shown = q
    ? clips.filter((c) => [c.text, c.title, c.pageUrl].some((v) => v.toLowerCase().includes(q)))
    : clips;
  const sorted = [...shown].sort((a, b) => b.createdAt - a.createdAt);

  // deletions/search can shrink the list under the cursor: clamp instead of resetting
  const pages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const cur = Math.min(page, pages);
  const paged = sorted.slice((cur - 1) * PAGE_SIZE, cur * PAGE_SIZE);

  // site view: newest-first inside groups, groups ordered by their newest clip
  const bySite = new Map<string, Clip[]>();
  for (const c of view === 'site' ? sorted : []) {
    const host = new URL(c.pageUrl).hostname;
    bySite.set(host, [...(bySite.get(host) ?? []), c]);
  }

  const row = (clip: Clip) => (
    <div key={clip.id} className="flex items-center gap-2 border-b border-border py-3">
      <button
        type="button"
        className="min-w-0 flex-1 cursor-pointer text-left"
        onClick={() => browser.tabs.create({ url: clipNavUrl(clip) })}
        title={clip.text}
      >
        <span className="line-clamp-2 text-sm">{clip.text}</span>
        <span className="mt-1 block truncate text-xs text-muted-foreground">
          {clip.title} · {clip.pageUrl} · {new Date(clip.createdAt).toLocaleString()}
        </span>
      </button>
      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label={t('clips.delete')}>
            <Trash2 />
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('clips.confirmDelete')}</AlertDialogTitle>
            <AlertDialogDescription className="line-clamp-2">{clip.text}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('clips.cancel')}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => removeClip(clip.id)}>
              {t('clips.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );

  return (
    <>
      <div className="flex items-center gap-2">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('clips.search')}
        />
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" className="shrink-0">
              {t(`clips.view.${view}`)}
              <ChevronDown className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuRadioGroup
              value={view}
              onValueChange={(v) => { setView(v as 'time' | 'site'); setPage(1); }}
            >
              <DropdownMenuRadioItem value="time">{t('clips.view.time')}</DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="site">{t('clips.view.site')}</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {shown.length === 0 && (
        <p className="mt-6 text-sm text-muted-foreground">{t('clips.empty')}</p>
      )}

      {view === 'time' ? (
        <>
          <div className="mt-4 flex flex-col">{paged.map(row)}</div>
          {pages > 1 && (
            <Pagination className="mt-6">
              <PaginationContent>
                <PaginationItem>
                  <PaginationPrevious
                    href="#"
                    text={t('clips.prev')}
                    onClick={(e) => { e.preventDefault(); setPage(Math.max(1, cur - 1)); }}
                  />
                </PaginationItem>
                {/* ponytail: every page number rendered, no ellipsis windowing; add it if clip counts ever reach thousands */}
                {Array.from({ length: pages }, (_, i) => (
                  <PaginationItem key={i}>
                    <PaginationLink
                      href="#"
                      isActive={i + 1 === cur}
                      onClick={(e) => { e.preventDefault(); setPage(i + 1); }}
                    >
                      {i + 1}
                    </PaginationLink>
                  </PaginationItem>
                ))}
                <PaginationItem>
                  <PaginationNext
                    href="#"
                    text={t('clips.next')}
                    onClick={(e) => { e.preventDefault(); setPage(Math.min(pages, cur + 1)); }}
                  />
                </PaginationItem>
              </PaginationContent>
            </Pagination>
          )}
        </>
      ) : (
        [...bySite].map(([host, list]) => (
          <div key={host} className="mt-4">
            <h4 className="text-sm font-medium">{host}</h4>
            <div className="flex flex-col">{list.map(row)}</div>
          </div>
        ))
      )}
    </>
  );
}

// category color palette — deterministic by category name
const COLORS = ['#e74c3c', '#3498db', '#2ecc71', '#f39c12', '#9b59b6', '#1abc9c', '#e67e22', '#34495e', '#16a085', '#c0392b'];
const colorFor = (cat: string, cats: string[]) => COLORS[cats.indexOf(cat) % COLORS.length];

type GNode = SimulationNodeDatum & { id: string; label: string; category: string; clipUrl: string; degree: number };

/** Write each classified clip as an Obsidian-compatible .md note into a user-picked
 *  vault directory (File System Access API). Fallback: download a single combined file. */
async function exportObsidian(clips: Clip[]) {
  const classified = clips.filter((c) => c.category);
  if (!classified.length) return;

  const noteName = (c: Clip) => (c.title || c.text.slice(0, 40)).replace(/[\\/:*?"<>|]/g, '-');
  // dedup file names so same-title clips don't overwrite each other
  const seen = new Map<string, number>();
  const uniqueName = (c: Clip) => {
    const base = noteName(c);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return n ? `${base}-${c.id.slice(0, 6)}` : base;
  };
  const names = new Map(classified.map((c) => [c.id, uniqueName(c)]));
  const quote = (text: string) => text.split('\n').map((l) => `> ${l}`).join('\n');
  const toMd = (clip: Clip) => {
    const related = (clip.relatedIds ?? [])
      .map((id) => names.get(id))
      .filter(Boolean)
      .map((name) => `- [[${name}]]`)
      .join('\n');
    return `---\ntags: [web-clip, ${clip.category}]\nsource: ${clip.pageUrl}\nclipped: ${new Date(clip.createdAt).toISOString().slice(0, 10)}\n---\n\n# ${names.get(clip.id)}\n\n${quote(clip.text)}\n\n${related ? `## Related\n\n${related}\n` : ''}`;
  };

  // preferred: write individual files into a vault directory (Obsidian Graph View needs one file per note)
  if ('showDirectoryPicker' in window) {
    try {
      const dir = await (window as any).showDirectoryPicker({ mode: 'readwrite' });
      for (const clip of classified) {
        const handle = await dir.getFileHandle(`${names.get(clip.id)}.md`, { create: true });
        const w = await handle.createWritable();
        await w.write(toMd(clip));
        await w.close();
      }
      return;
    } catch (e: any) {
      if (e?.name === 'AbortError') return; // user cancelled picker
      // fall through to single-file download
    }
  }
  // fallback: single combined markdown file
  const byCat = new Map<string, Clip[]>();
  for (const c of classified) byCat.set(c.category!, [...(byCat.get(c.category!) ?? []), c]);
  let body = '';
  for (const [cat, list] of byCat) {
    body += `## ${cat}\n\n`;
    for (const c of list) body += `### ${names.get(c.id)}\n\n${quote(c.text)}\n\n`;
  }
  const blob = new Blob([`# Pixel Agent Clips\n\n${body}`], { type: 'text/markdown' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'pixel-agent-clips.md';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

function GraphPage() {
  const { t } = useI18n();
  const clips = useStorageValue(clipsItem, []);
  const svgRef = useRef<SVGSVGElement>(null);
  const [classifying, setClassifying] = useState(false);
  const [classifyError, setClassifyError] = useState('');
  const [filter, setFilter] = useState<string | null>(null);

  const classified = clips.filter((c) => c.category);
  const categories = [...new Set(classified.map((c) => c.category!))].sort();

  // build graph data
  const idSet = new Set(classified.map((c) => c.id));
  const nodes: GNode[] = classified.map((c) => ({
    id: c.id,
    label: c.text.slice(0, 60),
    category: c.category!,
    clipUrl: clipNavUrl(c),
    degree: 0,
  }));
  const links: { source: string; target: string }[] = [];
  const seenEdges = new Set<string>();
  for (const c of classified) {
    for (const rid of c.relatedIds ?? []) {
      if (!idSet.has(rid) || rid === c.id) continue;
      const key = c.id < rid ? `${c.id}|${rid}` : `${rid}|${c.id}`;
      if (!seenEdges.has(key)) { seenEdges.add(key); links.push({ source: c.id, target: rid }); }
    }
  }
  // compute degree for node sizing
  const degreeMap = new Map<string, number>();
  for (const l of links) {
    degreeMap.set(l.source, (degreeMap.get(l.source) ?? 0) + 1);
    degreeMap.set(l.target, (degreeMap.get(l.target) ?? 0) + 1);
  }
  for (const n of nodes) n.degree = degreeMap.get(n.id) ?? 0;

  const filtered = useMemo(() => filter
    ? { nodes: nodes.filter((n) => n.category === filter), links: links.filter((l) =>
        nodes.some((n) => n.id === l.source && n.category === filter) &&
        nodes.some((n) => n.id === l.target && n.category === filter)
      ) }
    : { nodes, links },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [clips, filter]);

  const runClassify = () => {
    setClassifying(true);
    setClassifyError('');
    browser.runtime.sendMessage({ type: 'classifyClips' })
      .then(() => setClassifying(false))
      .catch((e) => { setClassifying(false); setClassifyError(String(e?.message ?? e)); });
  };

  // d3 simulation + zoom — runs once per data change
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg || !filtered.nodes.length) return;
    const { width, height } = svg.getBoundingClientRect();

    // deep copy so d3 can mutate without affecting React state
    const simNodes = filtered.nodes.map((n) => ({ ...n }));
    const simLinks = filtered.links.map((l) => ({ source: l.source, target: l.target }));

    const g = select(svg).select<SVGGElement>('g.graph-root');
    g.selectAll('*').remove();

    // zoom
    const zoomBehavior = d3Zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.2, 4])
      .on('zoom', (event) => g.attr('transform', event.transform));
    select(svg).call(zoomBehavior).call(zoomBehavior.transform, zoomIdentity.translate(width / 2, height / 2));

    // links
    const link = g.append('g').attr('class', 'links')
      .selectAll('line')
      .data(simLinks)
      .join('line')
      .attr('stroke', '#94a3b8')
      .attr('stroke-opacity', 0.4)
      .attr('stroke-width', 1);

    // nodes
    const node = g.append('g').attr('class', 'nodes')
      .selectAll<SVGCircleElement, GNode>('circle')
      .data(simNodes)
      .join('circle')
      .attr('r', (d) => 6 + d.degree * 2)
      .attr('fill', (d) => colorFor(d.category, categories))
      .attr('stroke', '#fff')
      .attr('stroke-width', 1.5)
      .attr('cursor', 'pointer')
      .on('click', (_event, d) => browser.tabs.create({ url: d.clipUrl }));

    // labels
    const label = g.append('g').attr('class', 'labels')
      .selectAll('text')
      .data(simNodes)
      .join('text')
      .attr('font-size', 10)
      .attr('fill', 'currentColor')
      .attr('text-anchor', 'middle')
      .attr('dy', (d) => -(10 + d.degree * 2))
      .text((d) => d.label.length > 30 ? d.label.slice(0, 30) + '…' : d.label);

    // simulation
    const sim = forceSimulation(simNodes)
      .force('link', forceLink(simLinks).id((d) => (d as GNode).id).distance(80))
      .force('charge', forceManyBody().strength(-120))
      .force('center', forceCenter(0, 0))
      .force('collide', forceCollide<GNode>().radius((d) => 10 + d.degree * 2))
      .on('tick', () => {
        // d3 resolves string IDs to node objects after simulation starts
        const s = (d: { source: unknown }) => d.source as GNode;
        const t = (d: { target: unknown }) => d.target as GNode;
        link
          .attr('x1', (d) => s(d).x ?? 0)
          .attr('y1', (d) => s(d).y ?? 0)
          .attr('x2', (d) => t(d).x ?? 0)
          .attr('y2', (d) => t(d).y ?? 0);
        node.attr('cx', (d) => d.x ?? 0).attr('cy', (d) => d.y ?? 0);
        label.attr('x', (d) => d.x ?? 0).attr('y', (d) => d.y ?? 0);
      });

    return () => { sim.stop(); select(svg).on('.zoom', null); };
  }, [filtered, categories]);

  if (!classified.length) {
    return (
      <div className="flex flex-col items-center gap-4 py-8">
        <p className="text-sm text-muted-foreground">{t('graph.empty')}</p>
        <Button variant="outline" disabled={classifying} onClick={runClassify}>
          <Brain className="size-4" />
          {classifying ? t('graph.classifying') : t('graph.classify')}
        </Button>
        {classifyError && <p className="text-xs text-destructive">{classifyError}</p>}
      </div>
    );
  }

  return (
    <>
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" disabled={classifying} onClick={runClassify}>
          <Brain className="size-4" />
          {classifying ? t('graph.classifying') : t('graph.classify')}
        </Button>
        <Button variant="outline" size="sm" onClick={() => exportObsidian(clips)}>
          <Download className="size-4" />
          {t('graph.export')}
        </Button>
        <div className="flex flex-wrap gap-1">
          <button
            type="button"
            className={`rounded px-2 py-0.5 text-xs ${!filter ? 'bg-primary text-primary-foreground' : 'bg-muted'}`}
            onClick={() => setFilter(null)}
          >
            All
          </button>
          {categories.map((cat) => (
            <button
              key={cat}
              type="button"
              className={`rounded px-2 py-0.5 text-xs ${filter === cat ? 'bg-primary text-primary-foreground' : 'bg-muted'}`}
              style={filter === cat ? {} : { borderLeft: `3px solid ${colorFor(cat, categories)}` }}
              onClick={() => setFilter(filter === cat ? null : cat)}
            >
              {cat}
            </button>
          ))}
        </div>
      </div>
      {classifyError && <p className="mt-2 text-xs text-destructive">{classifyError}</p>}
      <svg
        ref={svgRef}
        className="mt-4 h-96 w-full rounded border border-border"
      >
        <g className="graph-root" />
      </svg>
    </>
  );
}

function PrivacyPage() {
  const { t } = useI18n();
  // RetroUI typography: utility-class recipes, not an installable component
  return (
    <>
      <p className="text-sm text-muted-foreground">{t('privacy.updated')}</p>
      <p className="text-sm leading-6 [&:not(:first-child)]:mt-6">{t('privacy.intro')}</p>

      <h3 className="mt-8 scroll-m-20 text-xl font-semibold tracking-tight">{t('privacy.collect.title')}</h3>
      <p className="text-sm leading-6 mt-2">{t('privacy.collect.body')}</p>
      <ul className="text-sm my-4 ml-6 list-disc [&>li]:mt-2">
        <li>{t('settings.language')}</li>
        <li>{t('settings.theme')}</li>
        <li>{t('settings.pet')}</li>
        <li>{t('settings.pageCarry')}</li>
        <li>{t('nav.clips')} / {t('settings.clipHighlight')}</li>
        <li>{t('settings.pat')} / {t('settings.agentId')} / {t('settings.envId')} / {t('settings.vaultId')}</li>
      </ul>

      <h3 className="mt-8 scroll-m-20 text-xl font-semibold tracking-tight">{t('privacy.network.title')}</h3>
      <p className="text-sm leading-6 mt-2">{t('privacy.network.body')}</p>

      <h3 className="mt-8 scroll-m-20 text-xl font-semibold tracking-tight">{t('privacy.classify.title')}</h3>
      <p className="text-sm leading-6 mt-2">{t('privacy.classify.body')}</p>

      <h3 className="mt-8 scroll-m-20 text-xl font-semibold tracking-tight">{t('privacy.permission.title')}</h3>
      <p className="text-sm leading-6 mt-2">{t('privacy.permission.body')}</p>

      <h3 className="mt-8 scroll-m-20 text-xl font-semibold tracking-tight">{t('privacy.share.title')}</h3>
      <p className="text-sm leading-6 mt-2">{t('privacy.share.body')}</p>

      <blockquote className="text-sm mt-6 border-l-2 border-border pl-6 italic">{t('privacy.promise')}</blockquote>
    </>
  );
}

// Connection/API-key fields: i18n key, storage item, placeholder
const connFields = [
  ['pat', patItem, 'pt-...'],
  ['agentId', agentIdItem, 'agent_...'],
  ['envId', envIdItem, 'env_...'],
  ['vaultId', vaultIdItem, 'vault_...'],
] as const;

function SettingsPage() {
  const [theme, setTheme] = useState<Theme>('system');
  const [conn, setConn] = useState<Record<string, string>>({});
  const { lang, setLang, t } = useI18n();

  useEffect(() => {
    themeItem.getValue().then(setTheme);
    connFields.forEach(([key, item]) => {
      item.getValue().then((v) => setConn((c) => ({ ...c, [key]: v })));
    });
  }, []);

  const onThemeChange = (th: Theme) => {
    setTheme(th);
    themeItem.setValue(th); // initTheme() watcher applies it everywhere
  };

  return (
    <>
      <div className="flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <span className="shrink-0 text-sm font-medium">{t('settings.language')}</span>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm">
                {langLabels[lang]}
                <ChevronDown className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuRadioGroup value={lang} onValueChange={(v) => setLang(v as Lang)}>
                {Object.entries(langLabels).map(([value, label]) => (
                  <DropdownMenuRadioItem key={value} value={value}>{label}</DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>

        <div className="flex items-center justify-between">
          <span className="shrink-0 text-sm font-medium">{t('settings.theme')}</span>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm">
                {t(`theme.${theme}`)}
                <ChevronDown className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuRadioGroup value={theme} onValueChange={(v) => onThemeChange(v as Theme)}>
                <DropdownMenuRadioItem value="system">{t('theme.system')}</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="dark">{t('theme.dark')}</DropdownMenuRadioItem>
                <DropdownMenuRadioItem value="light">{t('theme.light')}</DropdownMenuRadioItem>
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      <Separator className="my-6" />

      <div className="flex flex-col gap-4">
        {connFields.map(([key, item, placeholder]) => (
          <div key={key} className="flex items-center justify-between gap-4">
            <span className="shrink-0 text-sm font-medium">{t(`settings.${key}`)}</span>
            <Input
              value={conn[key] ?? ''}
              onChange={(e) => setConn((c) => ({ ...c, [key]: e.target.value }))}
              onBlur={() => item.setValue((conn[key] ?? '').trim())}
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

export default App;
