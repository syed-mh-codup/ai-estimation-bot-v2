'use server';

import {
  prisma,
  type RoleKind,
  type MenuItem as MenuItemRow,
  type RoleLineItem as RoleLineItemRow,
  type EstimateSection as EstimateSectionRow,
} from '@repo/db';
import { auth } from '@/lib/auth';
import { requireUser } from '@/lib/rbac';

/**
 * Server actions backing the Menu Card editor. The client owns the optimistic
 * view, so these intentionally do NOT revalidate the page on the hot paths —
 * they persist and return the authoritative row (with real ids / recomputed
 * taxed hours) for the client to reconcile, or throw so the client reverts.
 *
 * Every mutation re-checks the session and refuses to touch a FINALISED
 * estimate (the page also renders read-only, but a server action can be invoked
 * independently).
 */

type Role = 'DEV' | 'QA' | 'PM' | 'BA';

/**
 * The editor's DTOs, derived from the Prisma row types rather than declared
 * fresh (AEH-227). Every field either of them carries IS a column — the editor
 * edits columns, so the row type is its honest contract, and adding a column
 * the editor should show now propagates here instead of needing a hand edit.
 * That is how `touchesFrontend`/`touchesBackend` reached the editor in the
 * first place.
 *
 * Deliberately NOT derived from `@repo/shared`'s `RoleLineItem`/`MenuItem`:
 * those carry envelope fields the editor never renders, and `sectionId`/`order`
 * are columns that the pipeline shapes do not have at all — so a `Pick` over
 * them would need a hand-written intersection, re-introducing exactly the
 * field list this removes.
 */
export type LineItemDTO = Pick<
  RoleLineItemRow,
  'id' | 'role' | 'title' | 'baseHours' | 'taxedHours' | 'edited' | 'touchesFrontend' | 'touchesBackend'
> & { envelope: LineEnvelope };

/**
 * What the Specialist council recorded about a line item beyond its hours.
 *
 * Nested for the same reason `CardFlags` is — see the note there. Flattening
 * `complexity` onto `LineItemDTO` would be worse than a missed clear: every
 * existing read of `baseHours`/`taxedHours`/`role` on this DTO would
 * re-attribute to the `RoleLineItem.meta` pseudo-model, orphaning three columns
 * that are consumed today.
 */
export type LineEnvelope = {
  /** The tier the Specialist priced at: base | elevated | high. */
  complexity: string | null;
  /** The Specialist discounted these hours for AI-assisted delivery. */
  aiAssistApplied: boolean;
  /** Historical presets the Specialist anchored the number to. */
  anchorPresetIds: string[];
};

const EMPTY_ENVELOPE: LineEnvelope = {
  complexity: null,
  aiAssistApplied: false,
  anchorPresetIds: [],
};

/**
 * Read the Specialist's envelope off a persisted line item.
 *
 * Permissive like `cardFlags`: a hand-added row has no council judgment behind
 * it, and saying so plainly beats inventing a tier for it.
 */
export function lineEnvelope(meta: RoleLineItemRow['meta']): LineEnvelope {
  const m = (meta ?? {}) as Partial<LineEnvelope>;
  return {
    complexity: typeof m.complexity === 'string' ? m.complexity : null,
    aiAssistApplied: m.aiAssistApplied === true,
    anchorPresetIds: Array.isArray(m.anchorPresetIds) ? m.anchorPresetIds : [],
  };
}
export type ItemDTO = Pick<
  MenuItemRow,
  | 'id'
  | 'title'
  | 'enabled'
  | 'taxonomyKey'
  | 'sectionId'
  | 'order'
  | 'injected'
  | 'category'
  | 'phase'
  | 'sourcePresetId'
  | 'matchScore'
> & { flags: CardFlags; lineItems: LineItemDTO[] };

/**
 * The Architect's per-card judgment, which lives in `MenuItem.meta` rather than
 * in columns of its own.
 *
 * Kept as a NESTED object rather than flattened onto `ItemDTO`, and that is not
 * a style choice. The field audit attributes a property read by structural
 * overlap against each model's field set, and it builds a pseudo-model for each
 * Json column whose fields are `model columns UNION discovered keys` — a strict
 * superset of the model. Mixing `toggleable`/`thinSlice` into the same
 * top-level shape as `category`/`phase` would make that pseudo-model outscore
 * `MenuItem` on every read of this DTO, silently re-attributing the column
 * reads below and orphaning columns that are consumed today. Nested, the two
 * shapes are scored separately and both resolve correctly. See AEH-253.
 */
