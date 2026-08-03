import { useEffect, useMemo, useRef, useState } from 'react';
import { Brain, Download } from 'lucide-react';
import { forceSimulation, forceLink, forceManyBody, forceCenter, forceCollide, type SimulationNodeDatum } from 'd3-force';
import { zoom as d3Zoom, zoomIdentity } from 'd3-zoom';
import { select } from 'd3-selection';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import { useStorageValue } from '@/lib/utils';
import { clipsItem, clipNavUrl, type Clip } from '@/lib/clips';
import { colorFor, CategoryChips } from './clips';

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
    const notes = (clip.notes ?? []).map((n) => `- ${n}`).join('\n');
    return `---\ntags: [web-clip, ${clip.category}]\nsource: ${clip.pageUrl}\nclipped: ${new Date(clip.createdAt).toISOString().slice(0, 10)}\n---\n\n# ${names.get(clip.id)}\n\n${quote(clip.text)}\n\n${notes ? `## Notes\n\n${notes}\n\n` : ''}${related ? `## Related\n\n${related}\n` : ''}`;
  };

  // preferred: write individual files into a vault directory (Obsidian Graph View needs one file per note)
  if ('showDirectoryPicker' in window) {
    try {
      const dir = await (window as any).showDirectoryPicker({ mode: 'readwrite' });
      for (const clip of classified) {
        // one directory per category keeps vault browsing aligned with the graph;
        // category 来自 AI 分类/用户设置,可能含路径非法字符,与 noteName 同规则清洗
        const sub = await dir.getDirectoryHandle((clip.category ?? '').replace(/[\\\/:*?"<>|]/g, '-'), { create: true });
        const handle = await sub.getFileHandle(`${names.get(clip.id)}.md`, { create: true });
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
  for (const c of classified) {
    if (!byCat.has(c.category!)) byCat.set(c.category!, []);
    byCat.get(c.category!)!.push(c);
  }
  let body = '';
  for (const [cat, list] of byCat) {
    body += `## ${cat}\n\n`;
    // 与目录路径同输出(toMd 含 notes/related),避免降级时丢备注
    for (const c of list) body += `${toMd(c)}\n\n`;
  }
  const blob = new Blob([`# Pixel Agent Clips\n\n${body}`], { type: 'text/markdown' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'pixel-agent-clips.md';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

export default function GraphPage() {
  const { t } = useI18n();
  const clips = useStorageValue(clipsItem, []);
  const svgRef = useRef<SVGSVGElement>(null);
  const [classifying, setClassifying] = useState(false);
  const [classifyError, setClassifyError] = useState('');
  const [filter, setFilter] = useState<string | null>(null);

  const classified = clips.filter((c) => c.category);
  const categories = useMemo(() => [...new Set(classified.map((c) => c.category!))].sort(),
    // eslint-disable-next-line react-hooks/exhaustive-deps — classified derives from clips
    [clips]);

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
    // eslint-disable-next-line react-hooks/exhaustive-deps — nodes/links derive from clips
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
        <CategoryChips cats={categories} selected={filter} onToggle={setFilter} />
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
