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

/**
 * Hand-authored nodes for work the client never asks for but always pays for.
 *
 * Everything else in this file is DERIVED from the preset library, which is why
 * `infra.*` never existed: no preset carries an "Infra" category, so no such key
 * could ever be minted. These two branches are authored instead, and they live
 * in version control precisely so the set is reviewable rather than implicit.
 *
 * Seeding is bootstrap only — `/admin/taxonomy` is the editing surface, and
 * `upsertNode` deliberately never writes `status` on update, so an admin's
 * decision to collapse or reject a node survives a re-seed. AEH-263.
 */
const MANAGED_NODES: Array<{
  key: string;
  label: string;
  parentKey: string | null;
  reqType: string | null;
  keywords: string[];
  /** Omitted means true. Only the process.* branch opts out — see the schema note. */
  classifiable?: boolean;
}> = [
  // ── infra.*: conditional, driven by Detective risk flags ───────────────────
  // Classifiable: a SOW genuinely can ask for rate limiting or a migration, and
  // when it does, that is asked-for work under this key.
  {
    key: 'infra',
    label: 'Infrastructure & Resilience',
    parentKey: null,
    reqType: null,
    keywords: ['infrastructure', 'resilience', 'reliability', 'hidden work', 'risk'],
  },
  {
    key: 'infra.retries',
    label: 'Infrastructure & Resilience — Retry & Error Handling',
    parentKey: 'infra',
    reqType: 'Infrastructure',
    keywords: ['retry', 'retries', 'backoff', 'error handling', 'idempotency', 'failure'],
  },
  {
    key: 'infra.rate-limit',
    label: 'Infrastructure & Resilience — Rate Limiting & Throttling',
    parentKey: 'infra',
    reqType: 'Infrastructure',
    keywords: ['rate limit', 'throttling', 'quota', 'api limit', 'backpressure'],
  },
  {
    // Kept apart from infra.rate-limit on purpose: throttling to a per-second
    // ceiling and living within a daily call budget are different builds —
    // one backs off, the other batches and schedules.
    key: 'infra.api-quota',
    label: 'Infrastructure & Resilience — API Quota Management',
    parentKey: 'infra',
    reqType: 'Infrastructure',
    keywords: ['api quota', 'daily limit', 'call budget', 'usage cap', 'metering'],
  },
  {
    key: 'infra.data-migration',
    label: 'Infrastructure & Resilience — Data Remediation & Migration',
    parentKey: 'infra',
    reqType: 'Data Migration',
    keywords: ['migration', 'remediation', 'backfill', 'data quality', 'cutover'],
  },
  {
    key: 'infra.legacy-adapter',
    label: 'Infrastructure & Resilience — Legacy System Integration',
    parentKey: 'infra',
    reqType: 'Integration',
    keywords: ['legacy', 'adapter', 'anti-corruption layer', 'wrapper', 'mainframe'],
  },
  {
    key: 'infra.webhook',
    label: 'Infrastructure & Resilience — Webhook Reliability',
    parentKey: 'infra',
    reqType: 'Integration',
    keywords: ['webhook', 'dead letter', 'delivery guarantee', 'replay', 'event'],
  },

  // ── process.*: unconditional delivery overhead ─────────────────────────────
  // These must never re-price what applyTaxationToMenuItems already prices.
  // The taxes cover ONE role's share; these cover the others, plus the work no
  // multiplier models at all. DEV carries no multiplier whatsoever, which is
  // why three of the five below are DEV-side.
  {
    key: 'process',
    label: 'Delivery Process',
    parentKey: null,
    reqType: null,
    keywords: ['process', 'ceremony', 'overhead', 'ways of working'],
    classifiable: false,
  },
  {
    key: 'process.code-review',
    label: 'Delivery Process — Code Review',
    parentKey: 'process',
    reqType: 'Infrastructure',
    keywords: ['pull request', 'code review', 'pr review', 'approval', 'rework'],
    classifiable: false,
  },
  {
    key: 'process.unit-testing',
    label: 'Delivery Process — Unit Testing',
    parentKey: 'process',
    reqType: 'Infrastructure',
    keywords: ['unit test', 'test coverage', 'fixtures', 'mocking'],
    classifiable: false,
  },
  {
    key: 'process.manual-e2e',
    label: 'Delivery Process — Manual End-to-End Passes',
    parentKey: 'process',
    reqType: 'Infrastructure',
    keywords: ['manual testing', 'end to end', 'e2e', 'exploratory', 'uat support'],
    classifiable: false,
  },
  {
    // NOT the PM's or BA's own hours — pmCommunicationTaxPct and
    // baCommunicationTaxPct already price those. This is every OTHER seat at
    // the same meeting, which nothing prices today.
    key: 'process.meetings',
    label: 'Delivery Process — Meeting Attendance (non-PM/BA seats)',
    parentKey: 'process',
    reqType: 'Infrastructure',
    keywords: ['meetings', 'ceremonies', 'standup', 'refinement', 'attendance'],
    classifiable: false,
  },
  {
    // NOT the regression sweep — qaRegressionBufferPct already prices that.
    // This is the churn each individual re-open costs: writing the bug up,
    // context-switching back, re-fixing, re-reviewing, re-testing that ticket.
    key: 'process.ticket-reopens',
    label: 'Delivery Process — Ticket Re-open Churn',
    parentKey: 'process',
    reqType: 'Infrastructure',
    keywords: ['reopen', 'bug churn', 'rework', 'context switch', 'defect cycle'],
    classifiable: false,
  },
];

