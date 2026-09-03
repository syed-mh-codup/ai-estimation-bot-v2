/**
 * Creating and versioning artifact types. AEH-239.
 *
 * The invariants live here rather than in the admin pages for the reason
 * PROGRESS.md records: this repo has no component tests, so anything reachable
 * only from a React file can only be tested through Playwright at ~5 minutes a
 * spec. Everything below is a plain function over a Prisma client, so the
 * single-active rule and slug allocation are covered in milliseconds.
 */
import type { ChangeMotivation, PrismaClient } from './generated/client/index.js';

/**
 * Just enough of a Prisma client to look up taken keys.
 *
 * Narrowed to the one call it makes rather than typed as `PrismaClient`,
 * because the interactive-transaction client is a `PrismaClient` with
 * `$transaction` and friends removed — so anything wider than this cannot be
 * called from inside `createArtifactType`'s transaction, which is the only
 * place it needs to run.
 */
type KeyLookup = {
  artifactType: { findMany(args: { where: { key: { startsWith: string } }; select: { key: true } }): Promise<{ key: string }[]> };
};

/**
 * Turn a name into a URL-safe handle.
 *
 * Deliberately lossy and ASCII-only: this ends up in a path segment that people
 * bookmark and paste into chat, so "Entity model (v2!)" becomes "entity-model-v2"
 * rather than anything percent-encoded. Returns '' when a name has no usable
 * characters at all — the caller decides what to do about that, because
 * "artifact type" is a better fallback than anything this function could invent.
 */
export function slugifyArtifactTypeName(name: string): string {
  return name
    .normalize('NFKD')
    // Strip combining marks so "Café" slugs as "cafe" rather than losing the e.
    // Escaped rather than written literally: a bare combining range in source
    // is invisible in a diff and does not survive a careless re-encode.
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    // The slice can leave a trailing dash behind; trim again rather than ship
    // "entity-model-".
    .replace(/-+$/g, '');
}

/**
 * Allocate a free key for a new artifact type.
 *
 * Suffixes on collision — "entity-model", then "entity-model-2". Not a random
 * suffix: two people naming a type the same thing should get handles that still
 * read as the thing they named, and a bookmarkable URL should not contain a
 * cuid when a number will do.
 *
 * Racy by construction, and that is fine because the column is `@unique`: two
 * simultaneous creates can both read "free" and one will lose at insert time.
 * The caller retries. Making this correct under concurrency would want an
 * advisory lock or a sequence, and artifact types are created by hand a few
 * times a year.
 */
export async function allocateArtifactTypeKey(db: KeyLookup, name: string): Promise<string> {
  const base = slugifyArtifactTypeName(name) || 'artifact-type';

  // One query rather than a probe per candidate. A prefix match is a superset
  // of what can collide, and the set is tiny.
  const taken = new Set(
    (
      await db.artifactType.findMany({
        where: { key: { startsWith: base } },
        select: { key: true },
      })
    ).map((t) => t.key),
  );

  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export type ArtifactTypeDraft = {
  name: string;
  description: string | null;
  promptBody: string;
  modelString: string;
  corpusSections: string[];
  createdBy: string | null;
};

/**
 * Create an artifact type and its first, active version.
 *
 * One transaction, because a type with no version is unusable and invisible:
 * the editor loads the active version and 404s without one, so a half-written
 * pair would be a type nobody could open or delete through the UI.
 */
export async function createArtifactType(
  db: PrismaClient,
  draft: ArtifactTypeDraft,
): Promise<{ id: string; key: string }> {
  return db.$transaction(async (tx) => {
    const key = await allocateArtifactTypeKey(tx, draft.name);
    // Appended, so a new type lands at the end of the picker rather than
    // silently reordering the ones people already know.
    const last = await tx.artifactType.findFirst({
      orderBy: { order: 'desc' },
      select: { order: true },
    });
    const type = await tx.artifactType.create({
      data: {
        key,
        name: draft.name,
        description: draft.description,
        order: (last?.order ?? 0) + 1,
      },
      select: { id: true, key: true },
    });
    await tx.artifactTypeVersion.create({
      data: {
        artifactTypeId: type.id,
        version: 1,
        promptBody: draft.promptBody,
        modelString: draft.modelString,
        corpusSections: draft.corpusSections,
        active: true,
        changeReason: 'created',
        createdBy: draft.createdBy,
      },
    });
    return type;
  });
}

export type ArtifactTypeVersionDraft = {
  promptBody: string;
  modelString: string;
  corpusSections: string[];
  changeReason: string;
  changeMotivation: ChangeMotivation;
  createdBy: string | null;
};

/**
 * Save a new active version of an artifact type.
 *
 * The same single-active-per-parent invariant as `savePrompt`, held the same
 * way: deactivate every active row and create the new one inside one
 * transaction, so no reader can ever see two actives or none.
 *
 * `updateMany` rather than a targeted update because it is also a repair — if
 * a database somehow held two active rows, this settles it rather than adding
 * a third.
 *
 * The next version number is read inside the transaction. That still races two
 * simultaneous saves, and the `@@unique([artifactTypeId, version])` is what
 * actually decides it; one caller gets a constraint error rather than silently
 * overwriting the other's version.
 */
export async function saveArtifactTypeVersion(
  db: PrismaClient,
  artifactTypeId: string,
  draft: ArtifactTypeVersionDraft,
): Promise<{ version: number }> {
  return db.$transaction(async (tx) => {
    const last = await tx.artifactTypeVersion.findFirst({
      where: { artifactTypeId },
      orderBy: { version: 'desc' },
      select: { version: true },
    });
    const version = (last?.version ?? 0) + 1;

    await tx.artifactTypeVersion.updateMany({
      where: { artifactTypeId, active: true },
      data: { active: false },
    });
    await tx.artifactTypeVersion.create({
      data: {
        artifactTypeId,
        version,
        promptBody: draft.promptBody,
        modelString: draft.modelString,
        corpusSections: draft.corpusSections,
        active: true,
        changeReason: draft.changeReason,
        changeMotivation: draft.changeMotivation,
        createdBy: draft.createdBy,
      },
    });
    return { version };
  });
}

/**
 * Make an existing version active again.
 *
 * Flips `active` on a version that already exists rather than creating one —
 * the same distinction `activateVersion` draws for prompts. Rolling back to v3
 * should leave the history reading 1, 2, 3, 4 with 3 active, not append a v5
 * that happens to duplicate v3's text.
 */
export async function activateArtifactTypeVersion(
  db: PrismaClient,
  artifactTypeId: string,
  version: number,
): Promise<void> {
  await db.$transaction([
    db.artifactTypeVersion.updateMany({
      where: { artifactTypeId, active: true },
      data: { active: false },
    }),
    db.artifactTypeVersion.update({
      where: { artifactTypeId_version: { artifactTypeId, version } },
      data: { active: true },
    }),
  ]);
}
