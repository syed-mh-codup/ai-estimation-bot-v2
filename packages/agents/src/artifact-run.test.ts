import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { PrismaClient, createArtifactType } from '@repo/db';
import type { IModelProvider, ChatOptions } from '@repo/providers';

import { buildArtifactDossier, renderArtifactDossier } from './artifact-dossier';
import { previewArtifactOutline, runArtifact } from './artifacts';

/**
 * AEH-239, end to end against a real database and a stub model.
 *
 * The behaviour worth guarding is the CHECKPOINTING. Generation is N+2 durable
 * Inngest steps because a ~25k-token document cannot be produced inside one
 * 300s invocation with Vercel Pro ruled out, and the value of splitting it is
 * that a failure at section 5 of 9 keeps sections 1 to 4. That only holds if
 * the section write is genuinely idempotent under replay, so that is asserted
 * directly rather than assumed from the `upsert` being there.
 */

const DB_URL =
  process.env['DATABASE_URL'] ??
  'postgresql://postgres:postgres@localhost:5433/ai_estimation?schema=public';
const db = new PrismaClient({ datasources: { db: { url: DB_URL } } });

let userId = '';
let estimateId = '';

/**
 * This file's own namespace for the artifact types it creates.
 *
 * Never a bare `artifactType.deleteMany({})`: vitest runs files in parallel
 * against one database, so an unscoped delete reaches into whatever another
 * file is midway through — which is exactly how a suite becomes intermittently
 * red for reasons nobody can reproduce.
 */
const NS = `run${Math.random().toString(36).slice(2, 8)}`;

/**
 * A stub that derives its answer from what it was actually handed.
 *
 * Same discipline as `stubCartographerProvider`: a canned payload would pass
 * against an estimate whose data never arrived, and would keep passing if the
 * corpus builder broke entirely. This reads the corpus, so the plumbing is
 * genuinely exercised.
 */
function stubProvider(opts: { sections?: number } = {}): {
  provider: IModelProvider;
  /** Live call count. A getter on the provider would be copied by value. */
  state: { calls: number };
} {
  const state = { calls: 0 };
  const provider = {
    async chat(options: ChatOptions) {
      state.calls += 1;
      const text = options.messages.map((m) => String(m.content)).join('\n');
      const isOutline = text.includes('Plan the sections');

      if (isOutline) {
        const n = opts.sections ?? 2;
        return {
          text: JSON.stringify({
            title: 'Stub document',
            vocabulary: ['Order'],
            sections: Array.from({ length: n }, (_, i) => ({
              id: `sec-${i + 1}`,
              title: `Section ${i + 1}`,
              brief: `Brief ${i + 1}`,
            })),
          }),
          model: 'stub/artifact',
          usage: { promptTokens: 10, completionTokens: 20, costUsd: 0.001 },
        };
      }

      // A section. Echo the id it was told to scope under, so a test can prove
      // the right instruction reached the right call.
      const scoped = /#panel-([a-z0-9-]+)/.exec(text)?.[1] ?? 'unknown';
      return {
        text: `<h2>${scoped}</h2><p>from corpus</p>`,
        model: 'stub/artifact',
        usage: { promptTokens: 10, completionTokens: 20, costUsd: 0.002 },
      };
    },
    // Not a generator: artifact generation never streams. Sections are written
    // to the database as whole units, and there is no partial HTML fragment
    // worth showing — progress is reported per section, not per token.
    chatStream() {
      throw new Error('chatStream is not used by artifact generation');
    },
    async embed() {
      throw new Error('embed is not used by artifact generation');
    },
  } as unknown as IModelProvider;

  return { provider, state };
}

async function makeArtifact(corpusSections: string[]): Promise<string> {
  const type = await createArtifactType(db, {
    name: `${NS} ${Math.random().toString(36).slice(2, 8)}`,
    description: null,
    promptBody: 'Produce the entity model.',
    modelString: 'stub/artifact',
    corpusSections,
    createdBy: null,
  });
  const artifact = await db.estimateArtifact.create({
    data: {
      estimateId,
      artifactTypeId: type.id,
      typeVersion: 1,
      title: 'pending',
      status: 'RUNNING',
    },
    select: { id: true },
  });
  return artifact.id;
}

