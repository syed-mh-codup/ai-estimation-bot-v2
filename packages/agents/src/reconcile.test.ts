import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { PrismaClient, forkEstimate } from '@repo/db';
import type { IModelProvider } from '@repo/providers';

import { runReconciliation } from './reconcile';

/**
 * AEH-236. The reconciliation pass.
 *
 * The test that matters most is `a branch with no new documents still proposes
 * something`. The first design of this pass drove its loop off the requirement
 * diff, which is empty for a stack change — the brief has not moved, only the
 * way the work is built — so it made no model call at all and reported success
 * having proposed nothing. Silently, with a green run and an untouched
 * estimate. Nothing about the output distinguishes that from "correctly decided
 * there was nothing to do", which is why it needs a test that counts CALLS.
 *
 * The model is stubbed throughout. What is being pinned here is control flow —
 * which calls happen, driven by what — not the quality of any model's judgement.
 */

const DB_URL =
  process.env['DATABASE_URL'] ??
  'postgresql://postgres:postgres@localhost:5433/ai_estimation?schema=public';
const db = new PrismaClient({ datasources: { db: { url: DB_URL } } });

let userId = '';
let parentId = '';
let forkId = '';
const made: string[] = [];

/**
 * Whole Requirements, not just an id and a sentence.
 *
 * They are parsed back out of `agentState` with the real `RequirementSchema`,
 * so a thin fixture does not fail loudly — `safeParse` returns `success: false`
 * and the pass sees NO requirements at all. Every card then looks like
 * hand-added work with nothing to re-price against, and the pass proposes
 * nothing while reporting success. Which is exactly the failure this file
 * exists to catch, arriving from the fixture rather than the code.
 */
const req = (id: string, text: string) => ({
  id,
  text,
  category: 'B2B',
  reqType: 'Feature',
  platforms: [],
  projectSize: 'Mid-market' as const,
  dataVolume: 'Low' as const,
  integrationCount: 0,
  candidateMenuCardId: `MC-${id}`,
  taxonomyKey: null,
  sourceRef: '§1',
  ambiguities: [],
  blocksEstimation: false,
});

const REQS = [
  req('R-1', 'The portal must authenticate staff through the corporate SSO.'),
  req('R-2', 'Customers must be able to pay by card.'),
];

/** Every prompt the pass loads, recorded so the calls can be counted by agent. */
const calls: { agent: string; system: string; user: string }[] = [];

/**
 * A provider that answers each agent with the shape its schema demands.
 *
 * `reconcilerReply` is swapped per test — it is the decision under test, and
 * everything downstream is a consequence of it.
 */
let reconcilerReply: Record<string, unknown> = {};

function stubProvider(): IModelProvider {
  return {
    chat: vi.fn(async (opts: { messages: { role: string; content: string }[] }) => {
      const system = opts.messages.find((m) => m.role === 'system')?.content ?? '';
      const user = opts.messages.find((m) => m.role === 'user')?.content ?? '';
      // Keyed off the USER message, never the system prompt.
      //
      // The system prompt is whatever body happens to be seeded in this
      // database, and these tests share one with every other file — a
      // developer's local database currently holds an active LIBRARIAN version
      // whose body is the string "v2 prompt updated", left by another test.
      // Matching on it classified the Librarian as a specialist and handed it
      // the wrong schema. The user message is built by code in this repo
      // (`librarian.ts` and `reconcile.ts`), so it is a contract rather than a
      // fixture.
      const agent = user.includes("The estimator's instruction:")
        ? 'RECONCILER'
        : user.includes('Decompose this SOW')
          ? 'LIBRARIAN'
          : 'SPECIALIST';
      calls.push({ agent, system, user });

      const content =
        agent === 'RECONCILER'
          ? JSON.stringify(reconcilerReply)
          : agent === 'LIBRARIAN'
            ? JSON.stringify({ requirements: REQS })
            : JSON.stringify({
                role: 'DEV',
                lineItems: [
                  {
                    description: 'Reconciled work',
                    hours: 3,
                    complexity: 'base',
                    aiAssistApplied: false,
                    dependsOn: [],
                    side: 'backend',
                  },
                ],
                assumptions: ['Priced against the revised brief.'],
                coversRiskFlags: [],
              });

      // `text`, not `content` — see ChatResult. Getting this wrong surfaces as
      // "Cannot read properties of undefined (reading 'match')" from the JSON
      // parser, which says nothing about the actual mistake.
      return {
        text: content,
        model: 'stub/model',
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      };
    }),
  } as unknown as IModelProvider;
}

