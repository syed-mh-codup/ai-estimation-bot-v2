'use server';

import { prisma, reconcileStatements, type RoleKind } from '@repo/db';
import {
  isTaxableRole,
  isValidBufferPct,
  MAX_BUFFER_PCT,
  MIN_BUFFER_PCT,
  OVERRIDE_FIELD,
  snapToQuarterHour,
  taxedHoursFor,
  type LineProvenance,
  type RateOverrides,
  type TaxPercents,
} from '@repo/shared';
import { auth } from '@/lib/auth';
import { requireUser } from '@/lib/rbac';
import { after } from 'next/server';
import { fromDateInputValue } from '@/lib/due-date';
import { sendCustodyAssignedEmail } from '@/lib/email';
import { RATE_SELECT, taxContextFor, taxContextForEstimate } from '@/lib/estimate-tax';
import {
  assertCardRoleAcceptsNewLine,
  assertCardStructureUnlocked,
  assertCardTitleUnlocked,
  assertLineItemUnlocked,
  assertRoleUnlockedForBuffer,
} from '@/lib/lock-guards';
import { cardFlags, lineEnvelope, EMPTY_ENVELOPE } from './dto';
import type { ItemDTO, LineItemDTO, SectionDTO } from './dto';

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
      overhead: true,
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
  const actor = await requireUser();
  await assertEditable(await estimateIdForItem(id));
  // Only refused once EVERY row on the card is locked — a title describes the
  // whole card, so one frozen role slice says nothing about it. AEH-238.
  await assertCardTitleUnlocked(id, actor.id);
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
  const actor = await requireUser();
  const item = await prisma.menuItem.findUnique({
    where: { id },
    select: { estimateId: true, title: true, meta: true },
  });
  if (!item) throw new Error('Menu item not found');
  await assertEditable(item.estimateId);
  // Switching a card off does not touch a row, but it removes those hours from
  // every total on the estimate — which is the number a lock protects. AEH-238.
  await assertCardStructureUnlocked(id, actor.id);

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
  const actor = await requireUser();
  await assertEditable(await estimateIdForItem(id));
  // The cascade below is exactly why this is guarded: deleting the card would
  // take locked rows with it without ever touching a guarded row. AEH-238.
  await assertCardStructureUnlocked(id, actor.id);
  // RoleLineItem rows cascade (onDelete: Cascade).
  await prisma.menuItem.delete({ where: { id } });
}

