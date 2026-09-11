import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { PrismaClient } from '@repo/db';
import type { ChatResult, IModelProvider } from '@repo/providers';

import { runLedgerEdit } from './ledger-edit';

/**
 * AEH-238. The steered-edit engine under Inngest REPLAY.
 *
 * This file exists because of one bug and the reason it was invisible.
 *
 * `LedgerEditDeps.step` defaults to running each step inline, which is what
 * makes the engine testable with no durable executor. But inline means every
 * step really runs, exactly once, in one pass — so nothing in the suite
 * exercised the thing Inngest actually does: replay the function body from the
 * top at each step boundary, serving already-completed steps from a memo.
 *
 * Under that, `applyRestructure` sitting outside a step was a money loop. Each
 * invocation reshaped again, creating fresh cards with fresh cuids and deleting
 * the previous invocation's as "emptied"; the re-cost steps are keyed
 * `reassess:<cardId>:<role>`, so a new cuid meant a step id that never matched
 * a memoized result — a paid model call, a replay, and round again until the
 * step cap killed the job with the ledger already reshaped.
 *
 * So the harness below is a replaying step, not an inline one. `stepIds` is
 * what the assertions read: if a step id is not STABLE across invocations, it
 * can never be memoized, and that is the bug rather than a detail of it.
 *
 * Prompt rows are upserted per kind without a blanket deactivate, following
 * `run-estimate.test.ts` — this file runs in parallel with others against one
 * local database and sharing `PromptVersion` rows.
 */

const DB_URL =
  process.env['DATABASE_URL'] ??
  'postgresql://postgres:postgres@localhost:5433/ai_estimation?schema=public';
const db = new PrismaClient({ datasources: { db: { url: DB_URL } } });

const NS = `aeh238replay-${Math.random().toString(36).slice(2, 10)}`;
const CONFIG_VERSION = 910_000 + Math.floor(Math.random() * 40_000);
const EFFECTIVE = { DEV: 0, QA: 20, PM: 12, BA: 8 };

let userId = '';
let estimateId = '';
let cardId = '';
let devLineId = '';

/** Thrown to suspend an invocation, the way Inngest suspends at a boundary. */
const SUSPEND = Symbol('suspend');

/**
 * Inngest's execution model, as small as it can honestly be made.
 *
 * The behaviour that matters, and the one an inline step does not have: after a
 * step completes, the function is SUSPENDED and re-invoked FROM THE TOP, with
 * that step's result served from a memo. Everything between the top of the
 * function and the next step therefore runs again, every time.
 *
 * An earlier version of this file just called `runLedgerEdit` twice and
 * asserted the step ids matched. That was wrong, and worth recording: the
 * first call ran to completion, so the second was a re-run of a finished edit
 * whose rows no longer existed — it took the new empty-proposal refusal and
 * executed no steps at all. A replay is mid-flight or it is not a replay.
 *
 * So `run()` drives the whole lifecycle: invoke, let one fresh step through,
 * suspend, invoke again, until an invocation reaches the end without needing a
 * new one.
 */
function replayRunner() {
  const cache = new Map<string, unknown>();
  const stepIds: string[][] = [];

  /** Drive one edit to completion the way the executor would. */
  async function run(
    body: (step: <T>(id: string, fn: () => Promise<T>) => Promise<T>) => Promise<unknown>,
  ): Promise<{ invocations: number }> {
    for (let invocation = 1; invocation <= 20; invocation += 1) {
      const seen: string[] = [];
      stepIds.push(seen);
      let ranFresh = false;

      const step = async <T>(id: string, fn: () => Promise<T>): Promise<T> => {
        seen.push(id);
        if (cache.has(id)) return cache.get(id) as T;
        const out = await fn();
        // Through JSON, like a real memoized result — which is why the engine
        // stores the post-reshape fingerprint as an ISO string rather than a
        // Date that would come back as one.
        cache.set(id, JSON.parse(JSON.stringify(out)));
        ranFresh = true;
        throw SUSPEND;
      };

      try {
        await body(step);
        return { invocations: invocation };
      } catch (e) {
        if (e !== SUSPEND) throw e;
        if (!ranFresh) throw new Error('suspended without running a step');
      }
    }
    throw new Error('did not settle within 20 invocations');
  }

  return { stepIds, run };
}