const EFFECTIVE = { DEV: 0, QA: 20, PM: 20, BA: 15 };

async function reconcile(): Promise<{ id: string }> {
  const rec = await db.estimateReconciliation.create({
    data: {
      estimateId: forkId,
      actorId: userId,
      prompt: 'Rebuild this on WordPress with plugins instead of a custom build.',
      posture: 'BRANCH',
      status: 'QUEUED',
    },
    select: { id: true },
  });
  await runReconciliation(rec.id, {
    db,
    modelProvider: stubProvider(),
    effective: EFFECTIVE,
  });
  return rec;
}

beforeAll(async () => {
  await db.$connect();
  const u = await db.user.create({
    data: { email: `reconcile-${Date.now()}@example.com`, hash: 'x', role: 'ESTIMATOR' },
  });
  userId = u.id;
  // The pass loads active prompts for RECONCILER, LIBRARIAN and all four
  // specialists. Seeded here rather than assumed: a missing row is a throw, and
  // a test that fails on setup teaches nothing about the pass.
  for (const kind of ['RECONCILER', 'LIBRARIAN', 'SPECIALIST_DEV', 'SPECIALIST_QA', 'SPECIALIST_PM', 'SPECIALIST_BA'] as const) {
    const existing = await db.prompt.findUnique({ where: { kind } });
    if (existing) continue;
    await db.prompt.create({
      data: {
        kind,
        versions: {
          create: {
            version: 1,
            body: kind === 'RECONCILER' ? 'You are the Reconciler.' : `You are the ${kind}.`,
            modelString: 'stub/model',
            active: true,
          },
        },
      },
    });
  }
});

afterAll(async () => {
  await db.user.delete({ where: { id: userId } }).catch(() => {});
  await db.$disconnect();
});

beforeEach(async () => {
  made.length = 0;
  calls.length = 0;
  reconcilerReply = { repriceCardIds: [], newRequirementIds: [], removeCardIds: [], reasoning: '' };

  const parent = await db.estimate.create({
    data: {
      title: 'Reconcile parent',
      sowText: 'A portal with SSO and card payments, at length.',
      status: 'REVIEW',
      configVersion: 1,
      complexityScore: 3,
      agentState: { librarianOutput: { requirements: REQS } },
      ownerId: userId,
      menuItems: {
        create: [
          {
            taxonomyKey: 'auth.sso',
            title: 'Auth & SSO',
            meta: { requirementIds: ['R-1'] },
            lineItems: { create: [{ role: 'DEV', baseHours: 20, taxedHours: 20 }] },
          },
          {
            taxonomyKey: 'pay.card',
            title: 'Payments',
            meta: { requirementIds: ['R-2'] },
            lineItems: { create: [{ role: 'DEV', baseHours: 30, taxedHours: 30 }] },
          },
        ],
      },
    },
    select: { id: true },
  });
  parentId = parent.id;
  made.push(parentId);

  const out = await forkEstimate(db, {
    parentId,
    title: 'Reconcile fork',
    kind: 'BRANCH',
    steer: 'Rebuild on WordPress.',
    ownerId: userId,
  });
  if (out.kind !== 'ok') throw new Error('fork refused in setup');
  forkId = out.estimateId;
  made.push(forkId);
});

afterEach(async () => {
  for (const id of [...made].reverse()) {
    await db.estimate.delete({ where: { id } }).catch(() => {});
  }
});

const cardIds = async (): Promise<Record<string, string>> => {
  const rows = await db.menuItem.findMany({
    where: { estimateId: forkId },
    select: { id: true, title: true },
  });
  return Object.fromEntries(rows.map((r) => [r.title, r.id]));
};

