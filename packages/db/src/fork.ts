/**
 * Forking an estimate — the deep copy half of lineage. AEH-236.
 *
 * A fork starts a new estimate WITH AN EXISTING ESTIMATE AS ITS REFERENCE
 * instead of from a blank SOW. Two kinds, one mechanism: a SUCCESSOR is what
 * you make when the client comes back with revised requirements, a BRANCH is
 * what you make to explore a different stack or a different route to the same
 * outcome. Which one it is changes how tightly the reconciliation pass holds to
 * the parent's numbers; it does not change a single line of the copy below.
 *
 * The load-bearing requirement, and the reason this is a copy rather than a
 * version chain: THE PARENT STAYS VALID. It is still good as a set of work
 * items — just not for this client, or not for this round. Both estimates
 * remain live and independently editable, and nothing here writes to the
 * parent. That rules out the single-active-plus-immutable-history pattern
 * PresetVersion and PromptVersion use, which assumes one current truth.
 *
 * ── Why this is not a loop ───────────────────────────────────────────────────
 *
 * A real estimate is ~50 cards and ~190 line items. Copying it a row at a time
 * inside a transaction is O(rows) round trips, which blows Prisma's 5s default
 * against a remote database and passes comfortably on a laptop — the exact
 * shape of bug that ships. Everything unbounded here is a single `createMany`,
 * so the query count is a small constant plus the number of SECTIONS and
 * SCENARIOS, both of which are naturally single digits.
 *
 * ── Why `carriedFromId` is enough to remap ───────────────────────────────────
 *
 * Copying a graph means every foreign key has to be translated from a parent id
 * to the fork's own. That normally needs ids generated up front, which Prisma
 * does not expose. Instead the carriage column doubles as the correlation key:
 * `createManyAndReturn` gives back both the new id and the `carriedFromId` that
 * produced it, so the map is exact and does not depend on rows coming back in
 * the order they went in. Sections and scenarios have no such column and are
 * created individually — bounded, and correct without a bet on ordering.
 */
import type { LineageKind, PrismaClient, Prisma } from './generated/client/index.js';

/** What a fork needs to know. */
export type ForkArgs = {
  parentId: string;
  /** The new estimate's title. Trimmed, and required. */
  title: string;
  kind: LineageKind;
  /**
   * What the person said this fork is for, verbatim.
   *
   * Optional here and load-bearing later: on a BRANCH whose brief has not
   * changed, this sentence is the ONLY thing that tells the reconciliation pass
   * anything at all.
   */
  steer: string | null;
  /** Who is forking. Becomes the new estimate's owner. */
  ownerId: string;
};

/** What the copy actually moved, so a caller can assert on it. */
export type ForkCounts = {
  sections: number;
  cards: number;
  lineItems: number;
  dependencies: number;
  statements: number;
  findings: number;
  scenarios: number;
  picks: number;
  /** Cards pointed at a preset the parent already promoted. */
  presetsCarried: number;
  /** Rows that came across marked as signed off on the parent. */
  verifiedRows: number;
};

export type ForkResult =
  | { kind: 'ok'; estimateId: string; counts: ForkCounts }
  | { kind: 'refused'; error: string };

const refuse = (error: string): ForkResult => ({ kind: 'refused', error });

/**
 * Above the promotion threshold in `writeback.ts`, so a card whose parent was
 * already promoted takes the strong-match path and VERSIONS that preset instead
 * of creating a near-duplicate of the same work.
 *
 * 1 rather than a nudge over the threshold because this is not a similarity
 * score that happened to come out high — it is the same card, copied. Anything
 * less would be inventing doubt about an identity we know for certain.
 */
const CARRIED_PROMOTION_MATCH = 1;

/**
 * Copy an estimate into a new one that records where it came from.
 *
 * Returns a refusal rather than throwing, because a thrown refusal is
 * legible in `next dev` and becomes React boilerplate the moment it is
 * deployed — and this one has real things to say ("that estimate is mid-run").
 */
