import {
  applyRegionReplace,
  applyRestructure,
  applyStatementRevision,
  regionFingerprint,
  snapshotRegion,
  statementFingerprint,
  toMenuItem,
  type ApplyOutcome,
  type Prisma,
  type PrismaClient,
  type ProposedRow,
  type RoleKind,
  type StatementApplyOutcome,
  type StatementKind,
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
import { runCurator, type CuratableCard } from './curator';
import { runScribe, type ScribableStatement } from './scribe';
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
  outcome:
    | ApplyOutcome
    | StatementApplyOutcome
    | { kind: 'RESTRUCTURED'; cardIds: string[] };
  /** Cards the council was asked to re-price. Zero on a statement revision. */
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

/**
 * What the wide read selects. Named so the re-cost's second read — the cards a
 * reshape created, which `allCards` predates — cannot drift from it.
 */
const WIDE_READ_SELECT = {
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
} as const;

type WideReadCard = Prisma.MenuItemGetPayload<{ select: typeof WIDE_READ_SELECT }>;

/**
 * What a pinned row is read as, and it is the WHOLE row for a reason.
 *
 * The carry-through path below re-pushes rows the council could not price, and
 * it claimed to pass them through unchanged. Read through a five-column
 * select, it did not: `notes`, `meta`, `touchesFrontend` and `touchesBackend`
 * were never fetched, so a carried row lost the requirement id, the complexity
 * tier, `aiAssistApplied`, `dependsOn` and `anchorPresetIds` that every reader
 * renders, lost the DEV frontend/backend split, and had a hand-typed row's
 * HUMAN provenance restamped as STEERED. "Carried through unchanged" has to
 * mean unchanged.
 */
const PINNED_SELECT = {
  id: true,
  menuItemId: true,
  role: true,
  title: true,
  baseHours: true,
  notes: true,
  provenance: true,
  touchesFrontend: true,
  touchesBackend: true,
  meta: true,
} as const;

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
 * The wide read: every card on the estimate, and it rendered for a prompt.
 *
 * One function because both halves of this engine need the same thing — a
 * council re-pricing a card and a Scribe rewriting an assumption are both
 * capable of contradicting work they cannot see. `allCards` is returned
 * alongside the rendering because the re-cost also needs the rows themselves.
 */
async function loadWideRead(
  db: PrismaClient,
  estimateId: string,
  envelopeCardIds: string[],
): Promise<{ allCards: WideReadCard[]; ledgerContext: string }> {
  const allCards = await db.menuItem.findMany({
    where: { estimateId },
    orderBy: { order: 'asc' },
    select: WIDE_READ_SELECT,
  });

  const lockedRows = await db.ledgerLock.findMany({
    where: { estimateId },
    select: { lineItemId: true },
  });
  const lockedIds = new Set(lockedRows.map((l) => l.lineItemId));
  const envelopeCards = new Set(envelopeCardIds);

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

  return { allCards, ledgerContext };
}

/**
 * Rewrite the statements in an envelope. AEH-238.
 *
 * The narrow write, on the axis that has no roles. Nothing here can reach an
 * hour or a card: `applyStatementRevision` writes to `pinnedStatementIds` and
 * the Scribe is only ever handed wording.
 *
 * One model call, not one per statement. A person ticking three assumptions and
 * saying "these three overlap" is asking about them TOGETHER — three
 * independent calls could not merge them, and would each be free to write the
 * same sentence. That is the opposite of the hours side, where the envelope's
 * axes are the council's granularity and a card is priced alone.
 */
async function runStatementEdit(
  editId: string,
  edit: {
    estimateId: string;
    prompt: string;
    pinnedStatementIds: string[];
    pinnedCardIds: string[];
    fingerprint: Date | null;
  },
  deps: LedgerEditDeps,
  report: (stage: string, pct: number) => Promise<void>,
): Promise<LedgerEditResult> {
  const { db, modelProvider } = deps;
  const step = deps.step ?? (<T>(_id: string, fn: () => Promise<T>) => fn());

  const pinned = new Set(edit.pinnedStatementIds);

  // Every statement on the estimate, not just the ticked ones. The Scribe has
  // to be able to merge a selected line into an unselected neighbour and to
  // avoid repeating what a locked one already says, and it can do neither with
  // a list it cannot see. The envelope is expressed by MARKING them.
  const all = await db.estimateStatement.findMany({
    where: { estimateId: edit.estimateId },
    orderBy: [{ kind: 'asc' }, { order: 'asc' }],
    select: { id: true, kind: true, text: true },
  });
  const locks = await db.statementLock.findMany({
    where: { estimateId: edit.estimateId },
    select: { statementId: true },
  });
  const lockedIds = new Set(locks.map((l) => l.statementId));

  // Which list this edit is about — the kind the selection lives in. Mixing the
  // narrative and the assumptions in one envelope is not offered: they are two
  // documents with different jobs, and one instruction about both would be
  // exactly the vague boundary this feature exists to replace.
  const kind: StatementKind =
    all.find((s) => pinned.has(s.id))?.kind ?? 'ASSUMPTION';
  const inKind = all.filter((s) => s.kind === kind);

  const statements: ScribableStatement[] = inKind.map((s) => ({
    statementId: s.id,
    text: s.text,
    inEnvelope: pinned.has(s.id),
    locked: lockedIds.has(s.id),
  }));

  const { ledgerContext } = await loadWideRead(db, edit.estimateId, edit.pinnedCardIds);

  await report('Loading the prompt', 10);
  const prompt = await loadActivePrompt(db, 'SCRIBE');

  const recorder = createUsageRecorder({
    db,
    estimateId: edit.estimateId,
    ledgerEditId: editId,
  });

  await report(`Rewriting the ${kind === 'NARRATIVE' ? 'narrative' : 'assumptions'}`, 40);

  const scribed = await step('scribe', () =>
    runScribe(
      {
        kindLabel: kind === 'NARRATIVE' ? 'narrative' : 'assumptions',
        statements,
        instruction: edit.prompt,
        ledgerContext,
      },
      {
        modelProvider,
        modelString: prompt.modelString,
        instructions: prompt.body,
        recorder,
        levers: prompt.levers,
      },
    ),
  );

  await report('Writing the change', 90);

  // Re-read rather than trusting the dispatched value, for the reason the hours
  // path gives: the job may have been replayed.
  const expectFingerprint =
    edit.fingerprint ?? (await statementFingerprint(db, edit.pinnedStatementIds));

  const outcome = await applyStatementRevision(db, {
    editId,
    pinnedStatementIds: edit.pinnedStatementIds,
    proposed: scribed.lines,
    expectFingerprint,
    reasoning: scribed.notes,
  });

  // Three endings, not two. A refusal — locked mid-run, or nothing to write —
  // is not a decision waiting on anybody; the applier has already recorded why
  // on the row, and telling the person to decide about it would be a lie.
  await report(
    outcome.kind === 'APPLIED'
      ? 'Applied'
      : outcome.kind === 'CONFLICT'
        ? 'Waiting on a decision'
        : 'Refused',
    100,
  );

  return { outcome, cardsReassessed: 0, reasoning: scribed.notes ?? '' };
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
      mode: true,
      roles: true,
      pinnedLineItemIds: true,
      pinnedCardIds: true,
      pinnedStatementIds: true,
      fingerprint: true,
    },
  });

  await report('Reading the estimate', 5);

  // The statement axis is its own write, and it branches here rather than
  // further down so none of the line-item reads below can run on its behalf.
  // Nothing in the rest of this function is reachable with an empty
  // `pinnedLineItemIds`, and a statement edit has exactly that.
  if (edit.mode === 'REVISE_STATEMENTS') {
    return runStatementEdit(editId, edit, deps, report);
  }

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
    select: PINNED_SELECT,
  });

  const { allCards, ledgerContext } = await loadWideRead(db, edit.estimateId, edit.pinnedCardIds);

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

  // ── Phase one: reshape, when that is what was asked for ────────────────────
  //
  // The Curator decides which cards should exist and which lines belong to
  // each; `applyRestructure` moves them. The lines keep their ids, so the write
  // set pinned at dispatch is still exactly right — only the grouping changes.
  //
  // RESTRUCTURE_KEEP_HOURS stops here. RESTRUCTURE falls through to the re-cost
  // below, because cutting a module in two re-conceives the work: the hours
  // have to move, and they move by being re-priced against the requirement
  // rather than by the reshape guessing at them.
  let cardIdsAfterRestructure = edit.pinnedCardIds;
  /**
   * The region's fingerprint as the reshape left it.
   *
   * `undefined` means NO RESHAPE HAPPENED, and that is a different thing from
   * `null`, which is what a region with no rows legitimately fingerprints to.
   *
   * Conflating the two is not currently reachable — a reshape is skipped only
   * when the Curator returns no cards, which only happens when the envelope
   * has no lines on the pinned cards, and that case is refused as an empty
   * proposal before any fingerprint is compared. The distinction is here
   * because the fall-through it guards is one line away from being reachable
   * again, and a null baseline against a live region parks every such edit as
   * a conflict with nothing.
   */
  let reshapeFingerprint: Date | null | undefined = undefined;
  const restructureNotes: string[] = [];

  if (edit.mode !== 'REPRICE') {
    // Captured before the Curator runs, not after. A snapshot taken once the
    // reshape has landed records the rows sitting on the cards the reshape
    // just created and calls that the "before" state — which is what the
    // KEEP_HOURS path below reports as `rowsBefore` and `hoursBefore`.
    const beforeReshape = await snapshotRegion(db, edit.pinnedLineItemIds);

    await report('Working out the new shape', 20);
    const curatorPrompt = await loadActivePrompt(db, 'CURATOR');
    const curatable: CuratableCard[] = [];
    for (const cardId of edit.pinnedCardIds) {
      const card = allCards.find((c) => c.id === cardId);
      if (!card) continue;
      curatable.push({
        menuItemId: card.id,
        title: card.title,
        taxonomyKey: card.taxonomyKey,
        category: card.category,
        phase: card.phase,
        // Only the lines in the envelope may move. A card's other roles stay
        // where they are, which is what keeps a DEV-scoped split from silently
        // dragging QA around with it.
        lines: card.lineItems
          .filter((li) => edit.pinnedLineItemIds.includes(li.id))
          .map((li) => ({
            lineItemId: li.id,
            role: li.role,
            description: li.title ?? '(no description)',
            hours: li.baseHours,
          })),
      });
    }

    const curated = await step('curate', () =>
      runCurator(
        { cards: curatable, instruction: edit.prompt, ledgerContext },
        {
          modelProvider,
          modelString: curatorPrompt.modelString,
          instructions: curatorPrompt.body,
          recorder,
          levers: curatorPrompt.levers,
        },
      ),
    );

    if (curated.notes) restructureNotes.push(curated.notes);

    if (curated.cards.length > 0) {
      await report('Reshaping the cards', 35);
      // ONE step, and this is load-bearing rather than tidy.
      //
      // Inngest replays the function body from the top at every step boundary.
      // Left outside a step, this reshape re-ran on each invocation: it
      // re-created every card whose `reuseMenuItemId` was null, giving them
      // FRESH cuids, and deleted the previous invocation's cards as "emptied"
      // — because `pinnedCardIds` had been overwritten, so they now looked
      // like sources. The re-cost steps below are keyed `reassess:<cardId>:
      // <role>`, so a new cuid every time meant a step id that never matched a
      // memoized result: a paid model call, a replay, and round again until the
      // step cap killed the job with the ledger already reshaped.
      //
      // Memoizing the ids is what breaks that. The `pinnedCardIds` write is
      // inside the same step because it is part of the same fact: what this
      // reshape decided the cards are.
      const result = await step('reshape', async () => {
        const applied = await applyRestructure(db, {
          estimateId: edit.estimateId,
          sourceCardIds: edit.pinnedCardIds,
          cards: curated.cards,
        });
        await db.ledgerEdit.update({
          where: { id: editId },
          data: { pinnedCardIds: applied.cardIds },
        });
        // Captured HERE, inside the memoized step, and this is the whole
        // concurrency answer for a reshape. The fingerprint the job was
        // dispatched with is guaranteed stale — the reshape has just written to
        // these cards — but the fix is a NEW baseline, not switching the check
        // off. Computed on a replay instead, it would take a colleague's
        // meanwhile-edit as the baseline and hide exactly the conflict it is
        // meant to catch.
        //
        // An ISO string, not a Date: a memoized step result comes back through
        // JSON, so a Date would arrive as a string on the second invocation and
        // compare unequal to itself.
        const after = await regionFingerprint(db, {
          cardIds: applied.cardIds,
          lineItemIds: edit.pinnedLineItemIds,
        });
        return { ...applied, fingerprintAfter: after?.toISOString() ?? null };
      });
      cardIdsAfterRestructure = result.cardIds;
      reshapeFingerprint = result.fingerprintAfter ? new Date(result.fingerprintAfter) : null;
      restructureNotes.push(
        `Reshaped into ${result.cardIds.length} card${result.cardIds.length === 1 ? '' : 's'}${
          result.removedCardIds.length
            ? `, removing ${result.removedCardIds.length} that ended up empty`
            : ''
        }.`,
      );
    }

    if (edit.mode === 'RESTRUCTURE_KEEP_HOURS') {
      // The hours were carried, not re-opened. Nothing to price, so the edit
      // is complete — and the snapshot still records what the region looked
      // like. Before and after are the same figures on purpose: this mode
      // moved rows between cards without touching a single number.
      await db.ledgerEdit.update({
        where: { id: editId },
        data: {
          status: 'APPLIED',
          stage: 'Reshaped',
          pct: 100,
          appliedAt: new Date(),
          reasoning: restructureNotes.join(' ') || null,
          beforeSnapshot: beforeReshape as never,
          rowsBefore: beforeReshape.rows.length,
          rowsAfter: beforeReshape.rows.length,
          hoursBefore: beforeReshape.baseHours,
          hoursAfter: beforeReshape.baseHours,
        },
      });
      await report('Reshaped', 100);
      return {
        outcome: { kind: 'RESTRUCTURED', cardIds: cardIdsAfterRestructure },
        cardsReassessed: 0,
        reasoning: restructureNotes.join(' '),
      };
    }
  }

  // Re-read after a reshape: the rows kept their ids but changed cards, so the
  // grouping below has to come from the database rather than from `pinned`.
  const grouped =
    edit.mode === 'REPRICE'
      ? pinned
      : await db.roleLineItem.findMany({
          where: { id: { in: edit.pinnedLineItemIds } },
          select: PINNED_SELECT,
        });

  // One unit of work per (card, role) — the envelope's own granularity.
  const slices: Array<{ cardId: string; role: RoleKind; existing: ExistingLine[] }> = [];
  for (const cardId of cardIdsAfterRestructure) {
    for (const role of rolesInPlay) {
      const rows = grouped.filter((p) => p.menuItemId === cardId && p.role === role);
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

  // A reshape creates cards `allCards` predates, so their metadata is read back
  // rather than looked up in the pre-restructure snapshot.
  const cardsNow =
    edit.mode === 'REPRICE'
      ? allCards
      : await db.menuItem.findMany({
          where: { id: { in: cardIdsAfterRestructure } },
          select: WIDE_READ_SELECT,
        });

  for (const slice of slices) {
    const card = cardsNow.find((c) => c.id === slice.cardId);
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
      // silently delete them — and UNCHANGED means every column, not just the
      // hours. See `PINNED_SELECT`: read through a narrower select this path
      // quietly stripped the envelope meta, the notes and the frontend/backend
      // split off every row it claimed to be preserving.
      for (const row of grouped.filter(
        (p) => p.menuItemId === slice.cardId && p.role === slice.role,
      )) {
        proposed.push({
          menuItemId: slice.cardId,
          role: slice.role,
          title: row.title ?? '',
          baseHours: row.baseHours,
          notes: row.notes,
          touchesFrontend: row.touchesFrontend,
          touchesBackend: row.touchesBackend,
          // A carried row keeps the provenance it had: it was not re-priced,
          // so calling it STEERED would record a decision nobody made.
          provenance: row.provenance,
          ...(row.meta === null ? {} : { meta: row.meta as never }),
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

  // Which baseline the write is checked against.
  //
  // A reshape that actually happened compares the baseline captured
  // immediately after it, inside the memoized step above: it cannot use the
  // dispatched fingerprint, having written to these cards itself. Everything
  // else — a re-price, and a reshape the Curator declined — compares the
  // fingerprint the person's screen was drawn from, so anything that landed
  // since parks for a decision.
  //
  // Both stay CHECKED. An earlier version passed `overwriteConflict: true` for
  // a reshape to get past the stale value, which disabled the comparison
  // entirely: a colleague typing hours into an unrelated row on the same card
  // while the model calls ran had that row deleted and replaced with no
  // warning and no chance to approve — the one protection this feature is
  // built around. It also stamped `overwroteConflict` on every reshape, so the
  // audit claimed a conflict nobody had.
  const expectFingerprint =
    reshapeFingerprint !== undefined
      ? reshapeFingerprint
      : (edit.fingerprint ??
        (await regionFingerprint(db, {
          cardIds: cardIdsAfterRestructure,
          lineItemIds: edit.pinnedLineItemIds,
        })));

  const outcome = await applyRegionReplace(db, {
    editId,
    pinnedLineItemIds: edit.pinnedLineItemIds,
    pinnedCardIds: cardIdsAfterRestructure,
    proposed,
    effective,
    expectFingerprint,
    reasoning: [...restructureNotes, ...reasoningParts].join('\n') || null,
  });

  // Three endings, not two. A refusal — locked mid-run, or nothing to write —
  // is not a decision waiting on anybody; the applier has already recorded why
  // on the row, and telling the person to decide about it would be a lie.
  await report(
    outcome.kind === 'APPLIED'
      ? 'Applied'
      : outcome.kind === 'CONFLICT'
        ? 'Waiting on a decision'
        : 'Refused',
    100,
  );

  return {
    outcome,
    cardsReassessed: new Set(slices.map((s) => s.cardId)).size,
    reasoning: [...restructureNotes, ...reasoningParts].join('\n'),
  };
}
