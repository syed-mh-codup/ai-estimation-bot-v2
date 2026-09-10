/**
 * Reconciling a forked estimate against what changed. AEH-236.
 *
 * The pass that makes lineage more than a copy. A fork arrives holding its
 * parent's whole ledger; this decides what has to move for it to describe the
 * job it is actually for, and hands back a per-card diff a person accepts or
 * rejects.
 *
 * ── It never writes to the ledger ────────────────────────────────────────────
 *
 * `PROPOSED` is its success state. Everything it decides lands as
 * `ReconciliationProposal` rows and nothing else, which is what lets a whole
 * pass be thrown away for the cost of a button. The applier is separate.
 *
 * ── Why it is not a fifth LedgerEditMode ─────────────────────────────────────
 *
 * The steered edit engine CONSERVES LINES — the Curator is told every existing
 * line must appear exactly once across its output cards, so it partitions and
 * re-prices but cannot invent work. A reconciliation has to ADD cards for
 * requirements that arrived in a document last week and REMOVE cards the brief
 * dropped. That is a different contract, not a different mode.
 *
 * ── Scope comes from TRIAGE, never from the fork kind ────────────────────────
 *
 * The first draft of this drove the loop off the requirement diff: re-read the
 * brief, find what changed, price that. It would have shipped broken. A stack
 * change carries the SAME brief — the system must still do the same things,
 * only the way it is built changes — so the diff is empty, the loop never
 * executes, and the pass reports success having proposed nothing. Silently.
 *
 * The failure there is control flow, not signal: a steer reading "rebuild on
 * WordPress with plugins" is entirely sufficient, it was simply never read,
 * because a loop over an empty array makes no model call however good the prose
 * is. So one RECONCILER call reads the steer, the diff and the ledger together
 * and returns the cards in play. It also means a narrow branch stays narrow —
 * "swap the payment provider" is a branch too, and paying for fifty cards there
 * would be waste.
 */
import {
  LibrarianOutputSchema,
  type Requirement,
  type RoleKind,
  type SpecialistOutput,
  type TaxPercents,
  taxedHoursFor,
} from '@repo/shared';
import type { PrismaClient } from '@repo/db';
import type { IModelProvider } from '@repo/providers';
import { z } from 'zod';

import { chatJSON } from './llm-json';
import { renderLedgerContext } from './ledger-edit';
import { runLibrarian } from './librarian';
import { runSpecialist } from './specialist';
import { loadActivePrompt } from './run-estimate';
import { createUsageRecorder } from './usage-recorder';
import { CALL_TIMEOUTS } from './model-call';

const ROLES = ['DEV', 'QA', 'PM', 'BA'] as const;

/** What the Reconciler decides. Scope only — never an hour. */
const ReconcilerOutputSchema = z.object({
  repriceCardIds: z.array(z.string()).default([]),
  newRequirementIds: z.array(z.string()).default([]),
  removeCardIds: z.array(z.string()).default([]),
  reasoning: z.string().default(''),
});
export type ReconcilerOutput = z.infer<typeof ReconcilerOutputSchema>;

/** One card's worth of proposed change, before it is written. */
export type ProposalDraft = {
  menuItemId: string | null;
  kind: 'ADD' | 'MODIFY' | 'REMOVE';
  title: string;
  supersedesMenuItemIds: string[];
  rationale: string;
  payload: { rows: ProposedReconcileRow[] };
  hoursBefore: number | null;
  hoursAfter: number | null;
};

export type ProposedReconcileRow = {
  role: RoleKind;
  title: string;
  baseHours: number;
  taxedHours: number;
  notes: string | null;
  touchesFrontend: boolean;
  touchesBackend: boolean;
};

type StepRunner = <T>(id: string, fn: () => Promise<T>) => Promise<T>;

export type ReconcileDeps = {
  db: PrismaClient;
  modelProvider: IModelProvider;
  /** The buffers in force for THIS estimate's pinned config version. */
  effective: TaxPercents;
  step?: StepRunner;
  onProgress?: (p: { stage: string; pct: number }) => Promise<void>;
};

export type ReconcileResult = {
  reconciliationId: string;
  proposals: number;
  added: number;
  modified: number;
  removed: number;
};

