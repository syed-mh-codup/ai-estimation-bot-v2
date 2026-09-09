import {
  applyRegionReplace,
  regionFingerprint,
  toMenuItem,
  type ApplyOutcome,
  type PrismaClient,
  type ProposedRow,
  type RoleKind,
} from '@repo/db';
import type { IModelProvider } from '@repo/providers';
import {
  LibrarianOutputSchema,
  type ExistingLine,
  type Requirement,
  type SpecialistOutput,
  type TaxPercents,
} from '@repo/shared';

import { runSpecialist, type SpecialistContext } from './specialist';
import { loadActivePrompt } from './run-estimate';
import { createUsageRecorder } from './usage-recorder';

/**
 * The steered-edit engine — AEH-238.
 *
 * A person declares an envelope of `scope x role`, says what should happen to
 * it, and the estimator council re-prices exactly that. Nothing here decides
 * what may be touched: the envelope was resolved and pinned when the job was
 * dispatched, and `applyRegionReplace` writes to those ids and no others.
 *
 * The council, not a new agent. That is the load-bearing decision in this file.
 * Every edit is a re-assessment against the requirement — a 30 percent cut
 * applied to a half-hour row gives 0.35 hours, which breaks both the
 * quarter-hour granularity and the four-hour decomposition every other row
 * obeys, so the work has to be re-thought for the hours to be honest. That is
 * precisely what `runSpecialist` does, against the same admin-authored prompts
 * the estimate was costed with. A purpose-built edit agent would re-derive the
 * decomposition rules in a fresh prompt and diverge from the crew's numbers on
 * its first run.
 *
 * One model call per card per role, each in its own durable step. That falls out
 * of the same choice: the envelope's axes ARE the council's granularity, so
 * "DEV on these two cards" is two calls to SPECIALIST_DEV and touches no other
 * prompt.
 */

/** Everything the engine needs that it should not go and find for itself. */
export type LedgerEditDeps = {
  db: PrismaClient;
  modelProvider: IModelProvider;
  /**
   * The buffers in force for this estimate's PINNED config version.
   *
   * A parameter rather than a lookup, because resolving it means deciding which
   * config version applies, and AEH-335 exists because that decision was once
   * made in the wrong place. The web layer owns it (`taxContextForEstimate`)
   * and both the manual edit path and this one read it from there.
   */
  effective: TaxPercents;
  /** Durable-execution seam. Defaults to running each step inline. */
  step?: <T>(id: string, fn: () => Promise<T>) => Promise<T>;
  /** Fired as each card is re-assessed, so the ledger can show progress. */
  onProgress?: (p: { stage: string; pct: number }) => void | Promise<void>;
};

export type LedgerEditResult = {
  outcome: ApplyOutcome;
  /** Cards the council was asked to re-price. */
  cardsReassessed: number;
  /** What the council said it was doing, collated across the slices. */
  reasoning: string;
};

/**
 * Render the rest of the estimate as context the council may read but not price.
 *
 * The wide-read half of "read is wide, write is narrow", and it is not a
 * courtesy. A council re-pricing one card in isolation will happily re-invent
 * work that already exists on another, and it cannot avoid what it cannot see.
 *
 * A summary rather than the ledger. What stops a duplicate is knowing that a
 * Reporting card exists and costs 40 DEV hours — not reading its sixteen
 * descriptions. On the estimate this feature was measured against that is the
 * difference between about forty lines and eight hundred and sixty-three.
 *
 * Locked cards are marked rather than omitted, which the reporter was explicit
 * about: a locked card stays visible to the model and is merely unwritable.
 * Hiding it would be the worst of both worlds — the council would neither be
 * able to change it nor know it was there.
 */
