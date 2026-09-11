/**
 * Bootstrap seed — minimal data so the app can be booted and exercised manually
 * or in e2e BEFORE the full preset-library seed (WS1-10) exists.
 *
 * Seeds (idempotently):
 *   - one ADMIN and one ESTIMATOR user with known credentials
 *   - one active EstimationConfig (v1) — required: Estimate.configVersion is non-null
 *   - two sample Estimate rows so the dashboard list/detail is demonstrable
 *
 * Run: pnpm --filter @repo/db db:seed   (idempotent — safe to re-run)
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import { PrismaClient } from './generated/client/index.js';
// Required prompt set (side-effect-free) — shared with the e2e global-setup.
import { SEED_PROMPTS } from './seed-prompts.js';
// The WS26-01 sample SOW fixtures, seeded as DRAFT estimates so they're ready
// to Run from the dashboard. Imported rather than mirrored: the texts used to
// be duplicated here and hand-synchronised with the copy whose complexity
// bands agents/fixtures.test.ts asserts, which is two sources of truth for
// one fixture.
import { SAMPLE_SOWS } from '@repo/shared';
import { syncPresetCodeSequence } from './preset-code';

// tsx does not auto-load .env, and Prisma Client does not load it at runtime.
// Read packages/db/.env ourselves (dependency-free) if DATABASE_URL is unset.
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
    // fall through — Prisma will report a clear error if the URL is missing
  }
}

const SALT_ROUNDS = 12;

export const SEED_USERS = {
  admin: { email: 'admin@codup.co', password: 'admin1234', role: 'ADMIN' as const },
  estimator: { email: 'estimator@codup.co', password: 'estimator1234', role: 'ESTIMATOR' as const },
};

// (SEED_PROMPTS imported at the top from ./seed-prompts.js)

/**
 * SEED_USERS have publicly-known passwords, so they must never reach a hosted
 * environment. In production this seed installs only the data an instance needs
 * (config, prompts) and skips the dev users + demo estimates; the real admin is
 * created from env by `db:seed:admin`. ALLOW_DEV_USERS=1 overrides (e.g. a
 * throwaway staging box you want the demo fixtures on).
 */
const SEED_DEV_DATA =
  process.env['NODE_ENV'] !== 'production' || process.env['ALLOW_DEV_USERS'] === '1';

