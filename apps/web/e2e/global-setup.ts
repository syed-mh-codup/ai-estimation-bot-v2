import path from 'node:path';
import { createHash } from 'node:crypto';
import { config as loadEnv } from 'dotenv';
import bcrypt from 'bcryptjs';
// Import the generated Prisma client directly to avoid workspace-alias
// resolution issues in Playwright's loader.
import { PrismaClient } from '../../../packages/db/src/generated/client/index.js';
import { SEED_PROMPTS } from '../../../packages/db/src/seed-prompts';

// Playwright's setup runs outside Next, so load the same env the dev server uses.
loadEnv({ path: path.resolve(__dirname, '../.env.local') });

// e2e MUST run against an isolated database — never the dev/main DB. Fail loudly
// if TEST_DATABASE_URL is missing rather than silently wiping real data.
const TEST_DB_URL = process.env['TEST_DATABASE_URL'];
if (!TEST_DB_URL) {
  throw new Error(
    'TEST_DATABASE_URL is not set — refusing to run e2e against the dev database. ' +
      'Set it in apps/web/.env.local to a separate database (or a Neon test branch).',
  );
}

export const TEST_USERS = {
  admin: { email: 'e2e-admin@example.com', password: 'e2e-admin-pw', role: 'ADMIN' as const },
  estimator: {
    email: 'e2e-estimator@example.com',
    password: 'e2e-estimator-pw',
    role: 'ESTIMATOR' as const,
  },
  // Dedicated throwaway user whose role the WS24-01 list test flips. Kept
  // separate from admin/estimator so the role-change test can't corrupt
  // fixtures that other specs depend on. The upsert below resets its role each
  // run.
  roleTarget: {
    email: 'e2e-roletarget@example.com',
    password: 'e2e-roletarget-pw',
    role: 'ESTIMATOR' as const,
  },
  // A second throwaway user, used ONLY by the live-session-invalidation test
  // (which logs this user in and watches their role change without re-login).
  // Distinct from roleTarget so the two mutating tests don't collide given the
  // single global-setup run.
  liveInvalidation: {
    email: 'e2e-liveinvalidation@example.com',
    password: 'e2e-liveinvalidation-pw',
    role: 'ESTIMATOR' as const,
  },
  // Owns nothing, and no other spec touches its role — so it stays a reliable
  // stand-in for "a signed-in user who is not the owner" in the delete-guard
  // test. Reusing `roleTarget` there would race the admin role-flip spec.
  nonOwner: {
    email: 'e2e-nonowner@example.com',
    password: 'e2e-nonowner-pw',
    role: 'ESTIMATOR' as const,
  },
  // Disabled/re-enabled by the admin spec, and signed in during it to prove a
  // LIVE session is ended (not merely the next login). Its own user so nothing
  // else races the disable. global-setup clears disabledAt each run.
  disableTarget: {
    email: 'e2e-disabletarget@example.com',
    password: 'e2e-disabletarget-pw',
    role: 'ESTIMATOR' as const,
  },
  // Receives estimates in the reassignment spec.
  reassignTarget: {
    email: 'e2e-reassigntarget@example.com',
    password: 'e2e-reassigntarget-pw',
    role: 'ESTIMATOR' as const,
  },
  // The profile spec changes this user's password and name, so it must be one
  // no other spec logs in as — specs run in parallel and would race a
  // mid-flight credential change. global-setup resets both each run.
  profile: {
    email: 'e2e-profile@example.com',
    password: 'e2e-profile-pw',
    role: 'ESTIMATOR' as const,
  },
};

/** What the profile spec changes the password to. Reset by global-setup. */
export const PROFILE_NEW_PASSWORD = 'e2e-profile-changed-pw';

// A deterministic, pre-seeded estimate so list/detail tests (WS21-02) don't
// depend on the create flow (WS22-01).
export const SEED_ESTIMATE = {
  id: 'e2e-seed-estimate',
  title: 'E2E Seeded Estimate',
  sowText: 'A seeded statement of work used by end-to-end tests.',
};

