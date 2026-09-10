import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { PrismaClient } from './generated/client/index.js';
import { forkEstimate } from './fork';

/**
 * AEH-236. Forking an estimate.
 *
 * Two things here are worth more than the rest and are easy to lose.
 *
 * The QUERY COUNT test is not a performance nicety. Copying ~190 line items a
 * row at a time is O(rows) round trips inside a transaction, which passes on a
 * laptop against local Postgres and blows Prisma's 5s default against a remote
 * database. Asserting the RESULT cannot catch that — only counting the queries
 * can, and only at production size.
 *
 * The FOREIGN KEY tests exist because a copy that forgets to remap a column
 * still returns a plausible-looking estimate. `HiddenWorkFinding.menuItemId` is
 * the one that hides: it is nullable and set only on a costed finding, so a
 * fork that copied it verbatim looks perfectly correct on any estimate whose
 * findings are all still open — and silently points at the PARENT's card
 * everywhere else.
 */

const DB_URL =
  process.env['DATABASE_URL'] ??
  'postgresql://postgres:postgres@localhost:5433/ai_estimation?schema=public';
const db = new PrismaClient({ datasources: { db: { url: DB_URL } } });

let userId = '';
let otherUserId = '';
let parentId = '';

/** Ids of every estimate this file made, so teardown never leaves a stray. */
const made: string[] = [];

async function newEstimate(title: string, over: Record<string, unknown> = {}): Promise<string> {
  const est = await db.estimate.create({
    data: {
      title,
      sowText: 'The original brief, at length.',
      status: 'REVIEW',
      configVersion: 7,
      agentState: { librarianOutput: { requirements: [{ id: 'R-1' }] } },
      ownerId: userId,
      ...over,
    },
    select: { id: true },
  });
  made.push(est.id);
  return est.id;
}

beforeAll(async () => {
  await db.$connect();
  const stamp = Date.now();
  const [a, b] = await Promise.all([
    db.user.create({ data: { email: `fork-${stamp}@example.com`, hash: 'x', role: 'ESTIMATOR' } }),
    db.user.create({ data: { email: `fork2-${stamp}@example.com`, hash: 'x', role: 'ESTIMATOR' } }),
  ]);
  userId = a.id;
  otherUserId = b.id;
});

afterAll(async () => {
  await db.user.deleteMany({ where: { id: { in: [userId, otherUserId] } } }).catch(() => {});
  await db.$disconnect();
});

beforeEach(async () => {
  made.length = 0;
  parentId = await newEstimate('Acme CRM — round 1', {
    pmCommunicationTaxPctOverride: 22,
    qaRegressionBufferPctOverride: 13,
    complexityScore: 4,
  });
});

afterEach(async () => {
  // Children first: parentId is SetNull, so a parent delete would orphan rather
  // than cascade, and the child would survive teardown.
  for (const id of [...made].reverse()) {
    await db.estimate.delete({ where: { id } }).catch(() => {});
  }
});

/** A card with one DEV row, in an optional section. */
async function addCard(
  estimateId: string,
  title: string,
  opts: { sectionId?: string; hours?: number } = {},
): Promise<{ cardId: string; lineId: string }> {
  const card = await db.menuItem.create({
    data: {
      estimateId,
      taxonomyKey: `fork.${title.toLowerCase().replace(/\W+/g, '-')}`,
      title,
      sectionId: opts.sectionId ?? null,
      lineItems: {
        create: [{ role: 'DEV', title: `${title} work`, baseHours: opts.hours ?? 10, taxedHours: opts.hours ?? 10 }],
      },
    },
    select: { id: true, lineItems: { select: { id: true } } },
  });
  return { cardId: card.id, lineId: card.lineItems[0]!.id };
}

