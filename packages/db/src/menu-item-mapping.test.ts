import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { MenuItemSchema, RoleLineItemSchema, type MenuItem } from '@repo/shared';
import { PrismaClient } from './generated/client/index.js';
import { toMenuItem, toMenuItemCreateData } from './menu-item-mapping.js';

/**
 * AEH-227. The mapping between a persisted card and the domain shape.
 *
 * What these guard is narrow and specific: `MenuItem.meta` / `RoleLineItem.meta`
 * hold every domain field with no column of its own, and until this work
 * NOTHING in the repo read either column. All three read paths hardcoded
 * `requirementIds: []`, `toggleable: true`, `notSafelyRemovable: false`,
 * `thinSlice: false`, `aiAssistApplied: false`, `dependsOn: []`,
 * `anchorPresetIds: []`. Every one of those is a DEFAULT, so a mapper that
 * fabricates them is indistinguishable from one that reads them — unless the
 * fixture deliberately sets every field to a NON-default value. That is why the
 * card below looks perverse: `toggleable: false`, `thinSlice: true`, a populated
 * `dependsOn`. Use default values here and this file passes against the exact
 * bug it exists to catch.
 */

const DB_URL =
  process.env['DATABASE_URL'] ??
  'postgresql://postgres:postgres@localhost:5433/ai_estimation?schema=public';
const db = new PrismaClient({ datasources: { db: { url: DB_URL } } });

let userId = '';
let estimateId = '';

/** Every field set AWAY from its schema default. See the note above. */
const richCard = (): MenuItem =>
  MenuItemSchema.parse({
    id: 'MC-STOREFRONT-CHECKOUT',
    taxonomyKey: 'storefront.checkout',
    category: 'Frontend',
    phase: 'Core',
    title: 'Checkout extension',
    enabled: false,
    injected: true,
    sourcePresetId: 'P28',
    matchScore: 0.91,
    requirementIds: ['REQ001', 'REQ002'],
    toggleable: false,
    notSafelyRemovable: true,
    thinSlice: true,
    lineItems: [
      RoleLineItemSchema.parse({
        id: 'DEV-REQ001-01',
        role: 'DEV',
        title: 'Volume pricing tiers',
        requirementId: 'REQ001',
        baseHours: 3.5,
        taxedHours: 3.5,
        complexity: 'high',
        aiAssistApplied: true,
        dependsOn: ['DEV-REQ001-00'],
        anchorPresetIds: ['P28', 'P31'],
        notes: 'anchored on the B2B contextual pricing preset',
        edited: true,
        touchesFrontend: true,
        touchesBackend: true,
      }),
    ],
  });

beforeAll(async () => {
  await db.$connect();
  const user = await db.user.create({
    data: { email: `mapping-${Date.now()}@example.com`, hash: 'x', role: 'ESTIMATOR' },
  });
  userId = user.id;
  const est = await db.estimate.create({
    data: {
      title: 'Mapping round trip',
      sowText: 'x',
      status: 'REVIEW',
      configVersion: 1,
      narrative: [],
      assumptions: [],
      agentState: {},
      ownerId: userId,
    },
  });
  estimateId = est.id;
});

afterAll(async () => {
  await db.estimate.deleteMany({ where: { ownerId: userId } });
  await db.user.delete({ where: { id: userId } }).catch(() => {});
  await db.$disconnect();
});