export type CardFlags = {
  /** False when the Architect says this card is not the estimator's to switch off. */
  toggleable: boolean;
  /** Another requirement declares a Requires-edge onto this card's work. */
  notSafelyRemovable: boolean;
  /** Part of the earliest demoable path through the estimate. */
  thinSlice: boolean;
};

/**
 * Read the flags out of a persisted card, permissively.
 *
 * Absent meta means an ordinary card, never a locked one: rows predating the
 * envelope, and the e2e fixtures, are created with no `meta` at all, and the
 * safe reading of "the Architect never said" is "the estimator decides".
 */
export function cardFlags(meta: MenuItemRow['meta']): CardFlags {
  const m = (meta ?? {}) as Partial<CardFlags>;
  return {
    toggleable: m.toggleable !== false,
    notSafelyRemovable: m.notSafelyRemovable === true,
    thinSlice: m.thinSlice === true,
  };
}
export type SectionDTO = Pick<EstimateSectionRow, 'id' | 'title' | 'order'>;

async function requireSession(): Promise<void> {
  const session = await auth();
  if (!session?.user) throw new Error('Not authenticated');
}

/** Throws if the estimate is missing or FINALISED (edits are locked). */
async function assertEditable(estimateId: string): Promise<void> {
  const est = await prisma.estimate.findUnique({
    where: { id: estimateId },
    select: { status: true },
  });
  if (!est) throw new Error('Estimate not found');
  if (est.status === 'FINALISED') throw new Error('This estimate is finalised and cannot be edited');
}

async function estimateIdForItem(menuItemId: string): Promise<string> {
  const item = await prisma.menuItem.findUnique({
    where: { id: menuItemId },
    select: { estimateId: true },
  });
  if (!item) throw new Error('Menu item not found');
  return item.estimateId;
}

async function estimateIdForLineItem(lineItemId: string): Promise<{ estimateId: string; menuItemId: string }> {
  const li = await prisma.roleLineItem.findUnique({
    where: { id: lineItemId },
    select: { menuItem: { select: { id: true, estimateId: true } } },
  });
  if (!li) throw new Error('Line item not found');
  return { estimateId: li.menuItem.estimateId, menuItemId: li.menuItem.id };
}

/** Snap to 0.25h — line items are atomic <=4h units at 0.25h granularity. */
function snapToQuarterHour(hours: number): number {
  return Math.max(0, Math.round(hours * 4) / 4);
}

/** Tax % per role from the active config (DEV is untaxed). Mirrors the page. */
async function taxPercents(): Promise<Record<Role, number>> {
  const cfg = await prisma.estimationConfig.findFirst({
    where: { active: true },
    orderBy: { version: 'desc' },
  });
  return {
    DEV: 0,
    QA: cfg?.qaRegressionBufferPct ?? 0,
    PM: cfg?.pmCommunicationTaxPct ?? 0,
    BA: cfg?.baCommunicationTaxPct ?? 0,
  };
}

// ─── Sections ─────────────────────────────────────────────────────────────────

export async function createSection(estimateId: string, title: string): Promise<SectionDTO> {
  await requireSession();
  await assertEditable(estimateId);
  const max = await prisma.estimateSection.aggregate({
    where: { estimateId },
    _max: { order: true },
  });
  const section = await prisma.estimateSection.create({
    data: { estimateId, title: title.trim() || 'New section', order: (max._max.order ?? -1) + 1 },
    select: { id: true, title: true, order: true },
  });
  return section;
}

export async function renameSection(id: string, title: string): Promise<void> {
  await requireSession();
  const section = await prisma.estimateSection.findUnique({ where: { id }, select: { estimateId: true } });
  if (!section) throw new Error('Section not found');
  await assertEditable(section.estimateId);
  await prisma.estimateSection.update({ where: { id }, data: { title: title.trim() || 'Untitled section' } });
}

/** Deleting a section detaches its items (SetNull → Ungrouped), never deletes them. */
export async function deleteSection(id: string): Promise<void> {
  await requireSession();
  const section = await prisma.estimateSection.findUnique({ where: { id }, select: { estimateId: true } });
  if (!section) throw new Error('Section not found');
  await assertEditable(section.estimateId);
  await prisma.estimateSection.delete({ where: { id } });
}

// ─── Menu items ───────────────────────────────────────────────────────────────