describe('forkEstimate — refusals', () => {
  it('refuses an untitled fork', async () => {
    const out = await forkEstimate(db, {
      parentId,
      title: '   ',
      kind: 'SUCCESSOR',
      steer: null,
      ownerId: userId,
    });
    expect(out.kind).toBe('refused');
  });

  it('refuses to copy an estimate mid-run, because the run rebuilds the ledger under it', async () => {
    await db.estimate.update({ where: { id: parentId }, data: { runStatus: 'RUNNING' } });
    const out = await forkEstimate(db, {
      parentId,
      title: 'Round 2',
      kind: 'SUCCESSOR',
      steer: null,
      ownerId: userId,
    });
    expect(out.kind).toBe('refused');
    if (out.kind === 'refused') expect(out.error).toMatch(/mid-run|being estimated/i);
  });

  it('refuses to copy an estimate whose documents are still being read', async () => {
    await db.estimate.update({ where: { id: parentId }, data: { ingestStatus: 'RUNNING' } });
    const out = await forkEstimate(db, {
      parentId,
      title: 'Round 2',
      kind: 'SUCCESSOR',
      steer: null,
      ownerId: userId,
    });
    expect(out.kind).toBe('refused');
  });

  it('refuses a parent that does not exist, rather than throwing', async () => {
    const out = await forkEstimate(db, {
      parentId: 'nope-not-a-real-id',
      title: 'Round 2',
      kind: 'BRANCH',
      steer: null,
      ownerId: userId,
    });
    expect(out.kind).toBe('refused');
  });
});

