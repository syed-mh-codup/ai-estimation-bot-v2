import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import {
  CORPUS_SECTIONS,
  isCorpusSectionKey,
  partitionCorpusSections,
} from './artifact-corpus-catalogue.js';
import {
  activateArtifactTypeVersion,
  allocateArtifactTypeKey,
  createArtifactType,
  saveArtifactTypeVersion,
  slugifyArtifactTypeName,
} from './artifact-types.js';
import { PrismaClient } from './generated/client/index.js';

/**
 * AEH-239. Artifact types are rows, so the rules that keep them coherent are
 * application code rather than schema constraints — which means they are only
 * as good as these tests.
 *
 * The invariant that matters most is single-active-per-type. Everything that
 * generates an artifact loads "the active version"; two actives means the
 * document you get depends on row order, and no actives means the type silently
 * stops working. Neither state is representable in the schema, so both are
 * asserted here.
 */

const DB_URL =
  process.env['DATABASE_URL'] ??
  'postgresql://postgres:postgres@localhost:5433/ai_estimation?schema=public';
const db = new PrismaClient({ datasources: { db: { url: DB_URL } } });

/**
 * Every name this file uses is prefixed with a per-run namespace, and cleanup
 * only ever deletes keys under it.
 *
 * A bare `artifactType.deleteMany({})` is the obvious thing to write here and
 * it is wrong: vitest runs files in parallel against one database, so a global
 * delete reaches into whatever another file is midway through. That is how a
 * suite becomes intermittently red for reasons nobody can reproduce, and this
 * repo already has one of those (AEH-282).
 *
 * The prefix goes at the FRONT of the name deliberately. `allocateArtifactTypeKey`
 * collides on a key PREFIX, so a trailing namespace would make "X" and
 * "X extended" stop sharing one — and the test that pins that behaviour would
 * pass without exercising it.
 */
const NS = `t${Math.random().toString(36).slice(2, 8)}`;
const name = (s: string): string => `${NS} ${s}`;
const base = (s: string): string => slugifyArtifactTypeName(name(s));

const draft = (over: Partial<Parameters<typeof createArtifactType>[1]> = {}) => ({
  name: name('Entity model'),
  description: 'An ERD',
  promptBody: 'Show every logical entity and how they relate.',
  modelString: 'anthropic/claude-opus-5',
  corpusSections: ['cards', 'requirements'],
  createdBy: 'someone@codup.co',
  ...over,
});

/** Every active version of one type. The invariant is that this has length 1. */
async function activesOf(artifactTypeId: string) {
  return db.artifactTypeVersion.findMany({
    where: { artifactTypeId, active: true },
    select: { version: true },
  });
}

// Cascades to versions. Scoped to this file's namespace so parallel files
// cannot delete each other's fixtures.
const clean = () => db.artifactType.deleteMany({ where: { key: { startsWith: NS } } });

beforeEach(clean);

afterAll(async () => {
  await clean();
  await db.artifactType.deleteMany({ where: { key: { startsWith: 'artifact-type' } } });
  await db.$disconnect();
});

describe('slugifyArtifactTypeName', () => {
  it('lowercases and hyphenates a plain name', () => {
    expect(slugifyArtifactTypeName('Entity Model')).toBe('entity-model');
  });

  it('drops punctuation rather than percent-encoding it', () => {
    // The handle ends up in a URL people paste into chat; "entity-model-v2"
    // survives that and "Entity%20model%20(v2!)" does not.
    expect(slugifyArtifactTypeName('Entity model (v2!)')).toBe('entity-model-v2');
  });

  it('folds accents to ASCII instead of losing the letter', () => {
    expect(slugifyArtifactTypeName('Café journeys')).toBe('cafe-journeys');
  });

  it('collapses runs of separators and trims the ends', () => {
    expect(slugifyArtifactTypeName('  --Low-fidelity   wireframes--  ')).toBe(
      'low-fidelity-wireframes',
    );
  });

  it('never ends in a dash, even when the length cap lands on one', () => {
    // The cap is applied mid-string, so it can slice straight through a
    // separator and leave a trailing dash the earlier trim already ran past.
    const slug = slugifyArtifactTypeName(`${'a'.repeat(60)} tail`);
    expect(slug).toBe('a'.repeat(60));
    expect(slug.endsWith('-')).toBe(false);
  });

  it('returns empty for a name with nothing usable in it', () => {
    // Deliberately not a fallback: the caller substitutes one, because it knows
    // what a sensible default reads like and this function does not.
    expect(slugifyArtifactTypeName('!!! ???')).toBe('');
  });
});