/**
 * Run a reconciliation to the point of a proposal.
 *
 * Each unit of work is its own step, so no single one can outgrow the platform's
 * 300s per-step ceiling however large the estimate — the same shape the run and
 * the steered edit already use.
 */
export async function runReconciliation(
  reconciliationId: string,
  deps: ReconcileDeps,
): Promise<ReconcileResult> {
  const { db, modelProvider, effective } = deps;
  const step: StepRunner = deps.step ?? ((_id, fn) => fn());
  // Progress lives on the reconciliation row, not the estimate: an estimate can
  // legitimately have never run AND be reconciling, so borrowing `runStatus`
  // would make the two indistinguishable.
  const report = async (stage: string, pct: number): Promise<void> => {
    await db.estimateReconciliation.update({
      where: { id: reconciliationId },
      data: { stage, pct, status: 'RUNNING' },
    });
    if (deps.onProgress) await deps.onProgress({ stage, pct });
  };

  const rec = await db.estimateReconciliation.findUniqueOrThrow({
    where: { id: reconciliationId },
    select: { estimateId: true, prompt: true, posture: true, actorId: true },
  });

  const estimate = await db.estimate.findUniqueOrThrow({
    where: { id: rec.estimateId },
    select: {
      sowText: true,
      agentState: true,
      complexityScore: true,
      parent: { select: { sowText: true } },
    },
  });

  await report('Reading the estimate', 5);

  const cards = await db.menuItem.findMany({
    where: { estimateId: rec.estimateId },
    select: {
      id: true,
      title: true,
      enabled: true,
      taxonomyKey: true,
      meta: true,
      lineItems: { select: { role: true, baseHours: true } },
    },
    orderBy: { order: 'asc' },
  });

  const parsed = LibrarianOutputSchema.safeParse(
    (estimate.agentState as { librarianOutput?: unknown } | null)?.librarianOutput,
  );
  const priorRequirements: Requirement[] = parsed.success ? parsed.data.requirements : [];

  // ── 1. Read only what the brief actually gained ───────────────────────────
  //
  // Three cases, and the middle one is the whole point.
  //
  // UNCHANGED — a branch usually attaches no documents, so `sowText` is
  // byte-identical to the parent's. Re-reading is not merely wasted spend: the
  // Librarian is not deterministic, so it would manufacture a requirement diff
  // out of nothing and send the pass chasing changes nobody made.
  //
  // EXTENDED — the fork kept the parent's brief and appended to it, which is
  // what the fork route does for every successor with documents attached. Only
  // the tail is new, so only the tail is read.
  //
  // This case is why the pass failed in production on its first real run. A
  // fork whose brief was 480,951 characters against a parent's 460,444 — a
  // twenty-kilobyte change — re-read the whole 480KB, which is around 120,000
  // tokens, and the call was abandoned after exhausting its 240-second budget.
  // Nothing about that is fixable with a longer timeout: the platform's
  // per-step ceiling is 300 seconds, so there is nowhere left to go. Re-reading
  // an entire brief to find what was appended to it is simply the wrong
  // operation. See AEH-367, which is about making the documents separable so
  // this stops being a string comparison at all.
  //
  // REPLACED — the brief was rewritten rather than added to, so there is no
  // shortcut and the whole thing is read.
  const parentSow = estimate.parent?.sowText ?? '';
  const unchanged = parentSow.length > 0 && estimate.sowText === parentSow;
  const extended = parentSow.length > 0 && !unchanged && estimate.sowText.startsWith(parentSow);
  const toRead = extended ? estimate.sowText.slice(parentSow.length) : estimate.sowText;
  const sowChanged = !unchanged;

  let currentRequirements = priorRequirements;
  if (sowChanged && toRead.trim().length > 0) {
    await report(
      extended ? 'Reading the revised material' : 'Re-reading the brief',
      15,
    );
    const libP = await loadActivePrompt(db, 'LIBRARIAN');
    const recorder = createUsageRecorder({ db, estimateId: rec.estimateId });
    const lib = await step('librarian', () =>
      runLibrarian(toRead, [], {
        modelProvider,
        modelString: libP.modelString,
        instructions: libP.body,
        recorder,
        levers: libP.levers,
      }),
    );
    // On an EXTENDED brief the Librarian saw only the new material, so what it
    // returns is what was ADDED — the prior requirements are still true and are
    // kept. Its ids restart at REQ-001 every call, so they are renumbered to
    // continue past the existing set; without that, a new requirement would
    // silently claim the id of an old one and the Reconciler would price the
    // wrong work.
    currentRequirements = extended
      ? [
          ...priorRequirements,
          ...lib.requirements.map((r, i) => ({
            ...r,
            id: `REQ-${String(priorRequirements.length + i + 1).padStart(3, '0')}`,
          })),
        ]
      : lib.requirements;
  }

  // ── 2. Triage: what is in play ─────────────────────────────────────────────
  await report('Working out what has to change', 30);
  const triage = await step('triage', () =>
    runReconciler(
      {
        prompt: rec.prompt,
        posture: rec.posture,
        cards,
        priorRequirements,
        currentRequirements,
        sowChanged,
      },
      { db, modelProvider, estimateId: rec.estimateId },
    ),
  );

  const cardById = new Map(cards.map((c) => [c.id, c]));
  const reqById = new Map(currentRequirements.map((r) => [r.id, r]));
  // Ids the model invented are dropped rather than trusted. A hallucinated card
  // id would otherwise become a REMOVE proposal against nothing, and a
  // hallucinated requirement id an ADD priced against a requirement that does
  // not exist.
  const repriceIds = triage.repriceCardIds.filter((id) => cardById.has(id));
  const removeIds = triage.removeCardIds.filter((id) => cardById.has(id));
  const newReqIds = triage.newRequirementIds.filter((id) => reqById.has(id));

  await db.estimateReconciliation.update({
    where: { id: reconciliationId },
    data: {
      triagedCardIds: [...repriceIds, ...removeIds],
      triageReasoning: triage.reasoning || null,
    },
  });

  const ledgerContext = renderLedgerContext(
    cards.map((c) => {
      const roleHours: Partial<Record<RoleKind, number>> = {};
      for (const li of c.lineItems) {
        roleHours[li.role] = (roleHours[li.role] ?? 0) + li.baseHours;
      }
      return {
        title: c.title,
        enabled: c.enabled,
        roleHours,
        inEnvelope: repriceIds.includes(c.id),
        lockedRoles: [],
      };
    }),
  );

  const prompts = Object.fromEntries(
    await Promise.all(
      ROLES.map(async (role) => [role, await loadActivePrompt(db, `SPECIALIST_${role}`)] as const),
    ),
  ) as Record<RoleKind, Awaited<ReturnType<typeof loadActivePrompt>>>;

  const recorder = createUsageRecorder({ db, estimateId: rec.estimateId });
  const specialistCtx = {
    modelProvider,
    modelString: prompts.DEV.modelString,
    instructions: {
      DEV: prompts.DEV.body,
      QA: prompts.QA.body,
      PM: prompts.PM.body,
      BA: prompts.BA.body,
    },
    recorder,
    levers: {
      DEV: prompts.DEV.levers,
      QA: prompts.QA.levers,
      PM: prompts.PM.levers,
      BA: prompts.BA.levers,
    },
  };

  const complexityScore = estimate.complexityScore ?? 3;
  const drafts: ProposalDraft[] = [];
  const totalUnits = Math.max(1, repriceIds.length + newReqIds.length);
  let done = 0;

  // ── 3. Re-price the cards in play ──────────────────────────────────────────
  for (const cardId of repriceIds) {
    const card = cardById.get(cardId)!;
    const requirement = requirementForCard(currentRequirements, card.meta);
    done += 1;
    await report(`Re-pricing ${card.title}`, 30 + Math.round((done / totalUnits) * 55));

    if (!requirement) {
      // No requirement to price against — a hand-added card, or one whose run
      // predates the persisted requirement set. Refusing the card is the honest
      // outcome; the alternative is the council inventing a requirement, which
      // is the habit this codebase has removed everywhere else.
      continue;
    }

    const outputs = await step(`reprice:${cardId}`, () =>
      Promise.all(
        ROLES.map((role) =>
          runSpecialist(
            role,
            {
              requirement,
              menuCardId: card.taxonomyKey,
              riskFindings: [],
              complexityScore,
              steer: rec.prompt,
              ledgerContext,
            },
            specialistCtx,
          ),
        ),
      ),
    );

    const rows = toRows(outputs, effective);
    drafts.push({
      menuItemId: cardId,
      kind: 'MODIFY',
      title: card.title,
      supersedesMenuItemIds: [],
      rationale: outputs.flatMap((o) => o.assumptions).join(' ') || triage.reasoning,
      payload: { rows },
      hoursBefore: card.lineItems.reduce((n, li) => n + li.baseHours, 0),
      hoursAfter: rows.reduce((n, r) => n + r.baseHours, 0),
    });
  }

  // ── 4. Cost the work that is genuinely new ─────────────────────────────────
  for (const reqId of newReqIds) {
    const requirement = reqById.get(reqId)!;
    done += 1;
    await report(`Costing ${requirementTitle(requirement)}`, 30 + Math.round((done / totalUnits) * 55));

    const outputs = await step(`cost:${reqId}`, () =>
      Promise.all(
        ROLES.map((role) =>
          runSpecialist(
            role,
            {
              requirement,
              menuCardId: requirement.taxonomyKey ?? requirement.id,
              riskFindings: [],
              complexityScore,
              steer: rec.prompt,
              ledgerContext,
            },
            specialistCtx,
          ),
        ),
      ),
    );

    const rows = toRows(outputs, effective);
    drafts.push({
      menuItemId: null,
      kind: 'ADD',
      title: requirementTitle(requirement),
      supersedesMenuItemIds: [],
      rationale: outputs.flatMap((o) => o.assumptions).join(' ') || triage.reasoning,
      payload: { rows },
      hoursBefore: null,
      hoursAfter: rows.reduce((n, r) => n + r.baseHours, 0),
    });
  }

  // ── 5. Work the brief no longer asks for ───────────────────────────────────
  //
  // No model call: the decision was made in triage, and a REMOVE has no hours
  // to reason about. The card's title is denormalised onto the proposal so the
  // record still reads properly once the card is gone.
  for (const cardId of removeIds) {
    const card = cardById.get(cardId)!;
    drafts.push({
      menuItemId: cardId,
      kind: 'REMOVE',
      title: card.title,
      supersedesMenuItemIds: [],
      rationale: triage.reasoning || 'The revised brief no longer asks for this work.',
      // The rows this destroys, kept on the proposal. Accepting a REMOVE
      // deletes the card and its lines for good, and a record saying only
      // "60h removed" cannot answer what those hours were FOR.
      payload: {
        rows: card.lineItems.map((li) => ({
          role: li.role,
          title: '',
          baseHours: li.baseHours,
          taxedHours: 0,
          notes: null,
          touchesFrontend: false,
          touchesBackend: false,
        })),
      },
      hoursBefore: card.lineItems.reduce((n, li) => n + li.baseHours, 0),
      hoursAfter: 0,
    });
  }

  await report('Writing the proposal', 95);

  await db.$transaction(
    async (tx) => {
      // Replaced wholesale rather than appended: re-running a reconciliation
      // means "decide again", and leaving the previous pass's proposals beside
      // the new ones would ask somebody to accept two answers to one question.
      await tx.reconciliationProposal.deleteMany({ where: { reconciliationId } });
      if (drafts.length > 0) {
        await tx.reconciliationProposal.createMany({
          data: drafts.map((d) => ({
            reconciliationId,
            menuItemId: d.menuItemId,
            kind: d.kind,
            title: d.title,
            supersedesMenuItemIds: d.supersedesMenuItemIds,
            rationale: d.rationale,
            payload: d.payload as never,
            hoursBefore: d.hoursBefore,
            hoursAfter: d.hoursAfter,
          })),
        });
      }
      await tx.estimateReconciliation.update({
        where: { id: reconciliationId },
        data: {
          status: 'PROPOSED',
          stage: 'Proposed',
          pct: 100,
          error: null,
          reasoning: triage.reasoning || null,
        },
      });
    },
    { maxWait: 15_000, timeout: 60_000 },
  );

  return {
    reconciliationId,
    proposals: drafts.length,
    added: drafts.filter((d) => d.kind === 'ADD').length,
    modified: drafts.filter((d) => d.kind === 'MODIFY').length,
    removed: drafts.filter((d) => d.kind === 'REMOVE').length,
  };
}