describe('AEH-227: row <-> domain round trip', () => {
  it('preserves every meta-borne field through persist and read-back', async () => {
    const original = richCard();
    const created = await db.menuItem.create({
      data: toMenuItemCreateData(original, estimateId),
      include: { lineItems: true },
    });

    const readBack = toMenuItem(created);

    // The envelope fields — the ones every reader used to fabricate.
    expect(readBack.requirementIds).toEqual(['REQ001', 'REQ002']);
    expect(readBack.toggleable).toBe(false);
    expect(readBack.notSafelyRemovable).toBe(true);
    expect(readBack.thinSlice).toBe(true);

    const [line] = readBack.lineItems;
    expect(line?.aiAssistApplied).toBe(true);
    expect(line?.dependsOn).toEqual(['DEV-REQ001-00']);
    expect(line?.anchorPresetIds).toEqual(['P28', 'P31']);
    expect(line?.complexity).toBe('high');
    expect(line?.requirementId).toBe('REQ001');

    // Columns.
    expect(readBack.injected).toBe(true);
    expect(readBack.enabled).toBe(false);
    expect(readBack.category).toBe('Frontend');
    expect(readBack.phase).toBe('Core');
    expect(readBack.matchScore).toBeCloseTo(0.91);
    expect(line?.touchesFrontend).toBe(true);
    expect(line?.touchesBackend).toBe(true);
    expect(line?.edited).toBe(true);
  });

  it('identifies a card by its row id and a line item by its semantic id', async () => {
    const original = richCard();
    const created = await db.menuItem.create({
      data: toMenuItemCreateData(original, estimateId),
      include: { lineItems: true },
    });
    const readBack = toMenuItem(created);

    // The card's id is the cuid: `run-estimate` never persists the Architect's
    // MC-<DOMAIN>-<SLUG>, and promotion keys `sourceMenuItemId` on the row id.
    expect(readBack.id).toBe(created.id);
    expect(readBack.id).not.toBe('MC-STOREFRONT-CHECKOUT');

    // A line item keeps its SEMANTIC id, because `dependsOn` references items
    // by that name — reading the row cuid here would leave the graph dangling.
    expect(readBack.lineItems[0]?.id).toBe('DEV-REQ001-01');
    expect(readBack.lineItems[0]?.dependsOn).toEqual(['DEV-REQ001-00']);
  });

  it('falls back to schema defaults for a row with no meta at all', () => {
    // Editor-created and pre-envelope rows have meta = null. Agreed behaviour:
    // they are indistinguishable from a row whose values genuinely equal the
    // defaults, and that is accepted rather than papered over.
    const readBack = toMenuItem({
      id: 'cuid-legacy',
      estimateId,
      taxonomyKey: 'legacy.card',
      category: null,
      phase: null,
      sourcePresetId: null,
      matchScore: null,
      title: 'Hand-entered card',
      enabled: true,
      injected: false,
      sectionId: null,
      order: 0,
      meta: null,
      lineItems: [
        {
          id: 'cuid-line',
          menuItemId: 'cuid-legacy',
          role: 'QA',
          title: null,
          baseHours: 2,
          taxedHours: 2.4,
          notes: null,
          edited: false,
          touchesFrontend: false,
          touchesBackend: false,
          meta: null,
        },
      ],
    });

    expect(readBack.requirementIds).toEqual([]);
    expect(readBack.toggleable).toBe(true);
    expect(readBack.thinSlice).toBe(false);
    expect(readBack.lineItems[0]?.dependsOn).toEqual([]);
    expect(readBack.lineItems[0]?.id).toBeUndefined();
  });

  it('lets a column win when meta carries a stale copy of the same name', () => {
    // Rule 1 of the mapping: columns are authoritative. A row written before a
    // field was promoted from meta to a column would otherwise resurrect the
    // stale value.
    const readBack = toMenuItem({
      id: 'cuid-x',
      estimateId,
      taxonomyKey: 'x.y',
      category: null,
      phase: null,
      sourcePresetId: null,
      matchScore: null,
      title: 'Column wins',
      enabled: true,
      injected: true,
      sectionId: null,
      order: 0,
      meta: { title: 'stale title from meta', enabled: false, injected: false, requirementIds: ['REQ9'] },
      lineItems: [],
    });

    expect(readBack.title).toBe('Column wins');
    expect(readBack.enabled).toBe(true);
    expect(readBack.injected).toBe(true);
    // ...while a genuinely meta-only field still comes through.
    expect(readBack.requirementIds).toEqual(['REQ9']);
  });
});
