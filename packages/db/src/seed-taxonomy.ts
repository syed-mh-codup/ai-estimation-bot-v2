/**
 * Taxonomy derivation (WS1-10 step 3) — builds an initial taxonomy from the
 * seeded preset library: a parent node per Category and a child node per
 * (Category, Req. type), then links each PresetVersion to its child node.
 *
 * Run AFTER db:seed:presets:
 *   pnpm --filter @repo/db db:seed:taxonomy   (idempotent)
 *
 * The Librarian loads these active taxonomy nodes at run time, so requirements
 * map to real keys instead of null/uncategorised.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { PrismaClient } from './generated/client/index.js';

if (!process.env['DATABASE_URL']) {
  try {
    const envFile = readFileSync(path.resolve(__dirname, '../.env'), 'utf8');
    for (const line of envFile.split('\n')) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m && m[1] && !process.env[m[1]]) {
        process.env[m[1]] = m[2]!.replace(/^["']|["']$/g, '');
      }
    }
  } catch {
    // Prisma will surface a clear error if the URL is missing.
  }
}

const slug = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

async function upsertNode(
  prisma: PrismaClient,
  key: string,
  label: string,
  parentKey: string | null,
  reqType: string | null,
  keywords: string[],
) {
  await prisma.taxonomyNode.upsert({
    where: { key },
    update: { label, parentKey },
    create: { key, label, parentKey },
  });
  await prisma.taxonomyNodeVersion.upsert({
    where: { nodeKey_version: { nodeKey: key, version: 1 } },
    update: { label, reqType, keywords, active: true },
    create: { nodeKey: key, version: 1, label, reqType, keywords, active: true, changeReason: 'derived from preset library' },
  });
}

async function main() {
  const prisma = new PrismaClient();
  try {
    const presets = await prisma.presetVersion.findMany({
      where: { active: true },
      select: { id: true, category: true, reqType: true, keywords: true },
    });

    // Aggregate keywords per category and per (category, reqType).
    const categories = new Map<string, { label: string; keywords: Set<string> }>();
    const children = new Map<
      string,
      { label: string; parentKey: string; reqType: string; keywords: Set<string> }
    >();
    const presetKeyById = new Map<string, string>();

    for (const p of presets) {
      const catKey = slug(p.category);
      const childKey = `${catKey}.${slug(p.reqType)}`;
      presetKeyById.set(p.id, childKey);

      if (!categories.has(catKey)) {
        categories.set(catKey, { label: p.category, keywords: new Set() });
      }
      if (!children.has(childKey)) {
        children.set(childKey, {
          label: `${p.category} — ${p.reqType}`,
          parentKey: catKey,
          reqType: p.reqType,
          keywords: new Set(),
        });
      }
      for (const kw of p.keywords) {
        categories.get(catKey)!.keywords.add(kw);
        children.get(childKey)!.keywords.add(kw);
      }
    }

    for (const [key, c] of categories) {
      await upsertNode(prisma, key, c.label, null, null, [...c.keywords].slice(0, 30));
    }
    for (const [key, c] of children) {
      await upsertNode(prisma, key, c.label, c.parentKey, c.reqType, [...c.keywords].slice(0, 30));
    }

    // Link each preset to its (category, reqType) node.
    for (const [id, key] of presetKeyById) {
      await prisma.presetVersion.update({ where: { id }, data: { taxonomyKey: key } });
    }

    // eslint-disable-next-line no-console
    console.log(
      `Taxonomy derived: ${categories.size} categories, ${children.size} leaf nodes, ${presetKeyById.size} presets linked.`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
