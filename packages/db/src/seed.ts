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
    const config = await prisma.estimationConfig.upsert({
      where: { version: 1 },
      update: { active: true },
      create: {
        version: 1,
        active: true,
        complexityRules: {
          thresholds: { simple: 0, moderate: 40, complex: 100 },
          weights: { integrationCount: 5, dataVolume: 3, risk: 4 },
        },
        pmCommunicationTaxPct: 15,
        baCommunicationTaxPct: 10,
        qaRegressionBufferPct: 20,
        infraBaseline: { devops: 24, environments: ['dev', 'staging', 'prod'] },
        changeReason: 'bootstrap seed',
      },
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

    // eslint-disable-next-line no-console
    console.log(
      `Seed complete: ${Object.keys(SEED_USERS).length} users, config v${config.version}, ${SAMPLE_SOWS.length} estimates.`,
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
