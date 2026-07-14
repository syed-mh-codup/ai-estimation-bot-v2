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
import { createHash } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { PrismaClient } from './generated/client/index.js';
// Required prompt set (side-effect-free) — shared with the e2e global-setup.
import { SEED_PROMPTS } from './seed-prompts.js';

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
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export const SEED_USERS = {
  admin: { email: 'admin@codup.co', password: 'admin1234', role: 'ADMIN' as const },
  estimator: { email: 'estimator@codup.co', password: 'estimator1234', role: 'ESTIMATOR' as const },
};

// The WS26-01 sample SOW fixtures (simple / integration-heavy / legacy-heavy),
// seeded as DRAFT estimates so they're ready to Run from the dashboard. Texts
// mirror @repo/shared SAMPLE_SOWS (whose expected complexity bands are asserted
// in agents/fixtures.test.ts).
const SAMPLE_SOWS = [
  {
    id: 'sow-simple',
    title: 'Marketing Landing Page',
    sowText:
      'Build a single marketing landing page with a hero section, a features list, ' +
      'testimonials, and a contact form that emails submissions to the team. ' +
      'No user accounts and no integrations — just a static, responsive page with a small form.',
  },
  {
    id: 'sow-integration',
    title: 'Multi-System Order Hub',
    sowText:
      'Build an order hub that integrates with five external services. Connect to the ' +
      'Stripe payment gateway via its API, sync inventory through a third-party SDK, ' +
      'push fulfilment events to a shipping webhook, pull pricing from an external service API, ' +
      'and expose a public REST API for partners. Each integration needs retry and rate-limit handling.',
  },
  {
    id: 'sow-legacy',
    title: 'Mainframe Modernisation',
    sowText:
      'Migrate a legacy COBOL mainframe monolith to a modern web stack. This is a ' +
      'data migration of millions of records from the end-of-life system, including a ' +
      'rewrite of core business rules currently locked in the mainframe.',
  },
];

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
    const configData = {
      active: true,
      // Shape MUST match the complexity engine's ComplexityRulesSchema
      // (packages/agents/src/complexity.ts) or a run will fail to parse it.
      complexityRules: {
        apiIntegrationThresholds: [
          { minCount: 0, maxCount: 1, score: 1 },
          { minCount: 2, maxCount: 3, score: 3 },
          { minCount: 4, maxCount: 6, score: 4 },
          { minCount: 7, maxCount: 999, score: 5 },
        ],
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
        dataVolumeMultipliers: { NONE: 1.0, LOW: 1.1, HIGH: 1.5 },
        aiKeywords: ['machine learning', 'ai assist', 'neural', 'prediction model', 'llm', 'nlp'],
        aiScoreBonus: 1.3,
        perItemMultiplierDefault: 1.0,
      },
      pmCommunicationTaxPct: 15,
      baCommunicationTaxPct: 10,
      qaRegressionBufferPct: 20,
      infraBaseline: { devops: 24, environments: ['dev', 'staging', 'prod'] },
      changeReason: 'bootstrap seed',
    };
    // Restore the full values on update too, so re-seeding over an existing v1
    // (e.g. an e2e run left it with empty JSON) brings back the rich seed data.
    const config = await prisma.estimationConfig.upsert({
      where: { version: 1 },
      update: configData,
      create: { version: 1, ...configData },
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
            sowHash: sha256(s.sowText),
            status: 'DRAFT',
            configVersion: config.version,
            taxonomyVersionsPinned: {},
            promptVersionsPinned: {},
            modelConfig: {},
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
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