/** A provider that answers the Curator, then every specialist call. */
function stubProvider(): IModelProvider {
  return {
    chat: vi.fn().mockImplementation((req: { messages: Array<{ content: string }> }) => {
      const system = req.messages[0]?.content ?? '';
      const text = system.includes('CURATOR')
        ? JSON.stringify({
            cards: [
              { ref: 1, title: 'Payment', taxonomyKey: `${NS}.pay`, phase: 'Core', lines: [1] },
            ],
            notes: 'Carved the payment work out.',
          })
        : JSON.stringify({
            // `complexity` is required by the specialist's schema; without it
            // the parse fails and `withRetry` turns it into a step error.
            lineItems: [{ description: 'payment intent', hours: 3, complexity: 'base' }],
            assumptions: [],
          });
      return Promise.resolve({ text, model: 'stub/model', usage: null } satisfies ChatResult);
    }),
    chatStream: async function* () {
      yield { type: 'done' as const, usage: null, model: 'stub/model' };
    },
    embed: vi.fn(),
  } as unknown as IModelProvider;
}

beforeAll(async () => {
  await db.$connect();

  await db.estimationConfig.create({
    data: {
      version: CONFIG_VERSION,
      active: false,
      pmCommunicationTaxPct: 12,
      baCommunicationTaxPct: 8,
      qaRegressionBufferPct: 20,
    },
  });

  for (const kind of ['CURATOR', 'SPECIALIST_DEV'] as const) {
    await db.prompt.upsert({ where: { kind }, update: {}, create: { kind } });
    await db.promptVersion.upsert({
      where: { kind_version: { kind, version: 1 } },
      update: { active: true, body: `You are the ${kind} prompt`, modelString: 'stub/model' },
      create: {
        kind,
        version: 1,
        active: true,
        body: `You are the ${kind} prompt`,
        modelString: 'stub/model',
      },
    });
  }

  const user = await db.user.create({
    data: { email: `${NS}@example.test`, hash: 'x', role: 'ESTIMATOR' },
  });
  userId = user.id;
});

afterAll(async () => {
  await db.estimate.deleteMany({ where: { ownerId: userId } });
  await db.estimationConfig.deleteMany({ where: { version: CONFIG_VERSION } });
  await db.user.deleteMany({ where: { id: userId } }).catch(() => {});
  await db.$disconnect();
});

beforeEach(async () => {
  await db.estimate.deleteMany({ where: { ownerId: userId } });

  const est = await db.estimate.create({
    data: {
      title: `${NS} estimate`,
      sowText: 'x',
      status: 'REVIEW',
      configVersion: CONFIG_VERSION,
      complexityScore: 3,
      ownerId: userId,
      // The requirement set every run persists; without it the re-cost has
      // nothing to price against and carries rows through instead.
      //
      // COMPLETE, deliberately. `LibrarianOutputSchema` validates every field,
      // and a partial one parses to `[]` — which sends the engine down the
      // no-requirement carry-through path with no model call at all, so this
      // test would pass its replay assertions while measuring nothing.
      agentState: {
        librarianOutput: {
          requirements: [
            {
              id: 'REQ-001',
              text: 'Take card payments at checkout.',
              category: 'Commerce',
              reqType: 'FEATURE',
              platforms: ['web'],
              projectSize: 'Mid-market',
              dataVolume: 'Low',
              integrationCount: 1,
              ambiguities: [],
              candidateMenuCardId: 'MC-COMMERCE-CHECKOUT',
              sourceRef: 'SOW §2.1',
              taxonomyKey: null,
              blocksEstimation: false,
            },
          ],
        },
      },
      menuItems: {
        create: [
          {
            taxonomyKey: `${NS}.checkout`,
            title: 'Checkout',
            meta: { requirementIds: ['REQ-001'] },
            lineItems: {
              create: [
                { role: 'DEV', title: 'dev one', baseHours: 4, taxedHours: 4, provenance: 'CREW' },
              ],
            },
          },
        ],
      },
    },
    select: { id: true, menuItems: { select: { id: true, lineItems: { select: { id: true } } } } },
  });
  estimateId = est.id;
  cardId = est.menuItems[0]!.id;
  devLineId = est.menuItems[0]!.lineItems[0]!.id;
});