describe('forkEstimate — what comes across', () => {
  it('copies the ledger, remaps every foreign key, and marks it carried', async () => {
    const section = await db.estimateSection.create({
      data: { estimateId: parentId, title: 'Authentication', order: 0 },
      select: { id: true },
    });
    const auth = await addCard(parentId, 'SSO handshake', { sectionId: section.id, hours: 40 });
    const api = await addCard(parentId, 'API layer', { sectionId: section.id, hours: 25 });

    await db.menuItemDependency.create({
      data: {
        estimateId: parentId,
        dependentId: auth.cardId,
        prerequisiteId: api.cardId,
        source: 'MANUAL',
      },
    });
    await db.estimateStatement.createMany({
      data: [
        { estimateId: parentId, kind: 'ASSUMPTION', text: 'Client supplies the SSO metadata.', order: 0 },
        { estimateId: parentId, kind: 'NARRATIVE', text: 'A customer portal.', order: 0 },
      ],
    });
    // A COSTED finding — the case where menuItemId is populated and a naive
    // copy would point at the parent's card.
    await db.hiddenWorkFinding.create({
      data: {
        estimateId: parentId,
        riskFlag: 'no-migration-plan',
        claim: 'The brief never mentions data migration.',
        citation: '§4',
        requirementId: 'R-1',
        outcome: 'AUTO_COST',
        menuItemId: api.cardId,
      },
    });
    const scenario = await db.scopeScenario.create({
      data: {
        estimateId: parentId,
        name: 'Phase 1 only',
        createdById: otherUserId,
        picks: { create: [{ menuItemId: auth.cardId }] },
      },
      select: { id: true },
    });

    const out = await forkEstimate(db, {
      parentId,
      title: 'Acme CRM — September',
      kind: 'SUCCESSOR',
      steer: 'Client dropped reporting and added a loyalty scheme.',
      ownerId: otherUserId,
    });
    expect(out.kind).toBe('ok');
    if (out.kind !== 'ok') return;
    made.push(out.estimateId);

    expect(out.counts).toMatchObject({
      sections: 1,
      cards: 2,
      lineItems: 2,
      dependencies: 1,
      statements: 2,
      findings: 1,
      scenarios: 1,
      picks: 1,
    });

    const fork = await db.estimate.findUniqueOrThrow({
      where: { id: out.estimateId },
      select: {
        parentId: true,
        lineageKind: true,
        forkPrompt: true,
        status: true,
        ownerId: true,
        dueAt: true,
        custodianId: true,
        configVersion: true,
        complexityScore: true,
        pmCommunicationTaxPctOverride: true,
        qaRegressionBufferPctOverride: true,
        sowText: true,
      },
    });
    expect(fork.parentId).toBe(parentId);
    expect(fork.lineageKind).toBe('SUCCESSOR');
    expect(fork.forkPrompt).toMatch(/loyalty/);
    // A copy of an approved estimate is not itself approved.
    expect(fork.status).toBe('DRAFT');
    expect(fork.ownerId).toBe(otherUserId);
    // A new round is a new deadline.
    expect(fork.dueAt).toBeNull();
    expect(fork.custodianId).toBeNull();
    // The hours came across, so the rates that produced them must too.
    expect(fork.configVersion).toBe(7);
    expect(fork.pmCommunicationTaxPctOverride).toBe(22);
    expect(fork.qaRegressionBufferPctOverride).toBe(13);
    expect(fork.sowText).toBe('The original brief, at length.');

    const forkCards = await db.menuItem.findMany({
      where: { estimateId: out.estimateId },
      select: { id: true, title: true, carriedFromId: true, carriedIntact: true, sectionId: true },
      orderBy: { title: 'asc' },
    });
    expect(forkCards.map((c) => c.title)).toEqual(['API layer', 'SSO handshake']);
    expect(forkCards.every((c) => c.carriedIntact)).toBe(true);
    expect(new Set(forkCards.map((c) => c.carriedFromId))).toEqual(
      new Set([auth.cardId, api.cardId]),
    );

    // ── every FK points INTO the fork, never back at the parent ───────────────
    const parentCardIds = new Set([auth.cardId, api.cardId]);
    const forkCardIds = new Set(forkCards.map((c) => c.id));

    const forkSections = await db.estimateSection.findMany({
      where: { estimateId: out.estimateId },
      select: { id: true, title: true },
    });
    expect(forkSections).toHaveLength(1);
    expect(forkCards.every((c) => c.sectionId === forkSections[0]!.id)).toBe(true);

    const forkDeps = await db.menuItemDependency.findMany({
      where: { estimateId: out.estimateId },
      select: { dependentId: true, prerequisiteId: true },
    });
    expect(forkDeps).toHaveLength(1);
    expect(forkCardIds.has(forkDeps[0]!.dependentId)).toBe(true);
    expect(forkCardIds.has(forkDeps[0]!.prerequisiteId)).toBe(true);
    expect(parentCardIds.has(forkDeps[0]!.dependentId)).toBe(false);

    // The one that hides: nullable, and only set on a costed finding.
    const forkFinding = await db.hiddenWorkFinding.findFirstOrThrow({
      where: { estimateId: out.estimateId },
      select: { menuItemId: true, outcome: true, riskFlag: true },
    });
    expect(forkFinding.menuItemId).not.toBe(api.cardId);
    expect(forkCardIds.has(forkFinding.menuItemId!)).toBe(true);
    // Dismissal state survives: it was decided on its merits.
    expect(forkFinding.outcome).toBe('AUTO_COST');
    expect(forkFinding.riskFlag).toBe('no-migration-plan');

    const forkPicks = await db.scopeScenarioPick.findMany({
      where: { scenario: { estimateId: out.estimateId } },
      select: { menuItemId: true, scenarioId: true },
    });
    expect(forkPicks).toHaveLength(1);
    expect(forkCardIds.has(forkPicks[0]!.menuItemId)).toBe(true);
    expect(forkPicks[0]!.scenarioId).not.toBe(scenario.id);

    const forkScenario = await db.scopeScenario.findFirstOrThrow({
      where: { estimateId: out.estimateId },
      select: { createdById: true },
    });
    // The forker owns these cuts now, not the parent's author.
    expect(forkScenario.createdById).toBe(otherUserId);

    const forkStatements = await db.estimateStatement.findMany({
      where: { estimateId: out.estimateId },
      select: { text: true, carriedFromId: true, carriedIntact: true },
    });
    expect(forkStatements).toHaveLength(2);
    expect(forkStatements.every((s) => s.carriedFromId !== null && s.carriedIntact)).toBe(true);
  });

  it('carries the evidence of a lock without carrying the lock', async () => {
    const signed = await addCard(parentId, 'Signed off work');
    const unchecked = await addCard(parentId, 'Never checked');
    await db.ledgerLock.create({
      data: {
        estimateId: parentId,
        lineItemId: signed.lineId,
        declaredScope: 'LINE',
        lockedById: userId,
      },
    });

    const out = await forkEstimate(db, {
      parentId,
      title: 'Round 2',
      kind: 'SUCCESSOR',
      steer: null,
      ownerId: userId,
    });
    expect(out.kind).toBe('ok');
    if (out.kind !== 'ok') return;
    made.push(out.estimateId);
    expect(out.counts.verifiedRows).toBe(1);

    const rows = await db.roleLineItem.findMany({
      where: { menuItem: { estimateId: out.estimateId } },
      select: { carriedVerified: true, carriedFromId: true, lock: { select: { id: true } } },
    });
    expect(rows).toHaveLength(2);
    // Nothing on a fresh fork is frozen — a lock is a statement about the
    // estimate it sits on, and nobody has reviewed this one.
    expect(rows.every((r) => r.lock === null)).toBe(true);
    // But the row that WAS signed off says so.
    const verified = rows.filter((r) => r.carriedVerified);
    expect(verified).toHaveLength(1);
    expect(verified[0]!.carriedFromId).toBe(signed.lineId);
    expect(unchecked.lineId).not.toBe(verified[0]!.carriedFromId);
  });

  it('does not copy the parent activity that belongs to the parent alone', async () => {
    await addCard(parentId, 'A card');
    await db.estimateTaxChange.create({
      data: { estimateId: parentId, role: 'PM', fromPct: 20, toPct: 22, changedBy: userId },
    });
    await db.oracleThread.create({
      data: {
        estimate: { connect: { id: parentId } },
        title: 'Does it cover offline?',
        user: { connect: { id: userId } },
      },
    });

    const out = await forkEstimate(db, {
      parentId,
      title: 'Round 2',
      kind: 'BRANCH',
      steer: 'Rails, not Node.',
      ownerId: userId,
    });
    expect(out.kind).toBe('ok');
    if (out.kind !== 'ok') return;
    made.push(out.estimateId);

    expect(await db.oracleThread.count({ where: { estimateId: out.estimateId } })).toBe(0);
    expect(await db.estimateTaxChange.count({ where: { estimateId: out.estimateId } })).toBe(0);
    expect(await db.ledgerLock.count({ where: { estimateId: out.estimateId } })).toBe(0);
    expect(await db.ledgerEdit.count({ where: { estimateId: out.estimateId } })).toBe(0);
    expect(await db.estimateReminder.count({ where: { estimateId: out.estimateId } })).toBe(0);
  });
});

