/**
 * Preset embedding backfill.
 *
 * The Archivist finds presets by vector similarity, and
 * `queryPresetsByVector` filters on `embedding IS NOT NULL AND active = true`.
 * A preset without a vector therefore never matches anything — it does not
 * error, it is simply invisible. `seed-presets.ts` writes no embeddings, and
 * until now nothing in this repo could create them, so a freshly seeded
 * library was silently unusable for retrieval and an edited preset silently
 * dropped out of it.
 *
 * This script is that missing piece. It is idempotent: rows already in sync
 * are skipped, so running it costs nothing when there is nothing to do.
 *
 *   pnpm db:embed:presets           # embed missing + stale rows
 *   pnpm db:embed:presets --force   # re-embed every active preset
 *   pnpm db:embed:presets --dry-run # report what it would do, spend nothing
 *   pnpm db:embed:presets P01 P42   # limit to specific preset ids
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '@repo/db';
import { createModelProvider, EmbeddingProvider } from '@repo/providers';
import { backfillPresetEmbeddings, presetEmbeddingText } from '../writeback';

/**
 * The two secrets this needs live in different files (DATABASE_URL in
 * packages/db/.env, OPENROUTER_API_KEY in apps/web/.env.local), and tsx loads
 * neither. Read both, never overwriting anything already in the environment.
 */
function loadEnvFiles(): void {
  const repoRoot = path.resolve(__dirname, '../../../..');
  const files = [
    path.join(repoRoot, 'packages/db/.env'),
    path.join(repoRoot, 'apps/web/.env.local'),
  ];
  for (const file of files) {
    let contents: string;
    try {
      contents = readFileSync(file, 'utf8');
    } catch {
      continue; // Missing is fine — the checks below report what's actually absent.
    }
    for (const line of contents.split('\n')) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!m?.[1]) continue;
      const value = m[2]!.replace(/^["']|["']$/g, '');
      // A blank assignment is a placeholder, not a value (the repo root .env
      // deliberately blanks OPENROUTER_API_KEY).
      if (value && !process.env[m[1]]) process.env[m[1]] = value;
    }
  }
}

async function main(): Promise<void> {
  loadEnvFiles();

  const argv = process.argv.slice(2);
  const force = argv.includes('--force');
  const dryRun = argv.includes('--dry-run');
  const presetIds = argv.filter((a) => !a.startsWith('--'));

  if (!process.env['DATABASE_URL']) {
    throw new Error(
      'DATABASE_URL is not set. Expected it in packages/db/.env or the environment.',
    );
  }
  if (!dryRun && !process.env['OPENROUTER_API_KEY']) {
    throw new Error(
      'OPENROUTER_API_KEY is not set. Expected it in apps/web/.env.local or the environment. ' +
        'Embedding is a paid API call — refusing to run against an empty key and report ' +
        'every row as failed.',
    );
  }

  const target = presetIds.length ? presetIds.join(', ') : 'the whole active library';
  console.log(`Embedding presets: ${target}${force ? ' (forced)' : ''}${dryRun ? ' (dry run)' : ''}`);

  const db = new PrismaClient();
  try {
    if (dryRun) {
      await report(db, presetIds, force);
      return;
    }

    const provider = new EmbeddingProvider(createModelProvider());
    const result = await backfillPresetEmbeddings(db, provider, {
      force,
      ...(presetIds.length ? { presetIds } : {}),
      onProgress: (done, total, presetId) => console.log(`  [${done}/${total}] ${presetId}`),
    });

    console.log(
      `\nDone. ${result.embedded} embedded ` +
        `(${result.missing} missing, ${result.stale} stale)${
          result.failed.length ? `, ${result.failed.length} failed` : ''
        }.`,
    );
    for (const f of result.failed) console.error(`  FAILED ${f.presetId}: ${f.error}`);
    if (result.failed.length) process.exitCode = 1;
  } finally {
    await db.$disconnect();
  }
}

/** Same classification the backfill uses, without spending anything. */
async function report(db: PrismaClient, presetIds: string[], force: boolean): Promise<void> {
  const rows = await db.presetRetrieval.findMany({
    where: {
      presetVersion: {
        active: true,
        ...(presetIds.length ? { presetId: { in: presetIds } } : {}),
      },
    },
    select: {
      id: true,
      name: true,
      description: true,
      keywords: true,
      notes: true,
      userStoryTags: true,
      embeddingText: true,
      presetVersion: { select: { presetId: true } },
    },
    orderBy: { presetVersion: { presetId: 'asc' } },
  });
  const populated = await db.$queryRawUnsafe<Array<{ id: string }>>(
    `SELECT id FROM "PresetRetrieval" WHERE embedding IS NOT NULL`,
  );
  const hasVector = new Set(populated.map((r) => r.id));

  let missing = 0;
  let stale = 0;
  for (const row of rows) {
    const candidate = {
      name: row.name,
      description: row.description,
      keywords: row.keywords,
      notes: row.notes,
      userStoryTags: row.userStoryTags,
    };
    if (!hasVector.has(row.id)) {
      missing++;
      console.log(`  MISSING  ${row.presetVersion.presetId}  ${row.name}`);
    } else if (force || row.embeddingText !== presetEmbeddingText(candidate)) {
      stale++;
      console.log(`  STALE    ${row.presetVersion.presetId}  ${row.name}`);
    }
  }
  console.log(
    `\n${rows.length} active preset(s): ${missing} missing, ${stale} stale, ` +
      `${rows.length - missing - stale} up to date. Nothing was written.`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