export async function createMenuItem(estimateId: string, sectionId: string | null): Promise<ItemDTO> {
  await requireSession();
  await assertEditable(estimateId);
  const max = await prisma.menuItem.aggregate({
    where: { estimateId, sectionId },
    _max: { order: true },
  });
  const item = await prisma.menuItem.create({
    data: {
      estimateId,
      sectionId,
      title: 'New item',
      taxonomyKey: 'custom',
      enabled: true,
      order: (max._max.order ?? -1) + 1,
    },
    // `injected` is not passed on create — a card someone typed is by definition
    // not one the pipeline inferred, so the column default (false) is correct.
    // Selected here because ItemDTO requires it, and the editor renders inferred
    // rows differently.
    select: {
      id: true,
      title: true,
      enabled: true,
      taxonomyKey: true,
      sectionId: true,
      order: true,
      injected: true,
      category: true,
      phase: true,
      sourcePresetId: true,
      matchScore: true,
      meta: true,
    },
  });
  // A hand-added card carries no Architect judgment, so `cardFlags` gives it the
  // permissive defaults — freely toggleable, not on the thin slice.
  return { ...item, flags: cardFlags(item.meta), lineItems: [] };
}

export async function renameMenuItem(id: string, title: string): Promise<void> {
  await requireSession();
  await assertEditable(await estimateIdForItem(id));
  await prisma.menuItem.update({ where: { id }, data: { title: title.trim() || 'Untitled item' } });
}

/**
 * Switch a card in or out of the estimate.
 *
 * The Architect marks a card `notSafelyRemovable` when another requirement
 * declares a Requires-edge onto its work — switching it off does not remove
 * scope, it removes scope something else is standing on. That judgment was
 * computed and persisted on every run and then read by nothing, so the editor
 * happily let a BA switch off a foundation card the pipeline knew was load
 * bearing. This is the gate; the disabled button in the editor is the courtesy.
 */
export async function setItemEnabled(id: string, enabled: boolean): Promise<void> {
  await requireSession();
  const item = await prisma.menuItem.findUnique({
    where: { id },
    select: { estimateId: true, title: true, meta: true },
  });
  if (!item) throw new Error('Menu item not found');
  await assertEditable(item.estimateId);

  if (!enabled) {
    const flags = cardFlags(item.meta);
    if (flags.notSafelyRemovable) {
      throw new Error(
        `"${item.title}" can't be switched off — other scope in this estimate depends on it.`,
      );
    }
    if (!flags.toggleable) {
      throw new Error(`"${item.title}" is not optional scope.`);
    }
  }

  await prisma.menuItem.update({ where: { id }, data: { enabled } });
}

export async function deleteMenuItem(id: string): Promise<void> {
  await requireSession();
  await assertEditable(await estimateIdForItem(id));
  // RoleLineItem rows cascade (onDelete: Cascade).
  await prisma.menuItem.delete({ where: { id } });
}

/**
 * Move an item to a (possibly different) section and persist the target
 * section's full ordering. `orderedIds` is every item id in the destination
 * section, in the order they should appear.
 */
export async function moveMenuItem(
  id: string,
  toSectionId: string | null,
  orderedIds: string[],
): Promise<void> {
  await requireSession();
  await assertEditable(await estimateIdForItem(id));
  await prisma.$transaction([
    prisma.menuItem.update({ where: { id }, data: { sectionId: toSectionId } }),
    ...orderedIds.map((itemId, index) =>
      prisma.menuItem.update({ where: { id: itemId }, data: { order: index } }),
    ),
  ]);
}

// ─── Line items ───────────────────────────────────────────────────────────────

export async function createLineItem(menuItemId: string, role: RoleKind): Promise<LineItemDTO> {
  await requireSession();
  await assertEditable(await estimateIdForItem(menuItemId));
  const li = await prisma.roleLineItem.create({
    data: { menuItemId, role, title: '', baseHours: 0, taxedHours: 0, edited: true },
    select: { id: true, role: true, title: true, baseHours: true, taxedHours: true, edited: true, touchesFrontend: true, touchesBackend: true },
  });
  // Typed by hand, so there is no council judgment to carry.
  return { ...li, envelope: EMPTY_ENVELOPE };
}