beforeAll(async () => {
  await db.$connect();
  const user = await db.user.create({
    data: { email: `artifacts-${Date.now()}@test.local`, hash: 'x', role: 'ADMIN' },
    select: { id: true },
  });
  userId = user.id;
});

beforeEach(async () => {
  await db.estimate.deleteMany({ where: { ownerId: userId } });
  await db.artifactType.deleteMany({ where: { key: { startsWith: NS } } });

  const est = await db.estimate.create({
    data: {
      title: 'Acme rebuild',
      sowText: 'The client needs an order management system with fulfilment tracking.',
      status: 'REVIEW',
      configVersion: 1,
      narrative: ['A rebuild in three tranches.'],
      assumptions: ['The existing payment provider stays.'],
      agentState: {
        librarianOutput: {
          requirements: [
            { id: 'R1', text: 'Place an order' },
            { id: 'R2', text: 'Track fulfilment' },
          ],
        },
      },
      ownerId: userId,
    },
    select: { id: true },
  });
  estimateId = est.id;

  await db.menuItem.create({
    data: {
      estimateId,
      taxonomyKey: 'commerce.orders',
      title: 'Order placement',
      category: 'Commerce',
      phase: 'Core',
      order: 0,
      foundation: true,
      meta: { requirementIds: ['R1'] },
      lineItems: { create: [{ role: 'DEV', baseHours: 10, taxedHours: 12 }] },
    },
  });
  await db.menuItem.create({
    data: {
      estimateId,
      taxonomyKey: 'commerce.fulfilment',
      title: 'Fulfilment tracking',
      phase: 'Enhancement',
      order: 1,
      meta: { requirementIds: ['R2'] },
      lineItems: { create: [{ role: 'DEV', baseHours: 5, taxedHours: 6 }] },
    },
  });
});

afterAll(async () => {
  await db.estimate.deleteMany({ where: { ownerId: userId } });
  await db.artifactType.deleteMany({ where: { key: { startsWith: NS } } });
  await db.user.delete({ where: { id: userId } });
  await db.$disconnect();
});

describe('buildArtifactDossier', () => {
  it('returns only the sections that were asked for', async () => {
    const d = await buildArtifactDossier(db, estimateId, ['cards']);
    expect(Object.keys(d!.sections)).toEqual(['cards']);
    expect(d!.sections.cards).toContain('Order placement');
    expect(d!.sections.sow).toBeUndefined();
  });

  it('numbers cards once so every section refers to the same card by the same number', async () => {
    // Without a single numbering, the graph section would talk about cards the
    // cards section numbered differently and the model could not tell they were
    // the same thing.
    const d = await buildArtifactDossier(db, estimateId, ['cards']);
    expect(d!.sections.cards).toMatch(/^1\. Order placement/m);
    expect(d!.sections.cards).toMatch(/^2\. Fulfilment tracking/m);
  });

  it('carries the requirement text a card was costed against', async () => {
    const d = await buildArtifactDossier(db, estimateId, ['cards']);
    expect(d!.sections.cards).toContain('asked for: Place an order');
  });

  it('marks an always-included card', async () => {
    const d = await buildArtifactDossier(db, estimateId, ['cards']);
    expect(d!.sections.cards).toContain('always included');
  });

  it('sums line items into the card total', async () => {
    const d = await buildArtifactDossier(db, estimateId, ['rollup']);
    expect(d!.sections.rollup).toContain('18.0h');
  });

  it('reports a requested section that has no data instead of dropping it', async () => {
    // Silence here is what makes a model invent content: shown a heading it was
    // told to expect and nothing under it, it fills the gap.
    const d = await buildArtifactDossier(db, estimateId, ['hiddenWork']);
    expect(d!.empty).toContain('hiddenWork');
    expect(renderArtifactDossier(d!)).toContain('Do not invent any');
  });

  it('reports a key left behind by a retired section rather than failing', async () => {
    const d = await buildArtifactDossier(db, estimateId, ['cards', 'journeys']);
    expect(d!.retired).toEqual(['journeys']);
    expect(d!.sections.cards).toBeDefined();
  });

  it('is null only when the estimate is gone', async () => {
    expect(await buildArtifactDossier(db, 'nope', ['cards'])).toBeNull();
  });

  it('labels sections with the same names the admin picker shows', async () => {
    // The correspondence that makes the picker's blurbs trustworthy: an author
    // who ticked "Menu cards" can find "Menu cards" in what was sent.
    const d = await buildArtifactDossier(db, estimateId, ['cards', 'rollup']);
    const rendered = renderArtifactDossier(d!);
    expect(rendered).toContain('## Menu cards');
    expect(rendered).toContain('## Totals');
  });
});

