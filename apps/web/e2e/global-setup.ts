import path from 'node:path';
import { createHash } from 'node:crypto';
import { config as loadEnv } from 'dotenv';
import bcrypt from 'bcryptjs';
// Import the generated Prisma client directly to avoid workspace-alias
// resolution issues in Playwright's loader.
import { PrismaClient } from '../../../packages/db/src/generated/client/index.js';

// Playwright's setup runs outside Next, so load the same env the dev server uses.
loadEnv({ path: path.resolve(__dirname, '../.env.local') });

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
};

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
  const prisma = new PrismaClient();
  try {
    const users: Record<string, { id: string }> = {};
    for (const [key, user] of Object.entries(TEST_USERS)) {
      const hash = await bcrypt.hash(user.password, 12);
      users[key] = await prisma.user.upsert({
        where: { email: user.email },
        update: { hash, role: user.role },
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
    await prisma.presetVersion.create({
      data: {
        presetId: 'E2E-PRESET',
        version: 1,
        active: true,
        category: 'E2E',
        name: 'E2E Seeded Preset',
        description: 'A preset used by the WS24-03 admin test.',
        beHours: 20,
        feHours: 10,
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

    // Prompts: reset to a clean active v1 each run. The WS24-05 prompt editor
    // test creates new versions, so delete+recreate keeps the version
    // deterministic and the single-active invariant intact.
    await prisma.promptVersion.deleteMany({});
    await prisma.prompt.deleteMany({});
    for (const kind of ['LIBRARIAN', 'ARCHITECT'] as const) {
      await prisma.prompt.create({ data: { kind } });
      await prisma.promptVersion.create({
        data: {
          kind,
          version: 1,
          body: `Seeded ${kind} prompt body.`,
          modelString: 'anthropic/claude-3.5-sonnet',
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
