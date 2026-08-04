import { useEffect, useMemo, useRef, useState } from 'react';
import { Brain } from 'lucide-react';
import { forceSimulation, forceLink, forceManyBody, forceCenter, forceCollide, type SimulationNodeDatum } from 'd3-force';
import { zoom as d3Zoom, zoomIdentity } from 'd3-zoom';
import { select } from 'd3-selection';
import { Button } from '@/components/ui/button';
import { useI18n } from '@/lib/i18n';
import { useStorageValue } from '@/lib/utils';
import { clipsItem, clipNavUrl } from '@/lib/clips';
import { colorFor, CategoryChips } from './clips';

type GNode = SimulationNodeDatum & { id: string; label: string; category: string; clipUrl: string; degree: number };

export default function GraphPage() {
  const { t } = useI18n();
  const clips = useStorageValue(clipsItem, []);
  const svgRef = useRef<SVGSVGElement>(null);
  const [classifying, setClassifying] = useState(false);
  const [classifyError, setClassifyError] = useState('');
  const [filter, setFilter] = useState<string | null>(null);

  // memoized: unstable references here re-run the effect below on every unrelated
  // setState — clearing the SVG, restarting the simulation and resetting the zoom
  const classified = useMemo(() => clips.filter((c) => c.category), [clips]);
  const categories = useMemo(() => [...new Set(classified.map((c) => c.category!))].sort(), [classified]);

  // build graph data
  const { nodes, links } = useMemo(() => {
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
    return { nodes, links };
  }, [classified]);

  const filtered = useMemo(() => filter
    ? { nodes: nodes.filter((n) => n.category === filter), links: links.filter((l) =>
        nodes.some((n) => n.id === l.source && n.category === filter) &&
        nodes.some((n) => n.id === l.target && n.category === filter)
      ) }
    : { nodes, links }, [filter, nodes, links]);

  const runClassify = () => {
    setClassifying(true);
    setClassifyError('');
    browser.runtime.sendMessage({ type: 'classifyClips' })
      // background replies with the {ok,error} envelope: failures RESOLVE, not reject
      .then((res) => {
        setClassifying(false);
        if (!res?.ok) setClassifyError(res?.error ?? 'classify failed');
      })
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
      // token-derived, not hardcoded: reads --muted-foreground from the live theme
      .attr('stroke', getComputedStyle(svg).getPropertyValue('--muted-foreground') || '#94a3b8')
      .attr('stroke-opacity', 0.4)
      .attr('stroke-width', 1);

    // nodes
    const node = g.append('g').attr('class', 'nodes')
      .selectAll<SVGCircleElement, GNode>('circle')
      .data(simNodes)
      .join('circle')
      .attr('r', (d) => 6 + d.degree * 2)
      .attr('fill', (d) => colorFor(d.category, categories))
      // node outline follows --border (black in both themes); a fixed #fff read
      // as a white halo in dark mode
      .attr('stroke', getComputedStyle(svg).getPropertyValue('--border') || '#000')
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
