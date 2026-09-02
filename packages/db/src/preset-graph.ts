import type { PrismaClient } from './generated/client/index.js';
import { edgeKey, type EdgeNotes, type PresetGraph, type PresetGraphNode } from '@repo/shared';


/**
 * Database access for the preset dependency graph — AEH-242.
 *
 * The traversals themselves live in `@repo/shared/preset-graph` so the admin
 * picker can run the identical walk in the browser; see the note there. This
 * file is the half that needs Prisma. Deliberately does NOT re-export them:
 * a caller that reaches for a walk should reach for `@repo/shared`, which is
 * the import that also works in a client component.
 */

/**
 * Load the whole active graph in one round trip.
 *
 * Deliberately unfiltered and unpaginated. A preset library is hundreds of rows,
 * not millions, and every consumer wants the whole shape: a partial graph gives
 * wrong answers to reachability questions rather than incomplete ones, which is
 * a far worse failure. If this ever needs to scale, the fix is a recursive CTE
 * per query, not a truncated load here.
 */
export async function loadPresetGraph(db: PrismaClient): Promise<PresetGraph & { notes: EdgeNotes }> {
  const versions = await db.presetVersion.findMany({
    where: { active: true },
    select: {
      id: true,
      presetId: true,
      preset: { select: { code: true } },
      retrieval: { select: { name: true } },
      anchor: { select: { devHours: true } },
      dependencies: { select: { prerequisitePresetId: true, note: true } },
    },
  });

  const nodes = new Map<string, PresetGraphNode>();
  const edges = new Map<string, string[]>();
  const notes: EdgeNotes = new Map();

  for (const v of versions) {
    nodes.set(v.presetId, {
      presetId: v.presetId,
      code: v.preset.code,
      // A version mid-write can lack its concern rows; render it rather than
      // dropping it silently out of the graph.
      name: v.retrieval?.name ?? v.preset.code ?? v.presetId,
      devHours: v.anchor?.devHours ?? 0,
      versionId: v.id,
    });
    edges.set(v.presetId, v.dependencies.map((d) => d.prerequisitePresetId));
    for (const d of v.dependencies) {
      if (d.note) notes.set(edgeKey(v.presetId, d.prerequisitePresetId), d.note);
    }
  }

  // An edge can point at a preset with no active version (mid-write, or a
  // version deactivated by hand). Drop those targets rather than letting a
  // traversal walk into a node that has no entry in `edges`.
  for (const [presetId, deps] of edges) {
    const live = deps.filter((d) => nodes.has(d));
    if (live.length !== deps.length) edges.set(presetId, live);
  }

  return { nodes, edges, notes };
}

/**
 * Copy a preset's dependency edges onto a newly created version, inside the
 * caller's transaction.
 *
 * Every writer that creates a new PresetVersion must call this, for the same
 * reason `carryPresetVector` exists: edges hang off the version, so a new
 * version starts with none. Skip the carry and the preset silently loses every
 * prerequisite the moment it is edited or an actuals entry lands — no error,
 * and nothing to notice until a configurator quietly stops pulling in the work
 * that preset depends on.
 *
 * That hazard has now been introduced and closed three times on this model
 * (twice for the embedding — see AEH-244 — and once here). Deleting the comment
 * deletes the reason the guard exists.
 */
export async function carryPresetEdges(
  tx: {
    presetDependency: {
      findMany(args: unknown): Promise<Array<{ prerequisitePresetId: string; note: string | null }>>;
      createMany(args: unknown): Promise<unknown>;
    };
  },
  fromVersionId: string,
  toVersionId: string,
): Promise<void> {
  const existing = await tx.presetDependency.findMany({
    where: { dependentVersionId: fromVersionId },
    select: { prerequisitePresetId: true, note: true },
  });
  if (existing.length === 0) return;
  await tx.presetDependency.createMany({
    data: existing.map((e) => ({
      dependentVersionId: toVersionId,
      prerequisitePresetId: e.prerequisitePresetId,
      note: e.note,
    })),
  });
}