describe('previewArtifactOutline', () => {
  async function makeType(corpusSections: string[]) {
    return createArtifactType(db, {
      name: `${NS} ${Math.random().toString(36).slice(2, 8)}`,
      description: null,
      promptBody: 'Produce the entity model.',
      modelString: 'stub/artifact',
      corpusSections,
      createdBy: null,
    });
  }

  it('plans the document in one call and writes nothing', async () => {
    // The whole value of the dry run: it answers "did my brief produce a
    // sensible plan" for the price of one call instead of nine, which is what
    // makes authoring a brief from scratch affordable.
    const type = await makeType(['cards']);
    const { provider, state } = stubProvider({ sections: 3 });

    const preview = await previewArtifactOutline({
      db,
      estimateId,
      artifactTypeId: type.id,
      typeVersion: 1,
      modelProvider: provider,
    });

    expect(preview.outline.sections).toHaveLength(3);
    expect(state.calls).toBe(1);
    // No artifact row, so nothing to clean up and nothing that looks half-made
    // in the rail.
    expect(await db.estimateArtifact.count({ where: { estimateId } })).toBe(0);
    expect(await db.artifactSection.count()).toBe(0);
  });

  it('records the spend against the estimate but no document', async () => {
    const type = await makeType(['cards']);
    await previewArtifactOutline({
      db,
      estimateId,
      artifactTypeId: type.id,
      typeVersion: 1,
      modelProvider: stubProvider().provider,
    });

    const usage = await db.modelUsage.findMany({ where: { estimateId, kind: 'ARTIFACT' } });
    expect(usage).toHaveLength(1);
    // The call was real and cost real money; there is simply no document for it
    // to belong to.
    expect(usage[0]!.artifactId).toBeNull();
  });

  it('reports which requested sections are empty rather than hiding them', async () => {
    // The most useful thing a preview can tell an author before they spend
    // anything: half of what you ticked is not on this estimate yet.
    const type = await makeType(['cards', 'hiddenWork']);
    const preview = await previewArtifactOutline({
      db,
      estimateId,
      artifactTypeId: type.id,
      typeVersion: 1,
      modelProvider: stubProvider().provider,
    });
    expect(preview.empty).toContain('hiddenWork');
  });

  it('refuses, with the same message generation would give', async () => {
    const type = await makeType(['hiddenWork']);
    await expect(
      previewArtifactOutline({
        db,
        estimateId,
        artifactTypeId: type.id,
        typeVersion: 1,
        modelProvider: stubProvider().provider,
      }),
    ).rejects.toThrow(/Nothing to work from/);
  });
});