async function upsertNode(
  prisma: PrismaClient,
  key: string,
  label: string,
  parentKey: string | null,
  reqType: string | null,
  keywords: string[],
  classifiable = true,
  changeReason = 'derived from preset library',
) {
  await prisma.taxonomyNode.upsert({
    where: { key },
    // `status` and `classifiable` are create-only on purpose. Both are governance
    // decisions an admin can change at /admin/taxonomy, and a re-seed must not
    // silently resurrect a node they collapsed or re-expose one they hid.
    update: { label, parentKey },
    create: { key, label, parentKey, classifiable },
  });
  await prisma.taxonomyNodeVersion.upsert({
    where: { nodeKey_version: { nodeKey: key, version: 1 } },
    update: { label, reqType, keywords, active: true },
    create: { nodeKey: key, version: 1, label, reqType, keywords, active: true, changeReason },
  });
}

async function main() {
  const prisma = new PrismaClient();
  try {
    const presets = await prisma.presetVersion.findMany({
      where: { active: true },
      select: {
        id: true,
        anchor: { select: { category: true, reqType: true } },
        preset: { select: { retrieval: { select: { keywords: true } } } },
      },
    });

    // Aggregate keywords per category and per (category, reqType).
    const categories = new Map<string, { label: string; keywords: Set<string> }>();
    const children = new Map<
      string,
      { label: string; parentKey: string; reqType: string; keywords: Set<string> }
    >();
    const presetKeyById = new Map<string, string>();

    for (const p of presets) {
      const category = p.anchor?.category ?? '';
      const reqType = p.anchor?.reqType ?? '';
      const keywords = p.preset.retrieval?.keywords ?? [];
      if (!category || !reqType) continue;

      const catKey = slug(category);
      const childKey = `${catKey}.${slug(reqType)}`;
      presetKeyById.set(p.id, childKey);

      if (!categories.has(catKey)) {
        categories.set(catKey, { label: category, keywords: new Set() });
      }
      if (!children.has(childKey)) {
        children.set(childKey, {
          label: `${category} — ${reqType}`,
          parentKey: catKey,
          reqType,
          keywords: new Set(),
        });
      }
      for (const kw of keywords) {
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

    // Link each preset to its (category, reqType) node. taxonomyKey now lives
    // on the anchor, keyed by the version id it belongs to.
    for (const [versionId, key] of presetKeyById) {
      await prisma.presetAnchor.update({ where: { presetVersionId: versionId }, data: { taxonomyKey: key } });
    }

    // Hand-authored branches. Ordered parents-first purely for readability —
    // parentKey is a bare string like everywhere else in this model, not an FK.
    for (const n of MANAGED_NODES) {
      await upsertNode(
        prisma,
        n.key,
        n.label,
        n.parentKey,
        n.reqType,
        n.keywords,
        n.classifiable ?? true,
        'hand-authored: work the client never asks for (AEH-263)',
      );
    }

    console.log(
      `Taxonomy derived: ${categories.size} categories, ${children.size} leaf nodes, ${presetKeyById.size} presets linked.`,
    );
    console.log(`Taxonomy managed: ${MANAGED_NODES.length} hand-authored nodes upserted (infra.*, process.*).`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