/**
 * Move an item to a (possibly different) section and persist the target
 * section's full ordering. `orderedIds` is every item id in the destination
 * section, in the order they should appear.
 *
 * Deliberately NOT lock-guarded. Placement is presentational — `sectionId` and
 * `order` change nothing about anybody's hours — so a reviewer tidying the
 * board is not editing settled work. This is also why locks are materialised to
 * rows rather than tested against section membership: if a lock were evaluated
 * live, this function would be a way to escape one. AEH-238.
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
  const actor = await requireUser();
  await assertEditable(await estimateIdForItem(menuItemId));
  // Appending to a frozen slice moves that slice's total as surely as editing
  // one of its rows would, so a locked card-role refuses new lines. AEH-238.
  await assertCardRoleAcceptsNewLine(menuItemId, role, actor.id);
  const li = await prisma.roleLineItem.create({
    data: { menuItemId, role, title: '', baseHours: 0, taxedHours: 0, provenance: 'HUMAN' },
    select: { id: true, role: true, title: true, baseHours: true, taxedHours: true, provenance: true, touchesFrontend: true, touchesBackend: true },
  });
  // Typed by hand, so there is no council judgment to carry.
  return { ...li, envelope: EMPTY_ENVELOPE };
}

export async function updateLineItem(
  id: string,
  patch: { title?: string; baseHours?: number },
): Promise<LineItemDTO> {
  const actor = await requireUser();
  const { estimateId } = await estimateIdForLineItem(id);
  await assertEditable(estimateId);
  await assertLineItemUnlocked(id, actor.id);

  const existing = await prisma.roleLineItem.findUniqueOrThrow({
    where: { id },
    select: { role: true, baseHours: true },
  });

  const data: {
    title?: string;
    baseHours?: number;
    taxedHours?: number;
    provenance: LineProvenance;
  } = {
    // A person typed this. The engine writes STEERED through its own path, so
    // this stays unconditionally HUMAN. AEH-238.
    provenance: 'HUMAN',
  };
  if (patch.title !== undefined) data.title = patch.title;
  if (patch.baseHours !== undefined) {
    // The estimate's own buffers, from the config version it is pinned to —
    // not whichever config is active now. Editing one line used to re-tax it at
    // the current house rate, which is how an estimate's stored hours ended up
    // a mix of two config versions. AEH-335.
    const { effective } = await taxContextForEstimate(estimateId);
    const baseHours = snapToQuarterHour(patch.baseHours);
    data.baseHours = baseHours;
    data.taxedHours = taxedHoursFor(baseHours, effective[existing.role] ?? 0);
  }

  const li = await prisma.roleLineItem.update({
    where: { id },
    data,
    select: { id: true, role: true, title: true, baseHours: true, taxedHours: true, provenance: true, touchesFrontend: true, touchesBackend: true, meta: true },
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
  const actor = await requireUser();
  const { estimateId } = await estimateIdForLineItem(id);
  await assertEditable(estimateId);
  // These flags carry no hours, but they say what the row's number covers, and
  // that is part of the description a lock freezes. AEH-238.
  await assertLineItemUnlocked(id, actor.id);
  const li = await prisma.roleLineItem.update({
    where: { id },
    data: { touchesFrontend: side.touchesFrontend, touchesBackend: side.touchesBackend, provenance: 'HUMAN' },
    select: { id: true, role: true, title: true, baseHours: true, taxedHours: true, provenance: true, touchesFrontend: true, touchesBackend: true, meta: true },
  });
  return { ...li, envelope: lineEnvelope(li.meta) };
}

export async function deleteLineItem(id: string): Promise<void> {
  const actor = await requireUser();
  const { estimateId } = await estimateIdForLineItem(id);
  await assertEditable(estimateId);
  await assertLineItemUnlocked(id, actor.id);
  await prisma.roleLineItem.delete({ where: { id } });
}

// ─── Per-estimate buffers ─────────────────────────────────────────────────────

export type TaxPctResult = {
  /** The buffers in force after the change. */
  effective: TaxPercents;
  /** Which roles the estimate now sets for itself. Null means inherit. */
  overrides: RateOverrides;
  /** True once the overhead cards hold hours computed at superseded rates. */
  overheadRatesStale: boolean;
  /**
   * Every line item whose hours actually moved, so the client reconciles
   * against what was stored rather than trusting its own prediction. The two
   * use the same `taxedHoursFor`, so they should agree — this is what makes
   * that a checkable claim instead of a hopeful one.
   */
  lineItems: { id: string; taxedHours: number }[];
};

/**
 * Set or clear one role's buffer for one estimate, and re-tax that role's work.
 *
 * `pct` is whole percent, or null to go back to inheriting the house default.
 * Null is the only thing that inherits: zero is a real buffer, and "this client
 * needs no BA time" is the case the lever was asked for.
 *
 * Three things here are deliberate and load-bearing.
 *
 * The recompute is ROLE-SCOPED. Re-taxing the whole estimate would quietly
 * "heal" PM and BA lines still carrying mixed-version hours from the bug this
 * ticket fixes, so nudging QA would move numbers nobody touched. A buffer
 * change means what it says: only that role's hours move.
 *
 * Overhead cards are excluded. Their hours are already a percentage OF taxed
 * hours (injectProcessOverhead), so re-taxing one compounds a percentage on a
 * percentage. They are marked stale instead — never regenerated, because
 * nothing on them separates a generated figure from an estimator's edit, and a
 * rewrite would discard real decisions and resurrect deleted cards.
 *
 * `provenance` is NOT set. It says where a number came from, and a buffer change is
 * not a touch of any individual line.
 */
