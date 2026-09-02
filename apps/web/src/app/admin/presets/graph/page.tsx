import Link from 'next/link';
import { prisma, loadPresetGraph } from '@repo/db';
import { topologicalLayers, findCycles, prerequisitesOf } from '@repo/shared';
import { Card, CardBody, Eyebrow, Heading } from '@/components/ui/card';
import { Pill } from '@/components/ui/pill';

/**
 * The dependency graph laid out in delivery order — AEH-242.
 *
 * Layered by topological depth rather than drawn force-directed, because the
 * layers mean something: everything in one can be worked at the same time, and
 * nothing in it can start until the layer before it is done. That is the
 * resource-planning view, and it comes from the same edges the presales
 * configurator walks. One relation, two payoffs.
 *
 * The longest chain of hours through the graph is the floor on elapsed time no
 * matter how many people are put on it.
 */
export default async function PresetGraphPage() {
  const graph = await loadPresetGraph(prisma);
  const layers = topologicalLayers(graph);
  const cycles = findCycles(graph);

  const label = (id: string) => {
    const n = graph.nodes.get(id);
    return n ? `${n.code ? `${n.code} · ` : ''}${n.name}` : id;
  };

  // Longest path by hours. Computed over the layers, which are already in
  // dependency order, so one pass is enough.
  const longestTo = new Map<string, number>();
  for (const layer of layers) {
    for (const id of layer) {
      const own = graph.nodes.get(id)?.devHours ?? 0;
      const deps = graph.edges.get(id) ?? [];
      const upstream = deps.length === 0 ? 0 : Math.max(...deps.map((d) => longestTo.get(d) ?? 0));
      longestTo.set(id, upstream + own);
    }
  }
  const criticalHours = longestTo.size === 0 ? 0 : Math.max(...longestTo.values());
  const totalHours = [...graph.nodes.values()].reduce((sum, n) => sum + n.devHours, 0);
  const unconnected = [...graph.nodes.keys()].filter(
    (id) => (graph.edges.get(id) ?? []).length === 0 && prerequisitesOf(graph, id).size === 0,
  ).length;

  return (
    <div data-testid="preset-graph">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <Heading level={1}>Dependency graph</Heading>
          <p className="mt-1.5 max-w-2xl text-[13px] text-ink-3">
            Each row is a delivery wave. Everything in a wave can be worked in parallel; nothing in it
            can start until the wave above is done. Edges are edited on each preset&rsquo;s own page.
          </p>
        </div>
        <Link href="/admin/presets" className="text-[13px] text-ink-3 underline">
          Back to presets
        </Link>
      </div>

      {cycles.length > 0 && (
        <Card className="mt-4 border-[var(--color-red)]">
          <CardBody className="p-4">
            <Eyebrow>Circular dependency</Eyebrow>
            <p className="mt-1 text-[13px] text-ink-2">
              These presets depend on each other in a loop, so there is no order they can be built in.
              The editor cannot create this — it came from a direct write or an import.
            </p>
            <ul className="mt-2 space-y-1" data-testid="graph-cycles">
              {cycles.map((cycle, i) => (
                <li key={i} className="text-[13px] text-ink-2">
                  {cycle.map(label).join(' → ')} → {label(cycle[0]!)}
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>
      )}

      <div className="mt-5 flex flex-wrap gap-6">
        <Stat label="Presets" value={graph.nodes.size} />
        <Stat label="Waves" value={layers.length} />
        <Stat label="Total hours" value={totalHours} />
        <Stat label="Critical path" value={criticalHours} hint="longest chain of hours" />
        <Stat label="Standalone" value={unconnected} hint="no edges either way" />
      </div>

      {layers.length === 0 ? (
        <p className="mt-6 text-[13px] text-ink-4">No presets with an active version yet.</p>
      ) : (
        <ol className="mt-6 space-y-3">
          {layers.map((layer, i) => {
            const hours = layer.reduce((sum, id) => sum + (graph.nodes.get(id)?.devHours ?? 0), 0);
            return (
              <li key={i}>
                <Card>
                  <CardBody className="p-4">
                    <div className="flex items-baseline justify-between gap-3">
                      <Eyebrow>
                        Wave <span className="num">{i + 1}</span>
                      </Eyebrow>
                      <span className="text-[11.5px] text-ink-4">
                        <span className="num">{layer.length}</span> presets ·{' '}
                        <span className="num">{hours}</span>h if run in parallel
                      </span>
                    </div>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {layer.map((id) => (
                        <Link key={id} href={`/admin/presets/${id}`}>
                          <Pill>{label(id)}</Pill>
                        </Link>
                      ))}
                    </div>
                  </CardBody>
                </Card>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: number; hint?: string }) {
  return (
    <div>
      <Eyebrow>{label}</Eyebrow>
      <p className="num mt-0.5 text-[19px] text-ink-1">{value}</p>
      {hint ? <p className="text-[11.5px] text-ink-4">{hint}</p> : null}
    </div>
  );
}