describe('allocateArtifactTypeKey', () => {
  it('gives the plain slug when nothing has claimed it', async () => {
    expect(await allocateArtifactTypeKey(db, name('Entity model'))).toBe(base('Entity model'));
  });

  it('suffixes on collision rather than randomising', async () => {
    await createArtifactType(db, draft({ name: name('Entity model') }));
    expect(await allocateArtifactTypeKey(db, name('Entity model'))).toBe(
      `${base('Entity model')}-2`,
    );
  });

  it('keeps counting past the first suffix', async () => {
    await createArtifactType(db, draft({ name: name('Entity model') }));
    await createArtifactType(db, draft({ name: name('Entity model') }));
    expect(await allocateArtifactTypeKey(db, name('Entity model'))).toBe(
      `${base('Entity model')}-3`,
    );
  });

  it('is not confused by a longer key that merely starts with the same text', async () => {
    // The collision query is a prefix match, which is a superset of what can
    // actually collide. "…entity-model-extended" starts with "…entity-model"
    // and must not push the next plain allocation off it.
    await createArtifactType(db, draft({ name: name('Entity model extended') }));
    expect(await allocateArtifactTypeKey(db, name('Entity model'))).toBe(base('Entity model'));
  });

  it('falls back to a readable key when the name slugs to nothing', async () => {
    expect(await allocateArtifactTypeKey(db, '!!!')).toBe('artifact-type');
  });
});

describe('createArtifactType', () => {
  it('creates the type and exactly one active v1 together', async () => {
    const { id, key } = await createArtifactType(db, draft());
    expect(key).toBe(base('Entity model'));

    const versions = await db.artifactTypeVersion.findMany({ where: { artifactTypeId: id } });
    expect(versions).toHaveLength(1);
    expect(versions[0]).toMatchObject({
      version: 1,
      active: true,
      promptBody: 'Show every logical entity and how they relate.',
      corpusSections: ['cards', 'requirements'],
      createdBy: 'someone@codup.co',
    });
  });

  it('appends rather than reordering what people already know', async () => {
    const first = await createArtifactType(db, draft({ name: name('One') }));
    const second = await createArtifactType(db, draft({ name: name('Two') }));
    const rows = await db.artifactType.findMany({
      where: { id: { in: [first.id, second.id] } },
      orderBy: { order: 'asc' },
      select: { key: true },
    });
    expect(rows.map((r) => r.key)).toEqual([base('One'), base('Two')]);
  });
});

