/**
 * Reading an estimate's family. AEH-236.
 *
 * A "project" is not a table — it is a lineage tree, and the dashboard shows
 * one row per tree rather than one per estimate. Two estimates for the same
 * client that were never forked from each other are still two projects, because
 * nothing in the data says otherwise; linking them is a deliberate act.
 *
 * Everything here is a PURE function over a list the caller already has. The
 * dashboard loads every estimate anyway, so grouping in memory costs nothing
 * and, more usefully, makes the rules testable without a database.
 *
 * A denormalised `rootId` column was the obvious alternative and is the wrong
 * one: `parentId` is SetNull, so deleting an estimate in the middle of a chain
 * re-roots everything below it, and a stored root would be quietly wrong from
 * that moment on.
 */

/** The least any of this needs to know about an estimate. */
export type LineageNode = {
  id: string;
  parentId: string | null;
  projectName?: string | null;
  title?: string;
};

/**
 * Walk up to the estimate that starts this family.
 *
 * Cycle-guarded. A cycle cannot occur through the UI — a fork's parent always
 * predates it — but `parentId` is an ordinary nullable column that a bad
 * migration or a hand-written UPDATE could close a loop in, and a hang on the
 * dashboard is a much worse failure than a slightly wrong grouping.
 */
export function rootOf<T extends LineageNode>(nodes: readonly T[], id: string): T | undefined {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  let current = byId.get(id);
  const seen = new Set<string>();
  while (current?.parentId && !seen.has(current.id)) {
    seen.add(current.id);
    const parent = byId.get(current.parentId);
    // A parent outside the given list (filtered out, or not loaded) makes this
    // node the root as far as the caller can see. That is the honest answer:
    // the alternative is claiming a family whose members are not here.
    if (!parent) break;
    current = parent;
  }
  return current;
}

/**
 * Group estimates into families, one entry per root, each in stable order.
 *
 * The order within a family is the order the caller supplied, so a dashboard
 * that sorted by due date keeps that sorting inside each project rather than
 * having a second, invisible order imposed here.
 */
export function familiesOf<T extends LineageNode>(nodes: readonly T[]): Map<string, T[]> {
  const families = new Map<string, T[]>();
  for (const node of nodes) {
    const root = rootOf(nodes, node.id) ?? node;
    const members = families.get(root.id);
    if (members) members.push(node);
    else families.set(root.id, [node]);
  }
  return families;
}

/**
 * What a family is called.
 *
 * `projectName` where anyone has set one, and the ROOT's own title otherwise —
 * so a project reads sensibly from the day it is forked without anybody having
 * to name it first. The fallback is the root's rather than any member's,
 * because that is the estimate the others descend from.
 *
 * Any member's `projectName` is enough: the rename writes all of them together,
 * so they agree. Reading the first non-null rather than insisting on the root's
 * is what keeps the name alive when the root has been deleted.
 */
export function projectNameOf<T extends LineageNode>(family: readonly T[], root: T): string {
  const named = family.find((n) => n.projectName != null && n.projectName !== '');
  return named?.projectName ?? root.title ?? 'Untitled project';
}

/**
 * Every id in the same family as `id` — what a rename has to write.
 *
 * Includes `id` itself, and is computed from roots rather than by walking
 * downwards, so a member whose parent was deleted still resolves to the family
 * the caller can see.
 */
export function familyIds<T extends LineageNode>(nodes: readonly T[], id: string): string[] {
  const root = rootOf(nodes, id);
  if (!root) return [id];
  return nodes.filter((n) => rootOf(nodes, n.id)?.id === root.id).map((n) => n.id);
}

/** Why a re-run is refused, or null when it is allowed. */
export type RerunBlock = { reason: 'CHILDREN' | 'SIBLINGS'; count: number } | null;

/**
 * Whether this estimate may be re-run. AEH-236.
 *
 * A run deletes every card, line item and scope scenario before rebuilding
 * (`run-estimate.ts`), which is destructive in both directions of a lineage.
 *
 *   CHILDREN block it, because their rows' `carriedFromId` point at this
 *   estimate's. A re-run deletes exactly the rows every downstream margin mark
 *   refers to, so the whole family's provenance would start making claims about
 *   rows that no longer exist.
 *
 *   SIBLINGS block it, because a family of branches exists in order to be
 *   compared. Re-running one member rebuilds it from the SOW with no reference
 *   to the shared parent — it stops being a variant of anything, and the
 *   comparison view would sit there comparing two things that are no longer
 *   comparable.
 *
 * Having a PARENT alone does not block it. Nothing depends on this estimate's
 * rows and the parent is untouched either way; the re-run simply clears the
 * carried marks along with the rows, leaving an estimate that records where it
 * came from without claiming any of it still matches. That is accurate, and it
 * is recoverable — fork the parent again.
 *
 * A holding position rather than a design. Re-runs are being reworked in their
 * own stream; this only stops the lineage feature from making the existing
 * behaviour quietly worse.
 */
export function rerunBlock<T extends LineageNode>(nodes: readonly T[], id: string): RerunBlock {
  const self = nodes.find((n) => n.id === id);
  if (!self) return null;

  const children = nodes.filter((n) => n.parentId === id);
  if (children.length > 0) return { reason: 'CHILDREN', count: children.length };

  if (self.parentId) {
    const siblings = nodes.filter((n) => n.parentId === self.parentId && n.id !== id);
    if (siblings.length > 0) return { reason: 'SIBLINGS', count: siblings.length };
  }
  return null;
}

/** The refusal, in words a person can act on. */
export function rerunBlockMessage(block: NonNullable<RerunBlock>): string {
  const n = block.count;
  return block.reason === 'CHILDREN'
    ? `${n} estimate${n === 1 ? ' was' : 's were'} forked from this one. Re-running rebuilds the ledger from the SOW, which would delete the rows their carried-over marks point at. Fork a branch and run that instead.`
    : `This estimate shares a parent with ${n} other${n === 1 ? '' : 's'}. Re-running rebuilds it from the SOW with no reference to what they were all forked from, so it would stop being comparable with them. Fork a branch and run that instead.`;
}