describe('the brief is only re-read when it moved', () => {
  it('does NOT call the Librarian when the SOW matches the parent', async () => {
    // A branch attaches no documents, so `sowText` is byte-identical. Re-reading
    // it would be worse than wasteful: the Librarian is not deterministic, so it
    // would manufacture a requirement diff out of nothing and the pass would
    // chase changes nobody made.
    await reconcile();
    expect(calls.filter((c) => c.agent === 'LIBRARIAN')).toHaveLength(0);
  });

  it('calls the Librarian once when the SOW has been added to', async () => {
    await db.estimate.update({
      where: { id: forkId },
      data: { sowText: 'A portal with SSO and card payments, at length.\n\n── Revised ──\nAdd loyalty.' },
    });
    await reconcile();
    expect(calls.filter((c) => c.agent === 'LIBRARIAN')).toHaveLength(1);
  });
});

describe('a branch with no new documents still proposes something', () => {
  it('prices every card triage selected, though the requirement diff is empty', async () => {
    // THE regression test. The brief has not changed, so a diff-driven loop
    // would make no specialist call at all and report success having proposed
    // nothing. Counting calls is the only way to see that: the returned result
    // of "nothing to do" is identical either way.
    const ids = await cardIds();
    reconcilerReply = {
      repriceCardIds: [ids['Auth & SSO'], ids['Payments']],
      newRequirementIds: [],
      removeCardIds: [],
      reasoning: 'A platform change puts every card in play.',
    };

    const rec = await reconcile();

    expect(calls.filter((c) => c.agent === 'RECONCILER')).toHaveLength(1);
    // Four roles per card, two cards.
    expect(calls.filter((c) => c.agent === 'SPECIALIST')).toHaveLength(8);

    const proposals = await db.reconciliationProposal.findMany({
      where: { reconciliationId: rec.id },
      select: { kind: true, title: true, hoursBefore: true, hoursAfter: true },
    });
    expect(proposals).toHaveLength(2);
    expect(proposals.every((p) => p.kind === 'MODIFY')).toBe(true);
    expect(proposals.map((p) => p.title).sort()).toEqual(['Auth & SSO', 'Payments']);
  });

  it('hands the steering instruction to every specialist call', async () => {
    // With no requirement diff the steer is the ONLY evidence of what is
    // different, so a call that does not carry it is pricing the old approach.
    const ids = await cardIds();
    reconcilerReply = {
      repriceCardIds: [ids['Payments']],
      newRequirementIds: [],
      removeCardIds: [],
      reasoning: 'x',
    };
    await reconcile();
    const specialists = calls.filter((c) => c.agent === 'SPECIALIST');
    expect(specialists.length).toBeGreaterThan(0);
    expect(specialists.every((c) => c.user.includes('WordPress'))).toBe(true);
  });

  it('keeps a narrow steer narrow', async () => {
    // The other half of the same rule. Selecting everything by reflex would
    // make "swap the payment provider" cost as much as a platform migration.
    const ids = await cardIds();
    reconcilerReply = {
      repriceCardIds: [ids['Payments']],
      newRequirementIds: [],
      removeCardIds: [],
      reasoning: 'Only payments are affected.',
    };
    await reconcile();
    expect(calls.filter((c) => c.agent === 'SPECIALIST')).toHaveLength(4);
  });
});