// A pre-costed estimate (REVIEW + Menu Card) so the WS23 refinement UI can be
// tested without a (credit-gated) run. Menu item ids are fixed so tests target
// them. Reset fully each run since the test toggles/edits/finalises it.
export const COSTED_ESTIMATE = {
  id: 'e2e-costed-estimate',
  title: 'E2E Costed Estimate',
  itemIds: ['e2e-mi-1', 'e2e-mi-2'],
};

export default async function globalSetup() {
  const prisma = new PrismaClient({ datasources: { db: { url: TEST_DB_URL } } });
  try {
    const users: Record<string, { id: string }> = {};
    for (const [key, user] of Object.entries(TEST_USERS)) {
      const hash = await bcrypt.hash(user.password, 12);
      // `name` is reset too, not just on create — the profile spec renames its
      // user, and the next run must start from a known value.
      users[key] = await prisma.user.upsert({
        where: { email: user.email },
        update: { hash, role: user.role, name: user.email, disabledAt: null, passwordChangedAt: null },
        create: { email: user.email, hash, role: user.role, name: user.email },
      });
    }

    // Estimate.configVersion is required, so an active config must exist before
    // any estimate (seeded here or created via the UI) can be persisted.
    // Reset to a clean single active v1 each run: the WS24-04 config test
    // creates new versions, so deleting+recreating keeps the starting version
    // deterministic (and the single-active invariant intact).
    await prisma.estimationConfig.deleteMany({});
    const config = await prisma.estimationConfig.create({
      data: {
        version: 1,
        active: true,
        complexityRules: {},
        pmCommunicationTaxPct: 15,
        baCommunicationTaxPct: 10,
        qaRegressionBufferPct: 20,
        hiddenWorkBlocksFinalise: false,
        infraBaseline: {},
        changeReason: 'e2e bootstrap',
      },
    });

    // The WS24-02 MCP test adds connectors; reset so it starts from empty.
    await prisma.mcpConnector.deleteMany({});

    // A dedicated preset for the WS24-03 edit test. Reset to a clean active v1
    // each run (the edit test creates new versions). Scoped to this id so it
    // never touches the real 45-preset library in the shared DB.
    await prisma.presetVersion.deleteMany({ where: { presetId: 'E2E-PRESET' } });
    await prisma.preset.upsert({ where: { id: 'E2E-PRESET' }, update: {}, create: { id: 'E2E-PRESET' } });
    const e2ePreset = await prisma.presetVersion.create({
      data: {
        presetId: 'E2E-PRESET',
        version: 1,
        active: true,
        category: 'E2E',
        name: 'E2E Seeded Preset',
        description: 'A preset used by the WS24-03 admin test.',
        // One dev figure; the flags are reference metadata. Legacy be/fe left
        // unset (nullable) exactly as the pipeline now writes them.
        devHours: 30,
        touchesBackend: true,
        touchesFrontend: true,
        platforms: ['web'],
        reqType: 'Integration',
        keywords: ['e2e'],
        userStoryTags: [],
        projectSizeFit: ['SMB'],
        integrationCount: 1,
        dataVolume: 'LOW',
        phase: 'CORE',
        requires: [],
        blocks: [],
        canParallel: true,
        aiAssist: 'LOW',
        risk: 'LOW',
        spikeNeeded: false,
        notes: '',
        changeReason: 'e2e bootstrap',
      },
    });

    // Give it a vector so the edit test can prove saving doesn't de-index the
    // preset. `queryPresetsByVector` filters on `embedding IS NOT NULL`, so a
    // preset that loses its vector silently stops matching anything — which is
    // exactly what savePreset used to do on every edit. Raw SQL because Prisma
    // can't write an Unsupported("vector") column.
    await prisma.$executeRawUnsafe(
      `UPDATE "PresetVersion" SET embedding = $1::vector, "embeddingText" = $2 WHERE id = $3`,
      `[${new Array(1536).fill(0).map((_, i) => (i === 3 ? 1 : 0)).join(',')}]`,
      'e2e seeded embedding text',
      e2ePreset.id,
    );

    // Prompts: reset to a clean active v1 each run. The WS24-05 prompt editor
    // test creates new versions, so delete+recreate keeps the version
    // deterministic and the single-active invariant intact.
    // Seed the SAME required prompt set as production (all 9 agent kinds), so
    // the test DB's required data matches main. Delete+recreate at v1 each run
    // keeps version-number assertions deterministic.
    await prisma.promptVersion.deleteMany({});
    await prisma.prompt.deleteMany({});
    for (const p of SEED_PROMPTS) {
      await prisma.prompt.create({ data: { kind: p.kind } });
      await prisma.promptVersion.create({
        data: {
          kind: p.kind,
          version: 1,
          body: p.body,
          modelString: p.modelString,
          active: true,
          changeReason: 'e2e bootstrap',
        },
      });
    }

    await prisma.estimate.upsert({
      where: { id: SEED_ESTIMATE.id },
      update: {},
      create: {
        id: SEED_ESTIMATE.id,
        title: SEED_ESTIMATE.title,
        sowText: SEED_ESTIMATE.sowText,
        sowHash: createHash('sha256').update(SEED_ESTIMATE.sowText).digest('hex'),
        status: 'DRAFT',
        configVersion: config.version,
        taxonomyVersionsPinned: {},
        promptVersionsPinned: {},
        modelConfig: {},
        agentState: {},
        ownerId: users['estimator']!.id,
      },
    });

    // The refine spec finalises this estimate, which now feeds the preset
    // library. Promotion is idempotent per (estimate, menu item), so it can't
    // duplicate — but the presets it minted last run would linger, so clear them
    // and start from a clean library each time.
    const promoted = await prisma.presetVersion.findMany({
      where: { sourceEstimateId: COSTED_ESTIMATE.id },
      select: { presetId: true },
    });
    if (promoted.length > 0) {
      const ids = [...new Set(promoted.map((p) => p.presetId))];
      await prisma.presetVersion.deleteMany({ where: { presetId: { in: ids } } });
      await prisma.preset.deleteMany({ where: { id: { in: ids } } });
    }

    // Pre-costed estimate for WS23. Full reset each run (the test mutates it).
    await prisma.roleLineItem.deleteMany({
      where: { menuItemId: { in: COSTED_ESTIMATE.itemIds } },
    });
    await prisma.menuItem.deleteMany({ where: { estimateId: COSTED_ESTIMATE.id } });
    await prisma.estimate.upsert({
      where: { id: COSTED_ESTIMATE.id },
      update: { status: 'REVIEW', narrative: ['Seeded narrative.'], assumptions: ['Seeded assumption.'] },
      create: {
        id: COSTED_ESTIMATE.id,
        title: COSTED_ESTIMATE.title,
        sowText: 'A pre-costed estimate for refinement-UI tests.',
        sowHash: createHash('sha256').update(COSTED_ESTIMATE.id).digest('hex'),
        status: 'REVIEW',
        configVersion: config.version,
        complexityScore: 3,
        taxonomyVersionsPinned: {},
        promptVersionsPinned: {},
        modelConfig: {},
        narrative: ['Seeded narrative.'],
        assumptions: ['Seeded assumption.'],
        agentState: {},
        ownerId: users['estimator']!.id,
      },
    });
    const baseByRole = { DEV: 30, QA: 10, PM: 5, BA: 5 } as const;
    const taxed = { DEV: 30, QA: 12, PM: 6, BA: 6 } as const; // matches seeded config %s
    for (const [idx, itemId] of COSTED_ESTIMATE.itemIds.entries()) {
      await prisma.menuItem.create({
        data: {
          id: itemId,
          estimateId: COSTED_ESTIMATE.id,
          taxonomyKey: `e2e.item-${idx + 1}`,
          title: `Costed item ${idx + 1}`,
          enabled: true,
          lineItems: {
            create: (['DEV', 'QA', 'PM', 'BA'] as const).map((role) => ({
              role,
              baseHours: baseByRole[role],
              taxedHours: taxed[role],
              edited: false,
            })),
          },
        },
      });
    }
  } finally {
    await prisma.$disconnect();
  }
}