export async function setEstimateTaxPct(
  estimateId: string,
  role: string,
  pct: number | null,
): Promise<TaxPctResult> {
  const actor = await requireUser();
  await assertEditable(estimateId);

  if (!isTaxableRole(role)) {
    throw new Error(`${role} has no buffer to set`);
  }
  if (pct !== null && !isValidBufferPct(pct)) {
    throw new Error(`A buffer must be between ${MIN_BUFFER_PCT} and ${MAX_BUFFER_PCT} percent`);
  }
  // A buffer move recomputes taxedHours for every row of the role, so it is a
  // bulk hour change wearing different clothes. Letting it through would rewrite
  // frozen hours without ever touching a guarded action. AEH-238.
  await assertRoleUnlockedForBuffer(estimateId, role, actor.id);
  const field = OVERRIDE_FIELD[role];

  return prisma.$transaction(
    async (tx) => {
      const before = await tx.estimate.findUniqueOrThrow({
        where: { id: estimateId },
        select: RATE_SELECT,
      });

      const est = await tx.estimate.update({
        where: { id: estimateId },
        data: { [field]: pct },
        select: { ...RATE_SELECT, overheadRatesStale: true },
      });
      const { effective, overrides } = await taxContextFor(est, tx);

      // Only this role's own work, and never an overhead card.
      const lines = await tx.roleLineItem.findMany({
        where: { role, menuItem: { estimateId, overhead: false } },
        select: { id: true, baseHours: true, taxedHours: true },
      });

      // Grouped by resulting figure rather than issued per row: a line item is
      // an atomic unit of at most four hours at quarter-hour granularity, so a
      // whole estimate's worth of them collapses into a handful of distinct
      // values. Over a remote database that is the difference between a dozen
      // round trips and hundreds. Rows already holding the right figure are
      // skipped entirely, which makes a repeated call free.
      const moved = new Map<number, string[]>();
      for (const line of lines) {
        const taxed = taxedHoursFor(line.baseHours, effective[role]);
        if (taxed === line.taxedHours) continue;
        const ids = moved.get(taxed);
        if (ids) ids.push(line.id);
        else moved.set(taxed, [line.id]);
      }
      for (const [taxedHours, ids] of moved) {
        await tx.roleLineItem.updateMany({ where: { id: { in: ids } }, data: { taxedHours } });
      }

      // Only claim staleness if there is actually an overhead card to be stale,
      // and only when something moved — a no-op call must not raise the flag.
      const overheadCards = await tx.menuItem.count({ where: { estimateId, overhead: true } });
      const overheadRatesStale =
        est.overheadRatesStale || (overheadCards > 0 && moved.size > 0);
      if (overheadRatesStale !== est.overheadRatesStale) {
        await tx.estimate.update({ where: { id: estimateId }, data: { overheadRatesStale } });
      }

      // Provenance. No change reason is asked for: this is meant to be a
      // routine, exploratory nudge, and a mandatory reason on every one of them
      // collects nothing but the word "adjusting". Recorded even when no hours
      // moved, because the decision was still made.
      if (before[field] !== pct) {
        await tx.estimateTaxChange.create({
          data: {
            estimateId,
            role,
            fromPct: before[field],
            toPct: pct,
            changedBy: actor.id,
          },
        });
      }

      return {
        effective,
        overrides,
        overheadRatesStale,
        lineItems: [...moved].flatMap(([taxedHours, ids]) =>
          ids.map((id) => ({ id, taxedHours })),
        ),
      };
    },
    // Many small writes over a remote database (Neon); the default 5s
    // interactive-transaction budget is not enough for a large estimate. Same
    // reasoning as the pipeline's persist step.
    { timeout: 30_000 },
  );
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

/**
 * Hand day-to-day responsibility for this estimate to somebody, or clear it
 * with null.
 *
 * Not restricted to the owner or an admin: this is an edit, and every signed-in
 * user may edit any estimate here. Handing custody to a DISABLED account is
 * refused, mirroring the same guard on admin/users reassignment — an account
 * nobody can sign in to would be a custodian who never answers. (The sweep
 * guards this a second time, for accounts disabled after the fact.)
 */
export async function setCustodian(id: string, custodianId: string | null): Promise<void> {
  const actor = await requireUser();
  await assertEditable(id);

  const est = await prisma.estimate.findUnique({
    where: { id },
    select: { title: true, dueAt: true, custodianId: true },
  });
  if (!est) throw new Error('Estimate not found');
  // A re-submitted identical value is a no-op, not a re-assignment. Without
  // this the same person gets told twice that the same thing is now theirs.
  if (est.custodianId === custodianId) return;

  let target: { name: string | null; email: string } | null = null;
  if (custodianId) {
    const found = await prisma.user.findUnique({
      where: { id: custodianId },
      select: { name: true, email: true, disabledAt: true },
    });
    if (!found) throw new Error('That account no longer exists');
    if (found.disabledAt) throw new Error('That account is disabled — pick an active one');
    target = { name: found.name, email: found.email };
  }

  await prisma.estimate.update({ where: { id }, data: { custodianId } });

  // Tell them. Anyone signed in can hand anyone else an estimate, so without a
  // note the first you hear of it is a deadline reminder for work you did not
  // know was yours.
  //
  // `after()` rather than awaiting it: this action is awaited by the picker's
  // optimistic transition, and an SMTP round trip inside it makes the select
  // feel broken. A detached promise would simply die on serverless.
  if (target && custodianId !== actor.id) {
    const recipient = target;
    after(async () => {
      try {
        const assigner = await prisma.user.findUnique({
          where: { id: actor.id },
          select: { name: true, email: true },
        });
        await sendCustodyAssignedEmail({
          to: recipient.email,
          name: recipient.name,
          title: est.title,
          estimateId: id,
          dueAt: est.dueAt,
          now: new Date(),
          assignedBy: assigner?.name || assigner?.email || 'Someone',
        });
      } catch (err) {
        // Never surface: custody has already changed, and failing the action
        // now would revert the picker over an email that is best-effort by
        // design (SMTP is an optional integration here).
        console.error(`[email] custody notice failed for estimate ${id}:`, err);
      }
    });
  }
}

/**
 * Set or clear the deadline. `value` is the `<input type="date">` form —
 * `YYYY-MM-DD`, or empty for no deadline.
 *
 * The reminder rows go with it, in the same transaction. A moved deadline is a
 * NEW deadline and none of its reminders have been sent yet; leaving the old
 * rows behind would silence every nudge for the new date, and doing the two
 * writes separately would leave exactly that state behind on a crash between
 * them. (AEH-244 learned this the hard way: a schema split turns one atomic row
 * write into N, and a half-written N is a silent wrong answer.)
 */
export async function setDueAt(id: string, value: string | null): Promise<void> {
  await requireSession();
  await assertEditable(id);

  const dueAt = fromDateInputValue(value ?? '');

  const current = await prisma.estimate.findUnique({ where: { id }, select: { dueAt: true } });
  if (!current) throw new Error('Estimate not found');
  // Same date re-submitted (a blur with no edit): doing nothing is not just an
  // optimisation, it is what stops a no-op save from re-arming reminders that
  // have already gone out.
  if ((current.dueAt?.getTime() ?? null) === (dueAt?.getTime() ?? null)) return;

  await prisma.$transaction([
    prisma.estimateReminder.deleteMany({ where: { estimateId: id } }),
    prisma.estimate.update({ where: { id }, data: { dueAt } }),
  ]);
}

/**
 * Save the narrative list.
 *
 * `reconcileStatements` rather than a wholesale replace, and the difference is
 * the point of AEH-238 promoting these to rows. The editor is a list of text
 * boxes and sends the whole list, but a line whose text has not changed keeps
 * its id, its provenance and anything pointing at it — so inserting a point at
 * the top no longer reads as "every point changed".
 */
export async function updateNarrative(id: string, items: string[]): Promise<void> {
  await requireSession();
  await assertEditable(id);
  await reconcileStatements(prisma, {
    estimateId: id,
    kind: 'NARRATIVE',
    texts: cleanList(items),
    // Somebody typed into the list, so anything new here is theirs.
    provenance: 'HUMAN',
  });
}

/** Save the assumptions list. See `updateNarrative` for the reconciliation. */
export async function updateAssumptions(id: string, items: string[]): Promise<void> {
  await requireSession();
  await assertEditable(id);
  await reconcileStatements(prisma, {
    estimateId: id,
    kind: 'ASSUMPTION',
    texts: cleanList(items),
    provenance: 'HUMAN',
  });
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