describe('forkEstimate — lineage survives its parent', () => {
  it('keeps every card, line and hour when the parent is deleted', async () => {
    await addCard(parentId, 'Work that outlives its parent', { hours: 33 });
    const out = await forkEstimate(db, {
      parentId,
      title: 'Round 2',
      kind: 'SUCCESSOR',
      steer: null,
      ownerId: userId,
    });
    if (out.kind !== 'ok') throw new Error('fork refused');
    made.push(out.estimateId);

    await db.estimate.delete({ where: { id: parentId } });

    const survivor = await db.estimate.findUniqueOrThrow({
      where: { id: out.estimateId },
      select: { parentId: true, menuItems: { select: { lineItems: { select: { baseHours: true } } } } },
    });
    // SetNull, not Cascade. The child becomes an original.
    expect(survivor.parentId).toBeNull();
    expect(survivor.menuItems[0]!.lineItems[0]!.baseHours).toBe(33);

    // The carried mark is a claim about where a row came from, and stays true
    // of a document that no longer exists.
    const row = await db.roleLineItem.findFirstOrThrow({
      where: { menuItem: { estimateId: out.estimateId } },
      select: { carriedFromId: true, carriedIntact: true },
    });
    expect(row.carriedFromId).not.toBeNull();
    expect(row.carriedIntact).toBe(true);
  });

  it('forks a fork', async () => {
    await addCard(parentId, 'Original work');
    const first = await forkEstimate(db, {
      parentId,
      title: 'Round 2',
      kind: 'SUCCESSOR',
      steer: null,
      ownerId: userId,
    });
    if (first.kind !== 'ok') throw new Error('fork refused');
    made.push(first.estimateId);

    const second = await forkEstimate(db, {
      parentId: first.estimateId,
      title: 'Round 2 — Rails',
      kind: 'BRANCH',
      steer: 'Rails.',
      ownerId: userId,
    });
    if (second.kind !== 'ok') throw new Error('second fork refused');
    made.push(second.estimateId);

    const child = await db.estimate.findUniqueOrThrow({
      where: { id: second.estimateId },
      select: { parentId: true, lineageKind: true },
    });
    expect(child.parentId).toBe(first.estimateId);
    expect(child.lineageKind).toBe('BRANCH');
    expect(second.counts.cards).toBe(1);
  });
});