describe('saveArtifactTypeVersion', () => {
  it('increments the version and moves active onto it', async () => {
    const { id } = await createArtifactType(db, draft());

    const { version } = await saveArtifactTypeVersion(db, id, {
      promptBody: 'Now also colour entities by delivery tranche.',
      modelString: 'anthropic/claude-opus-5',
      corpusSections: ['cards', 'requirements', 'graph'],
      changeReason: 'tranche colouring was missing',
      changeMotivation: 'CORRECTION',
      createdBy: 'someone@codup.co',
    });

    expect(version).toBe(2);
    expect(await activesOf(id)).toEqual([{ version: 2 }]);
  });

  it('keeps the superseded version readable rather than overwriting it', async () => {
    const { id } = await createArtifactType(db, draft());
    await saveArtifactTypeVersion(db, id, {
      promptBody: 'v2 body',
      modelString: 'm',
      corpusSections: [],
      changeReason: 'r',
      changeMotivation: 'OTHER',
      createdBy: null,
    });

    const v1 = await db.artifactTypeVersion.findFirstOrThrow({
      where: { artifactTypeId: id, version: 1 },
    });
    expect(v1.promptBody).toBe('Show every logical entity and how they relate.');
    expect(v1.active).toBe(false);
  });

  it('settles a database that somehow holds two active versions', async () => {
    const { id } = await createArtifactType(db, draft());
    // Force the state the schema cannot forbid. `updateMany` in the save is
    // what repairs it; a targeted update would leave a third active behind.
    await db.artifactTypeVersion.create({
      data: {
        artifactTypeId: id,
        version: 2,
        promptBody: 'rogue',
        modelString: 'm',
        corpusSections: [],
        active: true,
      },
    });
    expect(await activesOf(id)).toHaveLength(2);

    await saveArtifactTypeVersion(db, id, {
      promptBody: 'v3 body',
      modelString: 'm',
      corpusSections: [],
      changeReason: 'r',
      changeMotivation: 'OTHER',
      createdBy: null,
    });

    expect(await activesOf(id)).toEqual([{ version: 3 }]);
  });

  it('leaves another type’s active version alone', async () => {
    const a = await createArtifactType(db, draft({ name: name('A') }));
    const b = await createArtifactType(db, draft({ name: name('B') }));

    await saveArtifactTypeVersion(db, a.id, {
      promptBody: 'x',
      modelString: 'm',
      corpusSections: [],
      changeReason: 'r',
      changeMotivation: 'OTHER',
      createdBy: null,
    });

    expect(await activesOf(b.id)).toEqual([{ version: 1 }]);
  });
});

describe('activateArtifactTypeVersion', () => {
  it('rolls back without appending a duplicate version', async () => {
    const { id } = await createArtifactType(db, draft());
    await saveArtifactTypeVersion(db, id, {
      promptBody: 'v2 body',
      modelString: 'm',
      corpusSections: [],
      changeReason: 'r',
      changeMotivation: 'OTHER',
      createdBy: null,
    });

    await activateArtifactTypeVersion(db, id, 1);

    expect(await activesOf(id)).toEqual([{ version: 1 }]);
    // The point of activate-over-save: history still reads 1, 2 — not 1, 2, 3
    // where 3 is a copy of 1.
    const all = await db.artifactTypeVersion.findMany({ where: { artifactTypeId: id } });
    expect(all).toHaveLength(2);
  });
});

describe('the corpus catalogue', () => {
  it('has a unique, non-empty key and a real description for every section', () => {
    // Every artifact type here is hand-authored against this list, so a section
    // with a placeholder blurb is a section nobody can make an informed choice
    // about.
    const keys = CORPUS_SECTIONS.map((s) => s.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const s of CORPUS_SECTIONS) {
      expect(s.key).not.toBe('');
      expect(s.label.length).toBeGreaterThan(0);
      expect(s.blurb.length).toBeGreaterThan(40);
    }
  });

  it('recognises its own keys and nothing else', () => {
    for (const s of CORPUS_SECTIONS) expect(isCorpusSectionKey(s.key)).toBe(true);
    expect(isCorpusSectionKey('cards ')).toBe(false);
    expect(isCorpusSectionKey('Cards')).toBe(false);
  });

  it('separates keys a retired section left behind from live ones', () => {
    // The drift case this exists for: a type ticked "journeys", a later release
    // removed it, and generation must degrade that one type rather than fail.
    const { known, unknown } = partitionCorpusSections(['cards', 'journeys', 'rollup']);
    expect(known).toEqual(['cards', 'rollup']);
    expect(unknown).toEqual(['journeys']);
  });

  it('de-duplicates, so a repeated key is not rendered and billed twice', () => {
    expect(partitionCorpusSections(['cards', 'cards']).known).toEqual(['cards']);
    expect(partitionCorpusSections(['x', 'x']).unknown).toEqual(['x']);
  });

  it('preserves the order the author selected', () => {
    expect(partitionCorpusSections(['rollup', 'cards']).known).toEqual(['rollup', 'cards']);
  });
});