async function newEdit(mode: 'REPRICE' | 'RESTRUCTURE'): Promise<string> {
  const row = await db.ledgerEdit.create({
    data: {
      estimateId,
      actorId: userId,
      prompt: 'split the payment work out',
      mode,
      declaredScope: 'CARD',
      declaredTargetId: cardId,
      roles: ['DEV'],
      pinnedLineItemIds: [devLineId],
      pinnedCardIds: [cardId],
      status: 'QUEUED',
    },
    select: { id: true },
  });
  return row.id;
}

describe('a RESTRUCTURE survives being replayed', () => {
  it('reshapes ONCE however many times the body re-runs', async () => {
    const editId = await newEdit('RESTRUCTURE');
    const runner = replayRunner();
    const modelProvider = stubProvider();

    const { invocations } = await runner.run((step) =>
      runLedgerEdit(editId, { db, modelProvider, effective: EFFECTIVE, step }),
    );

    // curate, reshape, one reassess — so four invocations: three that each ran
    // a fresh step and suspended, and one that found everything memoized and
    // ran to the end.
    expect(invocations).toBe(4);

    // ONE card carved out, not one per invocation. Before the fix the reshape
    // ran on every pass, creating a fresh cuid each time and deleting the
    // previous pass's card as "emptied".
    const cards = await db.menuItem.findMany({
      where: { estimateId },
      orderBy: { order: 'asc' },
      select: { title: true },
    });
    // Just the one. The fixture card holds a single DEV line, so carving it
    // out empties the source and `applyRestructure` removes it — which is the
    // merge half of that operation working correctly, not a loss. (The
    // DEV-only carve-out that LEAVES a source card behind is covered in
    // packages/db/src/ledger-edit.test.ts, where the card also has QA rows.)
    expect(cards.map((c) => c.title)).toEqual(['Payment']);

    // And the money. One Curator call, one specialist call — this is the
    // number the loop was burning, once per invocation, for ever.
    expect((modelProvider.chat as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);

    const row = await db.ledgerEdit.findUniqueOrThrow({
      where: { id: editId },
      select: { status: true, overwroteConflict: true },
    });
    expect(row.status).toBe('APPLIED');
    // The reshape re-fingerprints rather than switching the check off, so
    // nothing here was overwritten and the audit does not claim it was.
    expect(row.overwroteConflict).toBe(false);
  });

  it('asks for the SAME reassess step id on every pass', async () => {
    const editId = await newEdit('RESTRUCTURE');
    const runner = replayRunner();

    await runner.run((step) =>
      runLedgerEdit(editId, { db, modelProvider: stubProvider(), effective: EFFECTIVE, step }),
    );

    const reassess = runner.stepIds
      .flat()
      .filter((id) => id.startsWith('reassess:'));
    // THE assertion. A `reassess:<cardId>:<role>` id built from a card the
    // reshape had just re-created would differ on every pass, so it could
    // never be served from the memo — which IS the loop rather than a symptom.
    expect(new Set(reassess).size).toBe(1);
    expect(reassess.length).toBeGreaterThan(1);
    expect(runner.stepIds[0]).toEqual(['curate']);
    expect(runner.stepIds[1]).toEqual(['curate', 'reshape']);
  });
});

describe('a REPRICE survives being replayed', () => {
  it('pays for its one call once, and applies once', async () => {
    const editId = await newEdit('REPRICE');
    const runner = replayRunner();
    const modelProvider = stubProvider();

    const { invocations } = await runner.run((step) =>
      runLedgerEdit(editId, { db, modelProvider, effective: EFFECTIVE, step }),
    );

    // One reassess step, so two invocations.
    expect(invocations).toBe(2);
    expect((modelProvider.chat as unknown as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
    // A re-price names cards that never move, so its ids were always stable.
    // Pinned rather than assumed.
    expect(new Set(runner.stepIds.flat()).size).toBe(1);

    const rows = await db.roleLineItem.findMany({
      where: { menuItemId: cardId },
      select: { title: true, baseHours: true, provenance: true },
    });
    expect(rows).toEqual([
      { title: 'payment intent', baseHours: 3, provenance: 'STEERED' },
    ]);
  });
});
