'use server';

import { prisma, type RoleKind } from '@repo/db';
import { auth } from '@/lib/auth';

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

export type LineItemDTO = {
  id: string;
  role: RoleKind;
  title: string | null;
  baseHours: number;
  taxedHours: number;
  edited: boolean;
};
export type ItemDTO = {
  id: string;
  title: string;
  enabled: boolean;
  taxonomyKey: string;
  sectionId: string | null;
  order: number;
  lineItems: LineItemDTO[];
};
export type SectionDTO = { id: string; title: string; order: number };

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

export async function reorderSections(estimateId: string, orderedIds: string[]): Promise<void> {
  await requireSession();
  await assertEditable(estimateId);
  await prisma.$transaction(
    orderedIds.map((id, index) =>
      prisma.estimateSection.update({ where: { id }, data: { order: index } }),
    ),
  );
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
    select: { id: true, title: true, enabled: true, taxonomyKey: true, sectionId: true, order: true },
  });
  return { ...item, lineItems: [] };
}

export async function renameMenuItem(id: string, title: string): Promise<void> {
  await requireSession();
  await assertEditable(await estimateIdForItem(id));
  await prisma.menuItem.update({ where: { id }, data: { title: title.trim() || 'Untitled item' } });
}

export async function setItemEnabled(id: string, enabled: boolean): Promise<void> {
  await requireSession();
  await assertEditable(await estimateIdForItem(id));
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
    select: { id: true, role: true, title: true, baseHours: true, taxedHours: true, edited: true },
  });
  return li;
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
    select: { id: true, role: true, title: true, baseHours: true, taxedHours: true, edited: true },
  });
  return li;
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
 */
export async function deleteEstimate(id: string): Promise<void> {
  await requireSession();
  await prisma.estimate.delete({ where: { id } });
}