export async function forkEstimate(db: PrismaClient, args: ForkArgs): Promise<ForkResult> {
  const title = args.title.trim();
  if (!title) return refuse('Give the fork a title before creating it.');

  const parent = await db.estimate.findUnique({
    where: { id: args.parentId },
    select: {
      id: true,
      sowText: true,
      complexityScore: true,
      configVersion: true,
      agentState: true,
      runStatus: true,
      ingestStatus: true,
      overheadRatesStale: true,
      projectName: true,
      pmCommunicationTaxPctOverride: true,
      baCommunicationTaxPctOverride: true,
      qaRegressionBufferPctOverride: true,
    },
  });
  if (!parent) return refuse('That estimate no longer exists.');

  // A copy taken mid-run gets half a ledger: the run deletes every card and
  // rebuilds, so what is on disk right now is a state that will never exist
  // again. Mid-ingest is the same problem one stage earlier — `sowText` is
  // still being written, so the fork would inherit a truncated brief.
  if (parent.runStatus === 'RUNNING') {
    return refuse(
      'This estimate is being estimated right now. A copy taken mid-run would capture half a ledger — wait for it to finish, then fork.',
    );
  }
  if (parent.ingestStatus === 'RUNNING') {
    return refuse(
      'This estimate is still reading its documents. Wait for that to finish, then fork.',
    );
  }

  const [sections, cards, dependencies, statements, findings, scenarios, lineLocks, statementLocks] =
    await Promise.all([
      db.estimateSection.findMany({
        where: { estimateId: parent.id },
        select: { id: true, title: true, order: true },
        orderBy: { order: 'asc' },
      }),
      db.menuItem.findMany({
        where: { estimateId: parent.id },
        select: {
          id: true,
          taxonomyKey: true,
          category: true,
          phase: true,
          sourcePresetId: true,
          matchScore: true,
          title: true,
          enabled: true,
          injected: true,
          sectionId: true,
          order: true,
          foundation: true,
          overhead: true,
          meta: true,
          lineItems: {
            select: {
              id: true,
              role: true,
              title: true,
              baseHours: true,
              taxedHours: true,
              notes: true,
              provenance: true,
              touchesFrontend: true,
              touchesBackend: true,
              meta: true,
            },
          },
        },
        orderBy: { order: 'asc' },
      }),
      db.menuItemDependency.findMany({
        where: { estimateId: parent.id },
        select: { dependentId: true, prerequisiteId: true, note: true, source: true },
      }),
      db.estimateStatement.findMany({
        where: { estimateId: parent.id },
        select: { id: true, kind: true, text: true, order: true, provenance: true },
        orderBy: { order: 'asc' },
      }),
      db.hiddenWorkFinding.findMany({
        where: { estimateId: parent.id },
        select: {
          riskFlag: true,
          known: true,
          claim: true,
          citation: true,
          requirementId: true,
          taxonomyKey: true,
          outcome: true,
          menuItemId: true,
          dismissReason: true,
          dismissedById: true,
          dismissedAt: true,
        },
      }),
      db.scopeScenario.findMany({
        where: { estimateId: parent.id },
        select: { id: true, name: true, picks: { select: { menuItemId: true } } },
      }),
      db.ledgerLock.findMany({
        where: { estimateId: parent.id },
        select: { lineItemId: true },
      }),
      db.statementLock.findMany({
        where: { estimateId: parent.id },
        select: { statementId: true },
      }),
    ]);

  // Cards the parent has already promoted into the preset library. Pointing the
  // copy at the same preset with a certain match makes `promoteMenuItemsToPresets`
  // take its strong-match path, so finalising the fork writes a NEW VERSION of
  // that preset rather than a second preset describing the same work. Without
  // this, two branches of one ancestor each fill the library with a near-
  // duplicate and the Archivist then has to guess between them.
  const promotions = await db.presetVersion.findMany({
    where: { sourceEstimateId: parent.id, sourceMenuItemId: { in: cards.map((c) => c.id) } },
    select: { presetId: true, sourceMenuItemId: true },
  });
  const promotedAs = new Map<string, string>();
  for (const p of promotions) {
    if (p.sourceMenuItemId) promotedAs.set(p.sourceMenuItemId, p.presetId);
  }

  const lockedLines = new Set(lineLocks.map((l) => l.lineItemId));
  const lockedStatements = new Set(statementLocks.map((l) => l.statementId));

  const counts: ForkCounts = {
    sections: sections.length,
    cards: cards.length,
    lineItems: cards.reduce((n, c) => n + c.lineItems.length, 0),
    dependencies: dependencies.length,
    statements: statements.length,
    findings: findings.length,
    scenarios: scenarios.length,
    picks: scenarios.reduce((n, s) => n + s.picks.length, 0),
    presetsCarried: 0,
    verifiedRows: 0,
  };

  const estimateId = await db.$transaction(
    async (tx) => {
      const fork = await tx.estimate.create({
        data: {
          title,
          // The parent's brief, verbatim. Any revised material the person
          // attached is APPENDED to this by the ingest, which already joins
          // `est.sowText` with what it parsed — a change request only means
          // something read against the document it changes.
          sowText: parent.sowText,
          // A copy of an approved estimate is not itself approved.
          status: 'DRAFT',
          // Pinned to the config the copied hours were actually costed under,
          // and carried TOGETHER with the three buffer overrides below. Copying
          // taxed hours without the rates that produced them would make every
          // number on the fork a claim its own configuration contradicts.
          configVersion: parent.configVersion,
          pmCommunicationTaxPctOverride: parent.pmCommunicationTaxPctOverride,
          baCommunicationTaxPctOverride: parent.baCommunicationTaxPctOverride,
          qaRegressionBufferPctOverride: parent.qaRegressionBufferPctOverride,
          overheadRatesStale: parent.overheadRatesStale,
          complexityScore: parent.complexityScore,
          // Carried so the Oracle and the edit engine keep working on the fork
          // from the moment it exists: both read `librarianOutput` for the
          // requirement set, and a fork with none would be uneditable until it
          // had been reconciled.
          agentState: parent.agentState as Prisma.InputJsonValue,
          ownerId: args.ownerId,
          // Deliberately NOT carried: a new round is a new deadline, and
          // inheriting the parent's would make a brand-new fork read as overdue.
          custodianId: null,
          dueAt: null,
          parentId: parent.id,
          lineageKind: args.kind,
          forkPrompt: args.steer?.trim() || null,
          // Inherited verbatim, null included. A null here is not a gap to fill
          // in: `projectNameOf` resolves it to the root's own title, so a family
          // reads sensibly from the moment it exists without anybody naming it,
          // and only an explicit rename ever makes it non-null.
          projectName: parent.projectName,
        },
        select: { id: true },
      });

      // Sections: created one at a time because they have no carriage column to
      // correlate on, and because there are a handful of them. This is bounded
      // by how many groupings a person made, not by the size of the estimate.
      const sectionMap = new Map<string, string>();
      for (const s of sections) {
        const made = await tx.estimateSection.create({
          data: { estimateId: fork.id, title: s.title, order: s.order },
          select: { id: true },
        });
        sectionMap.set(s.id, made.id);
      }

      let cardMap = new Map<string, string>();
      if (cards.length > 0) {
        const made = await tx.menuItem.createManyAndReturn({
          data: cards.map((c) => {
            const carriedPreset = promotedAs.get(c.id);
            if (carriedPreset) counts.presetsCarried += 1;
            return {
              estimateId: fork.id,
              taxonomyKey: c.taxonomyKey,
              category: c.category,
              phase: c.phase,
              // Only overwritten where the parent actually promoted this card;
              // otherwise the Archivist's own match is left alone.
              sourcePresetId: carriedPreset ?? c.sourcePresetId,
              matchScore: carriedPreset ? CARRIED_PROMOTION_MATCH : c.matchScore,
              title: c.title,
              enabled: c.enabled,
              injected: c.injected,
              sectionId: c.sectionId ? (sectionMap.get(c.sectionId) ?? null) : null,
              order: c.order,
              foundation: c.foundation,
              overhead: c.overhead,
              meta: c.meta as Prisma.InputJsonValue,
              carriedFromId: c.id,
              carriedIntact: true,
            };
          }),
          select: { id: true, carriedFromId: true },
        });
        cardMap = new Map(
          made.flatMap((m) => (m.carriedFromId ? [[m.carriedFromId, m.id] as const] : [])),
        );
      }

      const lineRows = cards.flatMap((c) => {
        const newCardId = cardMap.get(c.id);
        if (!newCardId) return [];
        return c.lineItems.map((li) => {
          const verified = lockedLines.has(li.id);
          if (verified) counts.verifiedRows += 1;
          return {
            menuItemId: newCardId,
            role: li.role,
            title: li.title,
            baseHours: li.baseHours,
            taxedHours: li.taxedHours,
            notes: li.notes,
            provenance: li.provenance,
            touchesFrontend: li.touchesFrontend,
            touchesBackend: li.touchesBackend,
            meta: li.meta as Prisma.InputJsonValue,
            carriedFromId: li.id,
            carriedIntact: true,
            // The lock does NOT carry — see RoleLineItem.carriedVerified. What
            // carries is that somebody had signed these hours off, which is a
            // fact about the parent and stays true of it.
            carriedVerified: verified,
          };
        });
      });
      if (lineRows.length > 0) await tx.roleLineItem.createMany({ data: lineRows });

      const depRows = dependencies.flatMap((d) => {
        const dependentId = cardMap.get(d.dependentId);
        const prerequisiteId = cardMap.get(d.prerequisiteId);
        return dependentId && prerequisiteId
          ? [{ estimateId: fork.id, dependentId, prerequisiteId, note: d.note, source: d.source }]
          : [];
      });
      if (depRows.length > 0) await tx.menuItemDependency.createMany({ data: depRows });

      if (statements.length > 0) {
        await tx.estimateStatement.createMany({
          data: statements.map((st) => ({
            estimateId: fork.id,
            kind: st.kind,
            text: st.text,
            order: st.order,
            provenance: st.provenance,
            carriedFromId: st.id,
            carriedIntact: true,
            carriedVerified: lockedStatements.has(st.id),
          })),
        });
      }

      // The risk register comes across intact, `outcome` included. A finding
      // somebody dismissed with a reason on the parent was dismissed on its
      // merits, and resetting it to OPEN would make the finalise gate demand an
      // answer to a question that has already been answered.
      //
      // `menuItemId` is remapped, not copied. It is nullable and set only on a
      // costed finding, so a fork that copied it verbatim would look correct on
      // any estimate whose findings were all still open — and would silently
      // point at the PARENT's card everywhere else.
      if (findings.length > 0) {
        await tx.hiddenWorkFinding.createMany({
          data: findings.map((f) => ({
            estimateId: fork.id,
            riskFlag: f.riskFlag,
            known: f.known,
            claim: f.claim,
            citation: f.citation,
            requirementId: f.requirementId,
            taxonomyKey: f.taxonomyKey,
            outcome: f.outcome,
            menuItemId: f.menuItemId ? (cardMap.get(f.menuItemId) ?? null) : null,
            dismissReason: f.dismissReason,
            dismissedById: f.dismissedById,
            dismissedAt: f.dismissedAt,
          })),
        });
      }

      // Scenarios take the FORKER as author, not the parent's. They are the one
      // who owns these cuts now, and `createdById` cascades on user delete —
      // pointing at the original author would take the fork's scenarios with
      // them if that person were ever removed.
      const pickRows: { scenarioId: string; menuItemId: string }[] = [];
      for (const sc of scenarios) {
        const made = await tx.scopeScenario.create({
          data: { estimateId: fork.id, name: sc.name, createdById: args.ownerId },
          select: { id: true },
        });
        for (const pick of sc.picks) {
          const menuItemId = cardMap.get(pick.menuItemId);
          if (menuItemId) pickRows.push({ scenarioId: made.id, menuItemId });
        }
      }
      if (pickRows.length > 0) await tx.scopeScenarioPick.createMany({ data: pickRows });

      return fork.id;
    },
    // Generous for the same reason the pipeline's persist is: several sequential
    // statements over a remote database push past Prisma's 5s default even when
    // none of them is per-row.
    { maxWait: 15_000, timeout: 120_000 },
  );

  return { kind: 'ok', estimateId, counts };
}