export function renderLedgerContext(
  cards: Array<{
    title: string;
    enabled: boolean;
    roleHours: Partial<Record<RoleKind, number>>;
    inEnvelope: boolean;
    lockedRoles: RoleKind[];
  }>,
): string {
  if (cards.length === 0) return '(this estimate has no other cards)';
  return cards
    .map((c) => {
      const hours = (['DEV', 'QA', 'PM', 'BA'] as const)
        .map((r) => (c.roleHours[r] ? `${r} ${c.roleHours[r]}h` : null))
        .filter((s): s is string => s !== null)
        .join(', ');
      const marks = [
        c.inEnvelope ? 'YOU ARE REVISING THIS CARD' : null,
        c.lockedRoles.length > 0 ? `settled and unchangeable: ${c.lockedRoles.join(', ')}` : null,
        !c.enabled ? 'switched off, not counted in the total' : null,
      ].filter((s): s is string => s !== null);
      return `- ${c.title} — ${hours || 'no hours yet'}${
        marks.length ? ` [${marks.join('; ')}]` : ''
      }`;
    })
    .join('\n');
}

/** The council's output as rows for one card, ready for the ledger. */
function toProposedRows(
  outputs: SpecialistOutput[],
  menuItemId: string,
): { rows: ProposedRow[]; assumptions: string[] } {
  const rows: ProposedRow[] = [];
  const assumptions: string[] = [];
  for (const out of outputs) {
    assumptions.push(...out.assumptions);
    for (const li of out.lineItems) {
      rows.push({
        menuItemId,
        // The role is the OUTPUT's, not the line item's: one specialist call is
        // one role, and its items carry no role of their own.
        role: out.role,
        title: li.description,
        baseHours: li.hours,
        touchesFrontend: li.touchesFrontend,
        touchesBackend: li.touchesBackend,
        // The same envelope the pipeline stores, so a steered row is
        // indistinguishable in shape from a costed one and every reader that
        // renders complexity or anchors keeps working.
        meta: {
          id: li.id,
          requirementId: li.requirementId,
          complexity: li.complexity,
          aiAssistApplied: li.aiAssistApplied,
          dependsOn: li.dependsOn,
          anchorPresetIds: li.anchorPresetIds,
        },
      });
    }
  }
  return { rows, assumptions };
}

/**
 * The requirement a card's work is priced against.
 *
 * Read from `Estimate.agentState.librarianOutput`, which every run persists —
 * this is why a slice re-cost needs no new pipeline seam. The ticket claimed the
 * partial-run mechanism had to be designed from scratch; in fact its inputs
 * have been in the database all along.
 *
 * A card can cover several requirements. The first is used, and the rest are
 * named in the prompt through the card's own title, because `runSpecialist`
 * prices ONE requirement per call and splitting a card's hours across several
 * would be inventing an apportionment nobody asked for.
 */
function requirementForCard(
  requirements: Requirement[],
  requirementIds: string[],
): Requirement | null {
  for (const id of requirementIds) {
    const found = requirements.find((r) => r.id === id);
    if (found) return found;
  }
  return null;
}

/**
 * Re-price a pinned region and write it.
 *
 * Mirrors `runEstimate`'s shape deliberately — a `step` seam that defaults to
 * inline, progress reported through a callback the web layer persists — so the
 * Inngest function around it stays a thin adapter and the whole thing is
 * runnable in a test with no durable executor at all.
 */
