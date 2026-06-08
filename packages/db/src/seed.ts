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

const SAMPLE_SOWS = [
  {
    id: 'seed-estimate-loyalty',
    title: 'Customer Loyalty Mobile App',
    sowText:
      'Build a customer loyalty mobile app (iOS + Android) with points accrual, ' +
      'a rewards catalogue, push notifications, and a basic admin dashboard for ' +
      'managing campaigns. Integrate with the existing CRM for customer identity.',
  },
  {
    id: 'seed-estimate-portal',
    title: 'B2B Supplier Onboarding Portal',
    sowText:
      'A web portal for onboarding B2B suppliers: multi-step KYC form, document ' +
      'upload with virus scanning, approval workflow with role-based reviewers, ' +
      'and an audit trail. Integrate with SAP for supplier master data sync.',
  },
];

// Starting instructions for every agent the pipeline loads. These are sensible
// defaults to fine-tune from the Prompts admin — the run loads the ACTIVE
// version of each, so editing one and re-running changes behaviour immediately.
const MODEL = 'openai/gpt-4o-mini';
const SEED_PROMPTS = [
  {
    kind: 'LIBRARIAN' as const,
    body: 'You are the Librarian. Decompose the Statement of Work into a list of discrete, buildable requirements. For each, map it to the best-fitting taxonomy key (or null) and assign a confidence 0–1. Respond with JSON only.',
  },
  {
    kind: 'DETECTIVE' as const,
    body: 'You are the Detective. Investigate external integrations and unknowns in the SOW using available tools. Surface findings, risk flags, and open questions with citations.',
  },
  {
    kind: 'ARCHIVIST' as const,
    body: 'You are the Archivist. Given extracted requirements, find the most similar historical presets and rerank them by relevance to the current scope.',
  },
  {
    kind: 'SPECIALIST_DEV' as const,
    body: 'You are the Development estimator. Estimate realistic engineering base hours for the menu item, grounded in the preset anchor, complexity score, and risk flags. Respond with JSON {"baseHours","rationale","assumptions"}.',
  },
  {
    kind: 'SPECIALIST_QA' as const,
    body: 'You are the QA estimator. Estimate QA/testing base hours for the menu item relative to development scope, complexity, and risk. Respond with JSON {"baseHours","rationale","assumptions"}.',
  },
  {
    kind: 'SPECIALIST_PM' as const,
    body: 'You are the Project Management estimator. Estimate PM coordination base hours for the menu item. Respond with JSON {"baseHours","rationale","assumptions"}.',
  },
  {
    kind: 'SPECIALIST_BA' as const,
    body: 'You are the Business Analysis estimator. Estimate BA/requirements base hours for the menu item. Respond with JSON {"baseHours","rationale","assumptions"}.',
  },
  {
    kind: 'ARCHITECT' as const,
    body: 'You are the Architect. Synthesise the specialists’ outputs into a coherent Menu Card. Write one approach-narrative sentence per enabled item and collate assumptions. Respond with JSON for the narrative.',
  },
  {
    kind: 'SUPERVISOR' as const,
    body: 'You are the Supervisor. Orchestrate the estimation agents in order, enforce the validation gate, and ensure the output is internally consistent.',
  },
].map((p) => ({ ...p, modelString: MODEL }));

async function main() {
  const prisma = new PrismaClient();
  try {
    // 1. Users -------------------------------------------------------------
    const users: Record<string, { id: string }> = {};
    for (const [key, u] of Object.entries(SEED_USERS)) {
      const hash = await bcrypt.hash(u.password, SALT_ROUNDS);
      const user = await prisma.user.upsert({
        where: { email: u.email },
        update: { hash, role: u.role },
        create: { email: u.email, hash, role: u.role, name: u.email },
      });
      users[key] = user;
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
        legacyKeywords: ['legacy', 'mainframe', 'cobol', 'migration', 'rewrite', 'monolith', 'end-of-life'],
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

    // eslint-disable-next-line no-console
    console.log(
      `Seed complete: ${Object.keys(SEED_USERS).length} users, config v${config.version}, ${SAMPLE_SOWS.length} estimates, ${SEED_PROMPTS.length} prompts.`,
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
