import type { PrismaClient } from '@repo/db';
import type {
  MenuItem,
  LibrarianOutput,
  ArchivistOutput,
  ArchitectOutput,
} from '@repo/shared';
import type { AgentStateSnapshot } from './supervisor';
import { computeRollup, computeRoleProjections } from './rollup';
import { applyTaxation } from './taxation';
import type { TaxationConfig } from './taxation';

// ─── WS18-01: Persist + load agentState ──────────────────────────────────────

/**
 * Load prior agentState from the estimate record.
 * Used in refine mode to avoid re-running unaffected agents.
 */
export async function loadAgentState(
  db: PrismaClient,
  estimateId: string,
): Promise<AgentStateSnapshot> {
  const est = await db.estimate.findUniqueOrThrow({ where: { id: estimateId } });
  return (est.agentState as AgentStateSnapshot) ?? {};
}

/**
 * Persist updated agentState back to the estimate.
 */
export async function persistAgentState(
  db: PrismaClient,
  estimateId: string,
  state: AgentStateSnapshot,
): Promise<void> {
  await db.estimate.update({
    where: { id: estimateId },
    data: { agentState: state as object },
  });
}

// ─── WS18-02: Module-level tweak API ─────────────────────────────────────────

export type ItemTweak = {
  menuItemId: string;
  role?: 'DEV' | 'QA' | 'PM' | 'BA';
  newBaseHours?: number;
  newNotes?: string;
};

export type TweakResult = {
  menuItems: MenuItem[];
  rollup: ReturnType<typeof computeRollup>;
  projections: ReturnType<typeof computeRoleProjections>;
};

/**
 * Apply a tweak to one menu item's hours/notes.
 * Other items are byte-identical.
 * Re-runs only downstream math (taxation, rollup, projections).
 */
export function applyItemTweak(
  menuItems: MenuItem[],
  tweak: ItemTweak,
  taxConfig: TaxationConfig,
): TweakResult {
  const updated = menuItems.map((m) => {
    if (m.id !== tweak.menuItemId) return m; // unchanged

    const lineItems = m.lineItems.map((li) => {
      if (tweak.role && li.role !== tweak.role) return li; // only edit specified role

      const newBase = tweak.newBaseHours !== undefined ? tweak.newBaseHours : li.baseHours;
      const taxPct =
        li.role === 'PM' ? taxConfig.pmCommunicationTaxPct :
        li.role === 'BA' ? taxConfig.baCommunicationTaxPct :
        li.role === 'QA' ? taxConfig.qaRegressionBufferPct : 0;

      return {
        ...li,
        baseHours: newBase,
        taxedHours: Math.round(newBase * (1 + taxPct)),
        notes: tweak.newNotes ?? li.notes,
        edited: true,
      };
    });

    return { ...m, lineItems };
  });

  return {
    menuItems: updated,
    rollup: computeRollup(updated),
    projections: computeRoleProjections(updated),
  };
}

// ─── WS18-03: Estimate revision history ──────────────────────────────────────

export type RevisionDiff = {
  menuItemId: string;
  field: string;
  before: unknown;
  after: unknown;
};

export type Revision = {
  revisionNumber: number;
  createdAt: Date;
  createdBy: string;
  diffs: RevisionDiff[];
  menuItemsSnapshot: MenuItem[];
};

/**
 * Compute diffs between two menu item lists.
 */
export function computeMenuItemDiffs(
  before: MenuItem[],
  after: MenuItem[],
): RevisionDiff[] {
  const diffs: RevisionDiff[] = [];

  for (const afterItem of after) {
    const beforeItem = before.find((b) => b.id === afterItem.id);
    if (!beforeItem) {
      diffs.push({ menuItemId: afterItem.id, field: 'enabled', before: undefined, after: afterItem.enabled });
      continue;
    }

    if (beforeItem.enabled !== afterItem.enabled) {
      diffs.push({ menuItemId: afterItem.id, field: 'enabled', before: beforeItem.enabled, after: afterItem.enabled });
    }

    for (const afterLi of afterItem.lineItems) {
      const beforeLi = beforeItem.lineItems.find((l) => l.role === afterLi.role);
      if (!beforeLi) continue;

      if (beforeLi.baseHours !== afterLi.baseHours) {
        diffs.push({
          menuItemId: afterItem.id,
          field: `${afterLi.role}.baseHours`,
          before: beforeLi.baseHours,
          after: afterLi.baseHours,
        });
      }
    }
  }

  return diffs;
}

/**
 * Record a new revision with diffs.
 * Revisions are stored in agentState.revisions[].
 */
export function recordRevision(
  existingRevisions: Revision[],
  beforeItems: MenuItem[],
  afterItems: MenuItem[],
  createdBy: string,
): Revision[] {
  const diffs = computeMenuItemDiffs(beforeItems, afterItems);
  if (diffs.length === 0) return existingRevisions; // no changes, no revision

  const revision: Revision = {
    revisionNumber: (existingRevisions.at(-1)?.revisionNumber ?? 0) + 1,
    createdAt: new Date(),
    createdBy,
    diffs,
    menuItemsSnapshot: afterItems,
  };

  return [...existingRevisions, revision];
}
