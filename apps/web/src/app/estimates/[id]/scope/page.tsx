import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';

import { prisma } from '@repo/db';

import { auth } from '@/lib/auth';
import { Eyebrow } from '@/components/ui/card';

import { ScopeConfigurator } from '../ScopeConfigurator';
import { ScopeGraphEditorPanel } from '../ScopeGraphEditor';
import { ScopeScenarios } from '../ScopeScenarios';
import { listScenarios, loadOrCreateScenario, loadScenario, loadScopeGraph } from '../scope-actions';

/**
 * The scope configurator — a presales planning view over one estimate. AEH-235.
 *
 * Its own route rather than a panel on the estimate screen, for two reasons.
 * The estimate screen is a power-user surface for validating an estimate before
 * finalising; this is what you put in front of a client, and mixing the two
 * invites exactly the confusion the separation exists to prevent. And the
 * estimate screen's `LedgerProvider` is keyed on its row set and remounts its
 * whole subtree on refresh, which would discard a configured scope mid-session.
 *
 * The configurator itself appears once the estimate HAS a dependency graph,
 * because without one every toggle is independent and the feature is a list of
 * checkboxes. Until then the screen offers the editor that records one. The
 * condition is on the ESTIMATE's own graph, never on presets: most cards match
 * no preset at all, so gating on preset matches would hide this feature from
 * essentially every real estimate.
 */
export default async function ScopePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ scenario?: string }>;
}) {
  const { id } = await params;
  const { scenario: wanted } = await searchParams;

  const session = await auth();
  if (!session?.user) redirect('/login');

  const estimate = await prisma.estimate.findUnique({
    where: { id },
    select: {
      id: true,
      title: true,
      status: true,
      _count: { select: { menuItems: true, dependencies: true } },
    },
  });
  if (!estimate) notFound();

  const hasGraph = estimate._count.dependencies > 0;
  const graph = await loadScopeGraph(id);

  return (
    <main className="mx-auto max-w-[1180px] px-5 py-6">
      <Link href={`/estimates/${id}`} className="text-[12px] text-ink-4 hover:text-green">
        ← Back to estimate
      </Link>

      <header className="mt-3 mb-5">
        <Eyebrow>Configure scope</Eyebrow>
        <h1 className="mt-1 text-[22px] leading-tight text-ink-1">{estimate.title}</h1>
        <p className="mt-1.5 max-w-[62ch] text-[12.5px] leading-snug text-ink-3">
          Switch modules on and off to shape what is in scope. Dependencies resolve
          automatically: turning something on brings in what it needs, and turning something off
          drops the work that cannot be delivered without it.{' '}
          <span className="text-ink-4">
            This is a planning view — nothing here changes the estimate.
          </span>
        </p>
      </header>

      {graph.cards.length === 0 ? (
        <EmptyState
          title="This estimate has no menu card yet"
          body="Run the estimate first — there is nothing to configure until the pipeline has produced cards."
          href={`/estimates/${id}`}
          cta="Back to estimate"
        />
      ) : (
        <div className="flex flex-col gap-4">
          {!hasGraph && (
            <div
              data-testid="scope-no-graph"
              className="rounded-[10px] border border-line bg-surface-2 px-4 py-3"
            >
              <p className="text-[13px] text-ink-1">No dependency graph yet</p>
              <p className="mt-1 max-w-[70ch] text-[12.5px] leading-snug text-ink-3">
                All {graph.cards.length} modules are independent, so switching one on or off affects
                nothing else. Record what depends on what below and the cascade starts working. That
                graph belongs to this estimate and is computed for it — no module needs to have
                matched a preset.
              </p>
            </div>
          )}

          <ScopeGraphEditorPanel
            estimateId={id}
            graph={graph}
            scenarioCount={(await listScenarios(id)).length}
          />

          {hasGraph && <Configured estimateId={id} graph={graph} wanted={wanted} />}
        </div>
      )}
    </main>
  );
}

function EmptyState({
  title,
  body,
  href,
  cta,
}: {
  title: string;
  body: string;
  href: string;
  cta: string;
}) {
  return (
    <div
      data-testid="scope-empty"
      className="rounded-[10px] border border-line bg-surface px-5 py-8 text-center"
    >
      <p className="text-[14px] text-ink-1">{title}</p>
      <p className="mx-auto mt-1.5 max-w-[54ch] text-[12.5px] leading-snug text-ink-3">{body}</p>
      <Link href={href} className="mt-3 inline-block text-[12.5px] text-green hover:underline">
        {cta}
      </Link>
    </div>
  );
}

/**
 * The configurator, plus the configurations saved against this estimate.
 *
 * `?scenario=…` selects one, which is what makes a link shareable — a colleague
 * opening the URL sees the same cut of scope, with no export step. An id that
 * does not resolve (deleted, or from another estimate) falls back to the most
 * recent rather than erroring: a stale link should show something useful and
 * let the picker correct it.
 */
async function Configured({
  estimateId,
  graph,
  wanted,
}: {
  estimateId: string;
  graph: Awaited<ReturnType<typeof loadScopeGraph>>;
  wanted: string | undefined;
}) {
  const asked = wanted ? await loadScenario(estimateId, wanted) : null;
  const scenario = asked ?? (await loadOrCreateScenario(estimateId));
  const scenarios = await listScenarios(estimateId);

  return (
    <>
      <ScopeScenarios
        estimateId={estimateId}
        scenarios={scenarios}
        currentId={scenario.id}
        currentPicks={scenario.picks}
      />
      <ScopeConfigurator graph={graph} scenario={scenario} />
    </>
  );
}