/**
 * A requirement's heading.
 *
 * `Requirement.text` is a full sentence of what the client asked for, and a
 * proposal's `title` sits in a table cell. Trimmed to a heading rather than
 * wrapped, and never mid-word.
 */
function requirementTitle(r: Requirement): string {
  const text = r.text.trim();
  if (text.length <= 80) return text;
  const cut = text.slice(0, 80);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > 40 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/** Taxed alongside base, so a proposal's figures agree with the ledger's. */
function toRows(outputs: SpecialistOutput[], effective: TaxPercents): ProposedReconcileRow[] {
  const rows: ProposedReconcileRow[] = [];
  for (const out of outputs) {
    for (const li of out.lineItems) {
      rows.push({
        role: out.role,
        title: li.description,
        baseHours: li.hours,
        taxedHours: taxedHoursFor(li.hours, effective[out.role] ?? 0),
        notes: null,
        touchesFrontend: li.touchesFrontend,
        touchesBackend: li.touchesBackend,
      });
    }
  }
  return rows;
}

/**
 * The requirement a card was costed against, from its stored envelope.
 *
 * `meta.requirementIds` is what the pipeline writes; a card with none is
 * hand-added and has nothing to re-price against.
 */
function requirementForCard(requirements: Requirement[], meta: unknown): Requirement | undefined {
  const ids = (meta as { requirementIds?: unknown } | null)?.requirementIds;
  if (!Array.isArray(ids)) return undefined;
  for (const id of ids) {
    const found = requirements.find((r) => r.id === id);
    if (found) return found;
  }
  return undefined;
}

/** The one call that decides scope. */
async function runReconciler(
  input: {
    prompt: string;
    posture: 'SUCCESSOR' | 'BRANCH';
    cards: { id: string; title: string; lineItems: { role: RoleKind; baseHours: number }[] }[];
    priorRequirements: Requirement[];
    currentRequirements: Requirement[];
    sowChanged: boolean;
  },
  ctx: { db: PrismaClient; modelProvider: IModelProvider; estimateId: string },
): Promise<ReconcilerOutput> {
  const prompt = await loadActivePrompt(ctx.db, 'RECONCILER');
  const recorder = createUsageRecorder({ db: ctx.db, estimateId: ctx.estimateId });

  const cardLines = input.cards
    .map((c) => {
      const hours = c.lineItems.reduce((n, li) => n + li.baseHours, 0);
      return `- id=${c.id} "${c.title}" (${Math.round(hours)}h)`;
    })
    .join('\n');

  const reqLines = (rs: Requirement[]): string =>
    rs.length === 0
      ? '(none recorded)'
      : rs.map((r) => `- id=${r.id} "${requirementTitle(r)}"`).join('\n');

  // The posture is stated rather than implied. Both kinds run this same call,
  // and how tightly to hold the parent's shape is exactly the judgement the
  // model has to make differently between them.
  const postureLine =
    input.posture === 'SUCCESSOR'
      ? 'This is a SUCCESSOR: the same job, revised. The existing breakdown holds. Change a card only where the revised brief or the instruction forces it.'
      : 'This is a BRANCH: a different stack, or another route to the same outcome. The existing hours are context for how big this work was judged to be, never a target. Departing from them is expected where the instruction calls for it.';

  const briefLine = input.sowChanged
    ? 'The brief has been revised, so the two requirement sets below may differ.'
    : 'THE BRIEF HAS NOT CHANGED — the two requirement sets below are the same set. Nothing can be read from a diff here. The estimator’s instruction is the only evidence you have about what is different, so decide scope from it.';

  const user = `${postureLine}

${briefLine}

The estimator's instruction:

${input.prompt || '(none given)'}

The cards on this estimate:
${cardLines || '(none)'}

Requirements the original was built from:
${reqLines(input.priorRequirements)}

Requirements the current brief produces:
${reqLines(input.currentRequirements)}`;

  return chatJSON(
    ctx.modelProvider,
    {
      model: prompt.modelString,
      messages: [
        { role: 'system', content: prompt.body },
        { role: 'user', content: user },
      ],
      timeoutMs: CALL_TIMEOUTS.single,
      ...(prompt.levers ?? {}),
    },
    ReconcilerOutputSchema,
    'RECONCILER',
    { kind: 'RECONCILER', recorder },
  );
}
