'use server';

import { loadEstimateGraph, prisma, replaceEstimateGraph, selectableOf } from '@repo/db';

import { requireUser } from '@/lib/rbac';

import { asRunPicks, toScopeGraphDTO, type ScenarioDTO, type ScopeGraphDTO } from './scope-dto';

/**
 * Server actions for the scope configurator. AEH-235.
 *
 * EVERY export here must be an async function — this module carries the
 * `'use server'` directive, and a single synchronous export breaks the build of
 * every route that imports from it while typecheck, lint and the unit suite all
 * stay green (AEH-253). The sync mappers live in `scope-dto.ts`.
 *
 * Two rules these deliberately do NOT follow, both inherited from the estimate
 * editor next door and both wrong here:
 *
 *   - No `assertEditable`. That helper throws on a FINALISED estimate, and
 *     cutting scope from a finished estimate is the main presales case. Nothing
 *     here writes to the estimate, so there is nothing to lock.
 *   - No write path to `MenuItem.enabled`. A scenario is a planning artifact;
 *     it must not rewrite the estimate underneath the team that owns it. If you
 *     are about to add one, that is a product decision, not a refactor.
 */

async function estimateExists(estimateId: string): Promise<void> {
  const est = await prisma.estimate.findUnique({ where: { id: estimateId }, select: { id: true } });
  if (!est) throw new Error('Estimate not found');
}

/** The estimate's graph, serialised for the client. */
export async function loadScopeGraph(estimateId: string): Promise<ScopeGraphDTO> {
  await requireUser();
  await estimateExists(estimateId);
  const graph = await loadEstimateGraph(prisma, estimateId);
  return toScopeGraphDTO(graph, selectableOf(graph));
}

/**
 * The scenario to open, creating one seeded from the as-run state if there is
 * none.
 *
 * Seeded from what the pipeline produced rather than from nothing: an empty
 * configurator asks a client to build the scope up from zero, which is the
 * wrong conversation. The estimate is the proposal; the configurator is where
 * it gets trimmed.
 */
export async function loadOrCreateScenario(estimateId: string): Promise<ScenarioDTO> {
  const user = await requireUser();
  await estimateExists(estimateId);

  const existing = await prisma.scopeScenario.findFirst({
    where: { estimateId },
    orderBy: { updatedAt: 'desc' },
    include: { picks: { select: { menuItemId: true } } },
  });
  if (existing) {
    return {
      id: existing.id,
      name: existing.name,
      picks: existing.picks.map((p) => p.menuItemId),
      updatedAt: existing.updatedAt.toISOString(),
    };
  }

  const graph = await loadEstimateGraph(prisma, estimateId);
  const seed = asRunPicks(toScopeGraphDTO(graph, selectableOf(graph)).cards);

  const created = await prisma.scopeScenario.create({
    data: {
      estimateId,
      name: 'As proposed',
      createdById: user.id,
      picks: { create: seed.map((menuItemId) => ({ menuItemId })) },
    },
    include: { picks: { select: { menuItemId: true } } },
  });
  return {
    id: created.id,
    name: created.name,
    picks: created.picks.map((p) => p.menuItemId),
    updatedAt: created.updatedAt.toISOString(),
  };
}

/**
 * Persist a scenario's pick set, replacing it wholesale.
 *
 * One transaction, not one write per card. A single toggle can change thirty
 * picks — the reference artifact's own data has a click that removes 32 of 45
 * modules — and thirty round trips would leave a half-applied cascade on screen
 * in front of a client if one failed. `moveMenuItem` in the editor sets the
 * precedent for a multi-row write behind one action.
 *
 * The client computes the closure with the same shared walks the server would,
 * so this trusts the pick set but not its consequences: what is actually ON is
 * always re-derived from these picks on read.
 */
export async function saveScenarioPicks(scenarioId: string, picks: string[]): Promise<void> {
  await requireUser();
  const scenario = await prisma.scopeScenario.findUnique({
    where: { id: scenarioId },
    select: { estimateId: true },
  });
  if (!scenario) throw new Error('Scenario not found');

  // Only cards of this scenario's own estimate. The unique index would not stop
  // a caller naming a card from somewhere else, and a foreign card in the pick
  // set would be dropped silently on read instead of refused here.
  const own = await prisma.menuItem.findMany({
    where: { estimateId: scenario.estimateId, id: { in: picks } },
    select: { id: true },
  });
  const valid = own.map((c) => c.id);

  await prisma.$transaction([
    prisma.scopeScenarioPick.deleteMany({ where: { scenarioId } }),
    prisma.scopeScenarioPick.createMany({
      data: valid.map((menuItemId) => ({ scenarioId, menuItemId })),
    }),
    prisma.scopeScenario.update({ where: { id: scenarioId }, data: { updatedAt: new Date() } }),
  ]);
}

/** Reset a scenario to the estimate as the pipeline left it. */
export async function resetScenarioToAsRun(scenarioId: string): Promise<string[]> {
  await requireUser();
  const scenario = await prisma.scopeScenario.findUnique({
    where: { id: scenarioId },
    select: { estimateId: true },
  });
  if (!scenario) throw new Error('Scenario not found');

  const graph = await loadEstimateGraph(prisma, scenario.estimateId);
  const picks = asRunPicks(toScopeGraphDTO(graph, selectableOf(graph)).cards);
  await saveScenarioPicks(scenarioId, picks);
  return picks;
}

/** Mark a card as always-included, or stop doing so. */
export async function setCardFoundation(menuItemId: string, foundation: boolean): Promise<void> {
  await requireUser();
  await prisma.menuItem.update({ where: { id: menuItemId }, data: { foundation } });
}

export type EdgeDraft = { dependentId: string; prerequisiteId: string; note?: string | null };

/**
 * Replace an estimate's dependency graph with a validated, acyclic one.
 *
 * Authored edges, so `MANUAL`. The validation is not in this action: it is in
 * `replaceEstimateGraph`, which the derivation path will call too, so both
 * arrive at the same graph through the same three guards rather than each
 * hoping the other checked.
 */
export async function saveEstimateGraph(
  estimateId: string,
  edges: EdgeDraft[],
): Promise<{ written: number; rejected: Array<{ reason: string }> }> {
  await requireUser();
  await estimateExists(estimateId);
  const result = await replaceEstimateGraph(prisma, estimateId, edges, 'MANUAL');
  return {
    written: result.written.length,
    rejected: result.rejected.map((r) => ({ reason: r.reason })),
  };
}