describe('what the pass writes', () => {
  it('never touches the ledger — PROPOSED is its success state', async () => {
    const ids = await cardIds();
    const before = await db.roleLineItem.findMany({
      where: { menuItem: { estimateId: forkId } },
      select: { id: true, baseHours: true },
      orderBy: { id: 'asc' },
    });
    reconcilerReply = {
      repriceCardIds: [ids['Auth & SSO']],
      newRequirementIds: ['R-2'],
      removeCardIds: [ids['Payments']],
      reasoning: 'Everything at once.',
    };

    const rec = await reconcile();

    const after = await db.roleLineItem.findMany({
      where: { menuItem: { estimateId: forkId } },
      select: { id: true, baseHours: true },
      orderBy: { id: 'asc' },
    });
    expect(after).toEqual(before);
    expect(await db.menuItem.count({ where: { estimateId: forkId } })).toBe(2);

    const row = await db.estimateReconciliation.findUniqueOrThrow({
      where: { id: rec.id },
      select: { status: true, pct: true, triagedCardIds: true, triageReasoning: true },
    });
    expect(row.status).toBe('PROPOSED');
    expect(row.pct).toBe(100);
    // Triage's selection is recorded, so a too-narrow pass is visible rather
    // than looking like a quiet model failure.
    expect(row.triagedCardIds.sort()).toEqual([ids['Auth & SSO'], ids['Payments']].sort());
    expect(row.triageReasoning).toBe('Everything at once.');
  });

  it('proposes an ADD for a requirement no card covers', async () => {
    reconcilerReply = {
      repriceCardIds: [],
      newRequirementIds: ['R-2'],
      removeCardIds: [],
      reasoning: 'New work.',
    };
    const rec = await reconcile();
    const p = await db.reconciliationProposal.findFirstOrThrow({
      where: { reconciliationId: rec.id },
      select: { kind: true, menuItemId: true, hoursBefore: true, hoursAfter: true },
    });
    expect(p.kind).toBe('ADD');
    // Null because the card does not exist yet — it is created from what the
    // council returns, not invented by triage.
    expect(p.menuItemId).toBeNull();
    expect(p.hoursBefore).toBeNull();
    expect(p.hoursAfter).toBeGreaterThan(0);
  });

  it('proposes a REMOVE without a model call, keeping the title readable', async () => {
    const ids = await cardIds();
    reconcilerReply = {
      repriceCardIds: [],
      newRequirementIds: [],
      removeCardIds: [ids['Payments']],
      reasoning: 'The brief dropped card payments.',
    };
    const rec = await reconcile();

    expect(calls.filter((c) => c.agent === 'SPECIALIST')).toHaveLength(0);
    const p = await db.reconciliationProposal.findFirstOrThrow({
      where: { reconciliationId: rec.id },
      select: { kind: true, title: true, hoursBefore: true, hoursAfter: true, rationale: true },
    });
    expect(p.kind).toBe('REMOVE');
    // Denormalised, so the record still reads properly once the card is gone.
    expect(p.title).toBe('Payments');
    expect(p.hoursBefore).toBe(30);
    expect(p.hoursAfter).toBe(0);
    expect(p.rationale).toContain('dropped');
  });
});

describe('ids the model invented are dropped', () => {
  it('ignores card and requirement ids that are not in the input', async () => {
    // A hallucinated card id would otherwise become a REMOVE proposal against
    // nothing, and a hallucinated requirement id an ADD priced against a
    // requirement that does not exist.
    reconcilerReply = {
      repriceCardIds: ['not-a-card'],
      newRequirementIds: ['R-999'],
      removeCardIds: ['also-not-a-card'],
      reasoning: 'Confidently wrong.',
    };
    const rec = await reconcile();
    expect(calls.filter((c) => c.agent === 'SPECIALIST')).toHaveLength(0);
    expect(await db.reconciliationProposal.count({ where: { reconciliationId: rec.id } })).toBe(0);
    const row = await db.estimateReconciliation.findUniqueOrThrow({
      where: { id: rec.id },
      select: { status: true, triagedCardIds: true },
    });
    expect(row.status).toBe('PROPOSED');
    expect(row.triagedCardIds).toEqual([]);
  });
});

describe('re-running a pass replaces its proposals', () => {
  it('does not leave two answers to one question', async () => {
    const ids = await cardIds();
    reconcilerReply = {
      repriceCardIds: [ids['Payments']],
      newRequirementIds: [],
      removeCardIds: [],
      reasoning: 'first',
    };
    const rec = await reconcile();
    expect(await db.reconciliationProposal.count({ where: { reconciliationId: rec.id } })).toBe(1);

    reconcilerReply = {
      repriceCardIds: [ids['Auth & SSO']],
      newRequirementIds: [],
      removeCardIds: [],
      reasoning: 'second',
    };
    await runReconciliation(rec.id, { db, modelProvider: stubProvider(), effective: EFFECTIVE });

    const proposals = await db.reconciliationProposal.findMany({
      where: { reconciliationId: rec.id },
      select: { title: true },
    });
    expect(proposals).toHaveLength(1);
    expect(proposals[0]!.title).toBe('Auth & SSO');
  });
});