export async function runLedgerEdit(
  editId: string,
  deps: LedgerEditDeps,
): Promise<LedgerEditResult> {
  const { db, modelProvider, effective } = deps;
  const step = deps.step ?? (<T>(_id: string, fn: () => Promise<T>) => fn());
  const report = async (stage: string, pct: number): Promise<void> => {
    if (deps.onProgress) await deps.onProgress({ stage, pct });
  };

  const edit = await db.ledgerEdit.findUniqueOrThrow({
    where: { id: editId },
    // Named columns, never a bare findUnique: the snapshot payloads live on
    // this row and a default select would drag them across the wire on every
    // job. See the note on the model.
    select: {
      estimateId: true,
      prompt: true,
      roles: true,
      pinnedLineItemIds: true,
      pinnedCardIds: true,
      fingerprint: true,
    },
  });

  await report('Reading the estimate', 5);

  const estimate = await db.estimate.findUniqueOrThrow({
    where: { id: edit.estimateId },
    select: { agentState: true, complexityScore: true },
  });

  // Tolerant on purpose: an estimate whose run predates a change to the
  // diagnostics shape must still be editable, and the requirement set is the
  // only part of `agentState` this needs.
  const parsed = LibrarianOutputSchema.safeParse(
    (estimate.agentState as { librarianOutput?: unknown } | null)?.librarianOutput,
  );
  const requirements: Requirement[] = parsed.success ? parsed.data.requirements : [];

  const pinned = await db.roleLineItem.findMany({
    where: { id: { in: edit.pinnedLineItemIds } },
    select: {
      id: true,
      menuItemId: true,
      role: true,
      title: true,
      baseHours: true,
      provenance: true,
    },
  });

  // Every card on the estimate, for the wide read; the envelope's cards are
  // marked rather than separated so one render serves both purposes.
  const allCards = await db.menuItem.findMany({
    where: { estimateId: edit.estimateId },
    orderBy: { order: 'asc' },
    select: {
      id: true,
      title: true,
      enabled: true,
      taxonomyKey: true,
      category: true,
      phase: true,
      sourcePresetId: true,
      matchScore: true,
      injected: true,
      sectionId: true,
      foundation: true,
      overhead: true,
      order: true,
      estimateId: true,
      meta: true,
      updatedAt: true,
      lineItems: {
        select: {
          id: true,
          menuItemId: true,
          role: true,
          title: true,
          baseHours: true,
          taxedHours: true,
          notes: true,
          provenance: true,
          touchesFrontend: true,
          touchesBackend: true,
          meta: true,
          updatedAt: true,
        },
      },
    },
  });

  const lockedRows = await db.ledgerLock.findMany({
    where: { estimateId: edit.estimateId },
    select: { lineItemId: true },
  });
  const lockedIds = new Set(lockedRows.map((l) => l.lineItemId));
  const envelopeCards = new Set(edit.pinnedCardIds);

  const ledgerContext = renderLedgerContext(
    allCards.map((card) => {
      const roleHours: Partial<Record<RoleKind, number>> = {};
      const lockedRoles = new Set<RoleKind>();
      for (const li of card.lineItems) {
        roleHours[li.role] = (roleHours[li.role] ?? 0) + li.baseHours;
        if (lockedIds.has(li.id)) lockedRoles.add(li.role);
      }
      return {
        title: card.title,
        enabled: card.enabled,
        roleHours,
        inEnvelope: envelopeCards.has(card.id),
        lockedRoles: [...lockedRoles],
      };
    }),
  );

  // Only the roles this envelope actually names. Loading all four would mean
  // four prompt reads for a DEV-only edit, and a missing prompt row for an
  // unused role would fail an edit that never needed it.
  const rolesInPlay = [...new Set(pinned.map((p) => p.role))].filter((r) =>
    (edit.roles as RoleKind[]).includes(r),
  );

  await report('Loading prompts', 10);
  const prompts = Object.fromEntries(
    await Promise.all(
      rolesInPlay.map(
        async (role) => [role, await loadActivePrompt(db, `SPECIALIST_${role}` as never)] as const,
      ),
    ),
  ) as Record<RoleKind, Awaited<ReturnType<typeof loadActivePrompt>>>;

  const recorder = createUsageRecorder({
    db,
    estimateId: edit.estimateId,
    // Attribution by join rather than by a new usage kind — the call really is
    // a SPECIALIST_* call. See ModelUsage.ledgerEditId.
    ledgerEditId: editId,
  });

  const anyPrompt = rolesInPlay[0] ? prompts[rolesInPlay[0]] : null;
  const ctx: SpecialistContext = {
    modelProvider,
    modelString: anyPrompt?.modelString ?? '',
    instructions: {
      DEV: prompts.DEV?.body ?? '',
      QA: prompts.QA?.body ?? '',
      PM: prompts.PM?.body ?? '',
      BA: prompts.BA?.body ?? '',
    },
    recorder,
    levers: {
      DEV: prompts.DEV?.levers,
      QA: prompts.QA?.levers,
      PM: prompts.PM?.levers,
      BA: prompts.BA?.levers,
    },
  };

  // One unit of work per (card, role) — the envelope's own granularity.
  const slices: Array<{ cardId: string; role: RoleKind; existing: ExistingLine[] }> = [];
  for (const cardId of edit.pinnedCardIds) {
    for (const role of rolesInPlay) {
      const rows = pinned.filter((p) => p.menuItemId === cardId && p.role === role);
      if (rows.length === 0) continue;
      slices.push({
        cardId,
        role,
        existing: rows.map((r) => ({
          description: r.title ?? '(no description)',
          hours: r.baseHours,
          provenance: r.provenance,
        })),
      });
    }
  }

  const proposed: ProposedRow[] = [];
  const reasoningParts: string[] = [];
  let done = 0;

  for (const slice of slices) {
    const card = allCards.find((c) => c.id === slice.cardId);
    if (!card) continue;
    const domainCard = toMenuItem(card);
    const requirement = requirementForCard(requirements, domainCard.requirementIds);

    await report(
      `Re-pricing ${slice.role} on ${card.title}`,
      // 15 to 85, so the bar has somewhere to go before and after the calls.
      15 + Math.round((done / Math.max(1, slices.length)) * 70),
    );

    if (!requirement) {
      // No requirement to price against — a hand-added card, or one whose run
      // predates the persisted requirement set. Refusing the slice is the
      // honest outcome: the alternative is the council inventing a requirement,
      // which is the habit this codebase removed.
      reasoningParts.push(
        `${card.title} (${slice.role}): left untouched — this card is not tied to a requirement from the run, so there is nothing to re-price it against.`,
      );
      // Its existing rows are carried through unchanged so the write does not
      // silently delete them.
      for (const row of pinned.filter(
        (p) => p.menuItemId === slice.cardId && p.role === slice.role,
      )) {
        proposed.push({
          menuItemId: slice.cardId,
          role: slice.role,
          title: row.title ?? '',
          baseHours: row.baseHours,
        });
      }
      done += 1;
      continue;
    }

    const outputs = await step(`reassess:${slice.cardId}:${slice.role}`, () =>
      runSpecialist(
        slice.role,
        {
          requirement,
          menuCardId: domainCard.taxonomyKey,
          riskFindings: [],
          complexityScore: estimate.complexityScore ?? 3,
          steer: edit.prompt,
          existing: slice.existing,
          ledgerContext,
        },
        ctx,
      ).then((o) => [o]),
    );

    const { rows, assumptions } = toProposedRows(outputs, slice.cardId);
    proposed.push(...rows);
    if (assumptions.length > 0) {
      reasoningParts.push(`${card.title} (${slice.role}): ${assumptions.join(' ')}`);
    }
    done += 1;
  }

  await report('Writing the change', 90);

  // Re-read rather than trusting the dispatched value: the job may have been
  // replayed, and the fingerprint recorded on the row is the one the person saw.
  const expectFingerprint =
    edit.fingerprint ??
    (await regionFingerprint(db, {
      cardIds: edit.pinnedCardIds,
      lineItemIds: edit.pinnedLineItemIds,
    }));

  const outcome = await applyRegionReplace(db, {
    editId,
    pinnedLineItemIds: edit.pinnedLineItemIds,
    pinnedCardIds: edit.pinnedCardIds,
    proposed,
    effective,
    expectFingerprint,
    reasoning: reasoningParts.join('\n') || null,
  });

  await report(outcome.kind === 'APPLIED' ? 'Applied' : 'Waiting on a decision', 100);

  return {
    outcome,
    cardsReassessed: new Set(slices.map((s) => s.cardId)).size,
    reasoning: reasoningParts.join('\n'),
  };
}