describe('forkEstimate — at production size', () => {
  /**
   * The whole point of this file.
   *
   * 50 cards x 4 roles = 200 line items, plus 190 assumptions — a real estimate.
   * The assertion is on the QUERY COUNT, not the duration: a wall-clock budget
   * is flaky on shared CI and passes anyway against a local database, which is
   * exactly the blind spot that lets an O(rows) copy reach production.
   *
   * The bound scales with SECTIONS and SCENARIOS (created individually, and
   * naturally single-digit), never with cards, rows or statements.
   */
  it('copies 200 line items in a constant number of queries', async () => {
    const CARDS = 50;
    const ROLES = ['DEV', 'QA', 'PM', 'BA'] as const;

    const sections = await Promise.all(
      [0, 1, 2].map((i) =>
        db.estimateSection.create({
          data: { estimateId: parentId, title: `Section ${i}`, order: i },
          select: { id: true },
        }),
      ),
    );
    await Promise.all(
      Array.from({ length: CARDS }, (_, i) =>
        db.menuItem.create({
          data: {
            estimateId: parentId,
            taxonomyKey: `bulk.card-${i}`,
            title: `Card ${i}`,
            order: i,
            sectionId: sections[i % 3]!.id,
            lineItems: {
              create: ROLES.map((role) => ({
                role,
                title: `${role} on card ${i}`,
                baseHours: 4,
                taxedHours: 4.8,
              })),
            },
          },
        }),
      ),
    );
    await db.estimateStatement.createMany({
      data: Array.from({ length: 190 }, (_, i) => ({
        estimateId: parentId,
        kind: 'ASSUMPTION' as const,
        text: `Assumption number ${i}, which is long enough to be realistic prose.`,
        order: i,
      })),
    });

    let queries = 0;
    const counting = new PrismaClient({ datasources: { db: { url: DB_URL } }, log: [{ emit: 'event', level: 'query' }] });
    counting.$on('query', () => {
      queries += 1;
    });
    await counting.$connect();

    let out;
    try {
      out = await forkEstimate(counting, {
        parentId,
        title: 'Bulk fork',
        kind: 'SUCCESSOR',
        steer: null,
        ownerId: userId,
      });
    } finally {
      await counting.$disconnect();
    }

    expect(out.kind).toBe('ok');
    if (out.kind !== 'ok') return;
    made.push(out.estimateId);

    expect(out.counts.cards).toBe(CARDS);
    expect(out.counts.lineItems).toBe(CARDS * ROLES.length);
    expect(out.counts.statements).toBe(190);

    // Guard against a vacuous assertion: if the query event never fired,
    // `queries` would be 0 and the bound below would pass while measuring
    // nothing. A copy this size cannot possibly take fewer than ten queries.
    expect(queries).toBeGreaterThan(10);
    // Reads + writes + BEGIN/COMMIT, plus one create per section. Nowhere near
    // the ~450 a per-row copy would issue, and the headroom is deliberate so
    // this fails on a regression rather than on an extra `select`.
    expect(queries).toBeLessThan(40);

    const rows = await db.roleLineItem.count({
      where: { menuItem: { estimateId: out.estimateId } },
    });
    expect(rows).toBe(CARDS * ROLES.length);
    const carried = await db.roleLineItem.count({
      where: { menuItem: { estimateId: out.estimateId }, carriedFromId: { not: null } },
    });
    expect(carried).toBe(CARDS * ROLES.length);
  }, 120_000);
});