export async function updateLineItem(
  id: string,
  patch: { title?: string; baseHours?: number },
): Promise<LineItemDTO> {
  await requireSession();
  const { estimateId } = await estimateIdForLineItem(id);
  await assertEditable(estimateId);

  const existing = await prisma.roleLineItem.findUniqueOrThrow({
    where: { id },
    select: { role: true, baseHours: true },
  });

  const data: { title?: string; baseHours?: number; taxedHours?: number; edited: boolean } = {
    edited: true,
  };
  if (patch.title !== undefined) data.title = patch.title;
  if (patch.baseHours !== undefined) {
    const pct = await taxPercents();
    const baseHours = snapToQuarterHour(patch.baseHours);
    data.baseHours = baseHours;
    data.taxedHours = snapToQuarterHour(
      baseHours * (1 + (pct[existing.role as Role] ?? 0) / 100),
    );
  }

  const li = await prisma.roleLineItem.update({
    where: { id },
    data,
    select: { id: true, role: true, title: true, baseHours: true, taxedHours: true, edited: true, touchesFrontend: true, touchesBackend: true, meta: true },
  });
  return { ...li, envelope: lineEnvelope(li.meta) };
}

/**
 * Set which side of the stack a DEV line item touches.
 *
 * Note what this does NOT do: it never touches `baseHours`/`taxedHours`. The
 * hours stay one combined figure — these flags say what that figure covers.
 * Summing DEV rows by them is what lets a finalised estimate map onto a
 * preset's beHours/feHours exactly, instead of inventing the frontend share.
 */
export async function setLineItemSide(
  id: string,
  side: { touchesFrontend: boolean; touchesBackend: boolean },
): Promise<LineItemDTO> {
  await requireSession();
  const { estimateId } = await estimateIdForLineItem(id);
  await assertEditable(estimateId);
  const li = await prisma.roleLineItem.update({
    where: { id },
    data: { touchesFrontend: side.touchesFrontend, touchesBackend: side.touchesBackend, edited: true },
    select: { id: true, role: true, title: true, baseHours: true, taxedHours: true, edited: true, touchesFrontend: true, touchesBackend: true, meta: true },
  });
  return { ...li, envelope: lineEnvelope(li.meta) };
}

export async function deleteLineItem(id: string): Promise<void> {
  await requireSession();
  const { estimateId } = await estimateIdForLineItem(id);
  await assertEditable(estimateId);
  await prisma.roleLineItem.delete({ where: { id } });
}

// ─── Estimate header / body ─────────────────────────────────────────────────────

export async function renameEstimate(id: string, title: string): Promise<void> {
  await requireSession();
  await assertEditable(id);
  const trimmed = title.trim();
  if (!trimmed) return;
  await prisma.estimate.update({ where: { id }, data: { title: trimmed } });
}

/** Set the 1–5 complexity score, or clear it with null. */
export async function setComplexityScore(id: string, score: number | null): Promise<void> {
  await requireSession();
  await assertEditable(id);
  const clamped = score == null ? null : Math.min(5, Math.max(1, Math.round(score)));
  await prisma.estimate.update({ where: { id }, data: { complexityScore: clamped } });
}

export async function updateNarrative(id: string, items: string[]): Promise<void> {
  await requireSession();
  await assertEditable(id);
  await prisma.estimate.update({ where: { id }, data: { narrative: cleanList(items) } });
}

export async function updateAssumptions(id: string, items: string[]): Promise<void> {
  await requireSession();
  await assertEditable(id);
  await prisma.estimate.update({ where: { id }, data: { assumptions: cleanList(items) } });
}

/** Drop empty trailing entries but keep intentional order. */
function cleanList(items: string[]): string[] {
  return items.map((s) => s.trim()).filter((s) => s.length > 0);
}

/**
 * Delete an estimate and everything under it (sections, menu items, line items,
 * uploaded files all cascade). Allowed regardless of status — the owner may
 * remove a finalised estimate.
 *
 * Unlike the edit actions above, this is restricted to the owner or an admin.
 * Every signed-in user can *see* and edit every estimate — that's the shared
 * workspace this tool is — but destruction is not recoverable, so it needs an
 * accountable actor rather than merely an authenticated one.
 */
export async function deleteEstimate(id: string): Promise<void> {
  await requireEstimateOwnerOrAdmin(id);
  await prisma.estimate.delete({ where: { id } });
}

/** Throws unless the caller owns this estimate or is an admin. */
async function requireEstimateOwnerOrAdmin(estimateId: string): Promise<void> {
  const user = await requireUser();
  if (user.role === 'ADMIN') return;
  const est = await prisma.estimate.findUnique({
    where: { id: estimateId },
    select: { ownerId: true },
  });
  if (!est) throw new Error('Estimate not found');
  if (est.ownerId !== user.id) {
    throw new Error('Only the owner or an admin can delete this estimate');
  }
}
