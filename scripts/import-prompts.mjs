/**
 * Import prompts (all kinds + versions) from scripts/prompts-export.json into
 * whatever database DATABASE_URL points at. Idempotent: upserts each
 * PromptVersion by its unique (kind, version), so re-running is safe and won't
 * duplicate rows or bump version numbers.
 *
 * Usage (point at PROD — Neon direct URL):
 *   DATABASE_URL="postgresql://...neon.../neondb?sslmode=require" \
 *     node scripts/import-prompts.mjs
 *
 * Add --dry-run to print what would change without writing.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { PrismaClient } from '../packages/db/src/generated/client/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DRY = process.argv.includes('--dry-run');

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required (point it at the target database).');
  process.exit(1);
}

const data = JSON.parse(readFileSync(path.join(__dirname, 'prompts-export.json'), 'utf8'));
const db = new PrismaClient();

let createdVersions = 0;
let updatedVersions = 0;

try {
  for (const p of data.prompts) {
    if (!DRY) {
      await db.prompt.upsert({ where: { kind: p.kind }, update: {}, create: { kind: p.kind } });
    }
    for (const v of p.versions) {
      const existing = await db.promptVersion.findUnique({
        where: { kind_version: { kind: p.kind, version: v.version } },
      });
      const payload = {
        body: v.body,
        modelString: v.modelString,
        active: v.active,
        changeReason: v.changeReason ?? null,
        changeMotivation: v.changeMotivation ?? 'OTHER',
        createdBy: v.createdBy ?? null,
      };
      if (existing) {
        updatedVersions++;
        if (!DRY) {
          await db.promptVersion.update({
            where: { kind_version: { kind: p.kind, version: v.version } },
            data: payload,
          });
        }
      } else {
        createdVersions++;
        if (!DRY) {
          await db.promptVersion.create({ data: { kind: p.kind, version: v.version, ...payload } });
        }
      }
    }
    console.log(`${p.kind}: ${p.versions.length} version(s)`);
  }
  console.log(
    `${DRY ? '[dry-run] would ' : ''}import complete — ${createdVersions} created, ${updatedVersions} updated across ${data.prompts.length} kinds.`,
  );
} finally {
  await db.$disconnect();
}