async function main() {
  const prisma = new PrismaClient();
  try {
    // 1. Users -------------------------------------------------------------
    const users: Record<string, { id: string }> = {};
    if (SEED_DEV_DATA) {
      for (const [key, u] of Object.entries(SEED_USERS)) {
        const hash = await bcrypt.hash(u.password, SALT_ROUNDS);
        const user = await prisma.user.upsert({
          where: { email: u.email },
          update: { hash, role: u.role },
          create: { email: u.email, hash, role: u.role, name: u.email },
        });
        users[key] = user;
      }
    }

    // 2. Active EstimationConfig (v1) — Estimate.configVersion needs this ---
    // Deactivate any other versions first so re-seeding a dirty DB (e.g. after
    // an e2e run created v2+) can't leave two active configs.
    await prisma.estimationConfig.updateMany({ where: { active: true }, data: { active: false } });
    // The ladder from "how many integrations does this SOW want" to a base
    // complexity score. `position` is the rule, not the presentation: the scorer
    // takes the first band containing the count and stops.
    const apiThresholds = [
      { position: 0, minCount: 0, maxCount: 1, score: 1 },
      { position: 1, minCount: 2, maxCount: 3, score: 3 },
      { position: 2, minCount: 4, maxCount: 6, score: 4 },
      { position: 3, minCount: 7, maxCount: 999, score: 5 },
    ];
    // Delivery overhead: work every project carries that no SOW names.
    // Percentages, not flat hours — 24h of ceremony is 6% of a nine-month build
    // and 120% of a two-week one.
    //
    // These are the complement of the tax percentages below, never a repeat of
    // them: PM/BA comms tax prices those roles' own hours in a meeting, and
    // process.meetings prices the DEV and QA seats at the same meeting; the QA
    // regression buffer prices the sweep, process.ticket-reopens the per-reopen
    // churn. Every hour is claimed by exactly one mechanism. A role that charges
    // nothing is left null rather than set to 0 — a 0% card is still a card.
    const overheadItems = [
      { position: 0, title: 'Code Review', taxonomyKey: 'process.code-review', devPct: 8 },
      { position: 1, title: 'Unit Testing', taxonomyKey: 'process.unit-testing', devPct: 10 },
      { position: 2, title: 'Manual End-to-End Passes', taxonomyKey: 'process.manual-e2e', qaPct: 15 },
      { position: 3, title: 'Meeting Attendance', taxonomyKey: 'process.meetings', devPct: 5, qaPct: 5 },
      { position: 4, title: 'Ticket Re-open Churn', taxonomyKey: 'process.ticket-reopens', devPct: 5, qaPct: 5 },
    ];
    const configData = {
      active: true,
      pmCommunicationTaxPct: 15,
      baCommunicationTaxPct: 10,
      qaRegressionBufferPct: 20,
      hiddenWorkBlocksFinalise: false,
      legacyKeywords: [
        'legacy',
        'mainframe',
        'cobol',
        'migration',
        'rewrite',
        'monolith',
        'end-of-life',
      ],
      legacyScoreBonus: 1.5,
      aiKeywords: ['machine learning', 'ai assist', 'neural', 'prediction model', 'llm', 'nlp'],
      aiScoreBonus: 1.3,
      dataVolumeMultiplierNone: 1.0,
      dataVolumeMultiplierLow: 1.1,
      dataVolumeMultiplierHigh: 1.5,
      changeReason: 'bootstrap seed',
    };
    // Clear the child rows in their own statements rather than as a nested
    // `deleteMany` beside the `create` below. Both orderings are legal to write,
    // only one is legal to run: (configId, position) is unique, so a create that
    // landed before the delete would collide with the rows it is replacing.
    await prisma.complexityApiThreshold.deleteMany({ where: { config: { version: 1 } } });
    await prisma.processOverheadItem.deleteMany({ where: { config: { version: 1 } } });
    // Restore the full values on update too, so re-seeding over an existing v1
    // (e.g. an e2e run left it stripped back) brings back the rich seed data.
    const config = await prisma.estimationConfig.upsert({
      where: { version: 1 },
      update: {
        ...configData,
        apiThresholds: { create: apiThresholds },
        overheadItems: { create: overheadItems },
      },
      create: {
        version: 1,
        ...configData,
        apiThresholds: { create: apiThresholds },
        overheadItems: { create: overheadItems },
      },
    });

    // 3. Sample estimates --------------------------------------------------
    // Demo estimates are owned by the seeded estimator, so they only exist
    // wherever the dev users do.
    if (SEED_DEV_DATA) {
      for (const s of SAMPLE_SOWS) {
        await prisma.estimate.upsert({
          where: { id: s.id },
          update: {},
          create: {
            id: s.id,
            title: s.title,
            sowText: s.sowText,
            status: 'DRAFT',
            configVersion: config.version,
            agentState: {},
            ownerId: users['estimator']!.id,
          },
        });
      }
    }

    // 4. Active prompt per seeded agent kind -------------------------------
    for (const p of SEED_PROMPTS) {
      await prisma.prompt.upsert({
        where: { kind: p.kind },
        update: {},
        create: { kind: p.kind },
      });
      // Single-active guarantee per kind (same reasoning as the config above).
      await prisma.promptVersion.updateMany({
        where: { kind: p.kind, active: true },
        data: { active: false },
      });
      await prisma.promptVersion.upsert({
        where: { kind_version: { kind: p.kind, version: 1 } },
        update: { body: p.body, modelString: p.modelString, active: true },
        create: {
          kind: p.kind,
          version: 1,
          body: p.body,
          modelString: p.modelString,
          active: true,
          changeReason: 'bootstrap seed',
        },
      });
    }

    // Move the preset-code sequence past anything already in the table. The
    // xlsx importer used to do this and was retired with the spreadsheet
    // (AEH-242); the hazard it guarded outlived it. A restored backup can carry
    // preset codes the sequence has never issued, and the next allocation would
    // then collide on a unique column. Idempotent and forward-only, so running
    // it on every seed costs nothing.
    await syncPresetCodeSequence(prisma);

    const devCount = SEED_DEV_DATA ? Object.keys(SEED_USERS).length : 0;
    console.log(
      `Seed complete: ${devCount} users, config v${config.version}, ` +
        `${SEED_DEV_DATA ? SAMPLE_SOWS.length : 0} estimates, ${SEED_PROMPTS.length} prompts.`,
    );
    if (!SEED_DEV_DATA) {
      console.log(
        'Production mode: skipped dev users + demo estimates.\n' +
          'Create the admin with:  ADMIN_EMAIL=… ADMIN_PASSWORD=… pnpm db:seed:admin',
      );
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