describe('runArtifact', () => {
  it('plans, writes every section, and assembles one document', async () => {
    const artifactId = await makeArtifact(['cards', 'requirements']);
    const { provider, state } = stubProvider({ sections: 3 });

    const result = await runArtifact({ db, artifactId, modelProvider: provider });

    expect(result.sections).toBe(3);
    // One outline call plus one per section.
    expect(state.calls).toBe(4);

    const row = await db.estimateArtifact.findUniqueOrThrow({ where: { id: artifactId } });
    expect(row.status).toBe('DONE');
    expect(row.pct).toBe(100);
    expect(row.title).toBe('Stub document');
    expect(row.finishedAt).not.toBeNull();
    expect(row.content!.startsWith('<!doctype html>')).toBe(true);
    expect(row.content).toContain('id="panel-sec-1"');
    expect(row.content).toContain('id="panel-sec-3"');
  });

  it('persists the outline before writing any section', async () => {
    // So the UI can show the plan while the slow part runs, and so a run that
    // fails halfway is still readable afterwards.
    const artifactId = await makeArtifact(['cards']);
    let outlineAtFirstSection: unknown = null;

    await runArtifact({
      db,
      artifactId,
      modelProvider: stubProvider({ sections: 2 }).provider,
      step: async (id, fn) => {
        if (id.startsWith('artifact-section-') && outlineAtFirstSection === null) {
          const row = await db.estimateArtifact.findUniqueOrThrow({ where: { id: artifactId } });
          outlineAtFirstSection = row.outline;
        }
        return fn();
      },
    });

    expect(outlineAtFirstSection).not.toBeNull();
  });

  it('tells each section call the id to scope its CSS under', async () => {
    const artifactId = await makeArtifact(['cards']);
    await runArtifact({ db, artifactId, modelProvider: stubProvider({ sections: 2 }).provider });

    // The stub echoes back whatever #panel-… it was told, so matching content
    // proves the right instruction reached the right call.
    const rows = await db.artifactSection.findMany({
      where: { artifactId },
      orderBy: { order: 'asc' },
    });
    expect(rows[0]!.html).toContain('<h2>sec-1</h2>');
    expect(rows[1]!.html).toContain('<h2>sec-2</h2>');
  });

  it('does not duplicate a section when its step is replayed', async () => {
    // The checkpoint the whole design rests on. Inngest retries a failed step
    // and replays on resume; a `create` here would hit the unique key and fail
    // the run over work that had actually succeeded.
    const artifactId = await makeArtifact(['cards']);
    const { provider } = stubProvider({ sections: 2 });

    await runArtifact({
      db,
      artifactId,
      modelProvider: provider,
      // Run every section step twice, which is what a retry looks like from
      // the pipeline's point of view.
      step: async (id, fn) => {
        if (id.startsWith('artifact-section-')) await fn();
        return fn();
      },
    });

    const rows = await db.artifactSection.findMany({ where: { artifactId } });
    expect(rows).toHaveLength(2);
  });

  it('attributes every call to ARTIFACT and to this document', async () => {
    // One artifact is N+2 calls, so "what did this document cost" is a real
    // question — and it is a join on artifactId, not a usage kind per type,
    // because a per-type kind would be a migration per type.
    const artifactId = await makeArtifact(['cards']);
    await runArtifact({ db, artifactId, modelProvider: stubProvider({ sections: 3 }).provider });

    const usage = await db.modelUsage.findMany({ where: { artifactId } });
    expect(usage).toHaveLength(4);
    expect(usage.every((u) => u.kind === 'ARTIFACT')).toBe(true);
    expect(usage.every((u) => u.estimateId === estimateId)).toBe(true);
  });

  it('assembles from the database, not from memory', async () => {
    // On an Inngest replay the section steps return memoised values without
    // re-running, so anything accumulated in a local array would be empty by
    // the time assembly happens.
    const artifactId = await makeArtifact(['cards']);
    await runArtifact({
      db,
      artifactId,
      modelProvider: stubProvider({ sections: 2 }).provider,
      step: async (id, fn) => {
        // Simulate memoisation: the section steps "already ran", so their
        // bodies never execute during this pass.
        if (id.startsWith('artifact-section-')) {
          await db.artifactSection.upsert({
            where: { artifactId_sectionId: { artifactId, sectionId: id.replace('artifact-section-', '') } },
            create: {
              artifactId,
              sectionId: id.replace('artifact-section-', ''),
              order: 0,
              title: 'memoised',
              brief: 'memoised',
              html: '<p>memoised</p>',
            },
            update: {},
          });
          return undefined as never;
        }
        return fn();
      },
    });

    const row = await db.estimateArtifact.findUniqueOrThrow({ where: { id: artifactId } });
    expect(row.content).toContain('memoised');
  });

  it('resumes without re-planning or re-paying for finished sections', async () => {
    // The failure this guards is expensive and silent. A resume that re-planned
    // would rename every section, orphan the ones already written, and charge
    // for the lot again — and it would look like it worked.
    const artifactId = await makeArtifact(['cards']);

    // First attempt: dies after section 1 of 3.
    const first = stubProvider({ sections: 3 });
    let written = 0;
    await expect(
      runArtifact({
        db,
        artifactId,
        modelProvider: first.provider,
        step: async (id, fn) => {
          if (id.startsWith('artifact-section-')) {
            written += 1;
            if (written > 1) throw new Error('boom: the step timed out');
          }
          return fn();
        },
      }),
    ).rejects.toThrow(/boom/);

    const afterCrash = await db.artifactSection.findMany({ where: { artifactId } });
    expect(afterCrash).toHaveLength(1);
    const plannedIds = (
      await db.estimateArtifact.findUniqueOrThrow({ where: { id: artifactId } })
    ).outline as { sections: { id: string }[] } | null;
    expect(plannedIds?.sections).toHaveLength(3);

    // Resume: same artifact, fresh provider so its call count is only this run.
    const second = stubProvider({ sections: 3 });
    const result = await runArtifact({ db, artifactId, modelProvider: second.provider });

    expect(result.sections).toBe(3);
    // Two calls, not four: no outline call (the plan was reused) and no call
    // for the section that already existed.
    expect(second.state.calls).toBe(2);

    const rows = await db.artifactSection.findMany({ where: { artifactId } });
    expect(rows).toHaveLength(3);
    // The surviving section kept its identity, which is what let it be skipped.
    expect(rows.map((r) => r.sectionId).sort()).toEqual(['sec-1', 'sec-2', 'sec-3']);

    const row = await db.estimateArtifact.findUniqueOrThrow({ where: { id: artifactId } });
    expect(row.status).toBe('DONE');
    expect(row.content).toContain('id="panel-sec-1"');
  });

  it('keeps the spend record when the document is deleted', async () => {
    // Deleting an artifact to tidy a list must never quietly reduce what the
    // month appears to have cost. The sections go with it (they mean nothing
    // alone); the ModelUsage rows survive with a null artifactId, still
    // attributed to the estimate. This is enforced by the schema — Cascade on
    // one relation, SetNull on the other — so it is asserted against a real
    // database rather than trusted.
    const artifactId = await makeArtifact(['cards']);
    await runArtifact({ db, artifactId, modelProvider: stubProvider({ sections: 2 }).provider });

    expect(await db.modelUsage.count({ where: { artifactId } })).toBe(3);
    expect(await db.artifactSection.count({ where: { artifactId } })).toBe(2);

    await db.estimateArtifact.delete({ where: { id: artifactId } });

    expect(await db.artifactSection.count({ where: { artifactId } })).toBe(0);
    const survivors = await db.modelUsage.findMany({
      where: { estimateId, kind: 'ARTIFACT' },
      select: { artifactId: true, costUsd: true },
    });
    expect(survivors).toHaveLength(3);
    expect(survivors.every((u) => u.artifactId === null)).toBe(true);
    // And the money is still countable.
    expect(survivors.reduce((s, u) => s + (u.costUsd ?? 0), 0)).toBeGreaterThan(0);
  });

  it('refuses rather than generating a document about nothing', async () => {
    // Every requested section empty means the model would be asked to write
    // about an estimate it cannot see, and it would fill the gap by inventing
    // scope. Same guard as runEstimate's empty-SOW refusal.
    const artifactId = await makeArtifact(['hiddenWork', 'scenarios']);
    await expect(
      runArtifact({ db, artifactId, modelProvider: stubProvider().provider }),
    ).rejects.toThrow(/Nothing to work from/);
  });

  it('reports progress that ends at 100', async () => {
    const artifactId = await makeArtifact(['cards']);
    const seen: number[] = [];
    await runArtifact({
      db,
      artifactId,
      modelProvider: stubProvider({ sections: 3 }).provider,
      onProgress: (p) => {
        seen.push(p.pct);
      },
    });

    expect(seen.at(-1)).toBe(100);
    // Monotonic, so the bar only ever moves forward.
    expect([...seen].sort((a, b) => a - b)).toEqual(seen);
  });
});
