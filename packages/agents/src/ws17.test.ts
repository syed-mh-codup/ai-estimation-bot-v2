import { describe, it, expect } from 'vitest';
import {
  computeRollup,
  computeRoleProjections,
  toggleMenuItem,
} from './rollup';
import type { MenuItem, RoleLineItem } from '@repo/shared';

function makeMenuItem(
  id: string,
  enabled = true,
  devH = 40,
  qaH = 15,
  pmH = 8,
  baH = 10,
): MenuItem {
  const lineItems: RoleLineItem[] = [
    { role: 'DEV', baseHours: devH, taxedHours: devH, edited: false },
    { role: 'QA', baseHours: qaH, taxedHours: Math.round(qaH * 1.2), edited: false },
    { role: 'PM', baseHours: pmH, taxedHours: Math.round(pmH * 1.15), edited: false },
    { role: 'BA', baseHours: baH, taxedHours: Math.round(baH * 1.1), edited: false },
  ];
  return { id, taxonomyKey: `feature.${id}`, title: id, enabled, lineItems };
}

// ─── WS17-01: Roll-up calculator ─────────────────────────────────────────────

describe('WS17-01: Roll-up calculator — totals recompute when items toggled', () => {
  it('sums baseHours + taxedHours per role across enabled items', () => {
    const items = [makeMenuItem('item-a'), makeMenuItem('item-b')];
    const rollup = computeRollup(items);

    const devTotal = rollup.perRole.find((r) => r.role === 'DEV');
    expect(devTotal?.totalBaseHours).toBe(80); // 40 + 40
    expect(rollup.grandTotalBaseHours).toBeGreaterThan(0);
  });

  it('excludes disabled items from totals', () => {
    const items = [
      makeMenuItem('enabled-item', true),
      makeMenuItem('disabled-item', false),
    ];
    const rollup = computeRollup(items);

    const devTotal = rollup.perRole.find((r) => r.role === 'DEV');
    expect(devTotal?.totalBaseHours).toBe(40); // only 1 enabled item
  });

  it('returns zero totals for all-disabled items', () => {
    const items = [
      makeMenuItem('item-a', false),
      makeMenuItem('item-b', false),
    ];
    const rollup = computeRollup(items);
    expect(rollup.grandTotalBaseHours).toBe(0);
    expect(rollup.grandTotalTaxedHours).toBe(0);
  });

  it('grand total equals sum of per-role totals', () => {
    const items = [makeMenuItem('item-a'), makeMenuItem('item-b'), makeMenuItem('item-c')];
    const rollup = computeRollup(items);

    const sumOfRoles = rollup.perRole.reduce((s, r) => s + r.totalBaseHours, 0);
    expect(rollup.grandTotalBaseHours).toBe(sumOfRoles);
  });
});

// ─── WS17-02: Per-role WBS projection ────────────────────────────────────────

describe('WS17-02: Per-role WBS projection — four projections sharing item identity', () => {
  it('returns exactly 4 projections (DEV/QA/PM/BA)', () => {
    const items = [makeMenuItem('item-a')];
    const projections = computeRoleProjections(items);
    expect(projections.length).toBe(4);
    const roles = projections.map((p) => p.role);
    expect(roles).toContain('DEV');
    expect(roles).toContain('QA');
    expect(roles).toContain('PM');
    expect(roles).toContain('BA');
  });

  it('projections share the same menu item IDs', () => {
    const items = [makeMenuItem('item-x'), makeMenuItem('item-y')];
    const projections = computeRoleProjections(items);

    for (const proj of projections) {
      const ids = proj.items.map((i) => i.menuItemId);
      expect(ids).toContain('item-x');
      expect(ids).toContain('item-y');
    }
  });

  it('DEV and QA projections have distinct hours for the same item', () => {
    const items = [makeMenuItem('item-a', true, 40, 15)];
    const projections = computeRoleProjections(items);

    const devHours = projections.find((p) => p.role === 'DEV')!.items[0]!.baseHours;
    const qaHours = projections.find((p) => p.role === 'QA')!.items[0]!.baseHours;

    expect(devHours).toBe(40);
    expect(qaHours).toBe(15);
    expect(devHours).not.toBe(qaHours);
  });

  it('surfaces every line item when a role has multiple <=4h atomic items (FOUR-HOUR RULE decomposition)', () => {
    const item: MenuItem = {
      id: 'item-decomposed',
      taxonomyKey: 'feature.decomposed',
      title: 'Decomposed Feature',
      enabled: true,
      lineItems: [
        { id: 'DEV-REQ001-01', role: 'DEV', title: 'Schema', baseHours: 3, taxedHours: 3, edited: false },
        { id: 'DEV-REQ001-02', role: 'DEV', title: 'Happy path', baseHours: 4, taxedHours: 4, edited: false },
        { id: 'QA-REQ001-01', role: 'QA', title: 'Test plan', baseHours: 2, taxedHours: 2.4, edited: false },
      ],
    };
    const projections = computeRoleProjections([item]);

    const devProj = projections.find((p) => p.role === 'DEV')!;
    expect(devProj.items).toHaveLength(2);
    expect(devProj.items.map((i) => i.lineItemId)).toEqual(['DEV-REQ001-01', 'DEV-REQ001-02']);
    expect(devProj.total.totalBaseHours).toBe(7);

    const qaProj = projections.find((p) => p.role === 'QA')!;
    expect(qaProj.items).toHaveLength(1);

    const rollup = computeRollup([item]);
    const devTotal = rollup.perRole.find((r) => r.role === 'DEV');
    expect(devTotal?.totalBaseHours).toBe(7);
  });
});

// ─── WS17-03: Toggle API ─────────────────────────────────────────────────────

describe('WS17-03: Toggle menu item → updated projections + totals', () => {
  it('disabling an item removes it from totals', () => {
    const items = [makeMenuItem('item-a'), makeMenuItem('item-b')];

    const { rollup } = toggleMenuItem(items, 'item-b', false);

    const devTotal = rollup.perRole.find((r) => r.role === 'DEV');
    expect(devTotal?.totalBaseHours).toBe(40); // only item-a
  });

  it('re-enabling an item adds it back to totals', () => {
    const items = [makeMenuItem('item-a'), makeMenuItem('item-b', false)];

    const { rollup } = toggleMenuItem(items, 'item-b', true);

    const devTotal = rollup.perRole.find((r) => r.role === 'DEV');
    expect(devTotal?.totalBaseHours).toBe(80); // both items
  });

  it('toggle returns updated per-role projections', () => {
    const items = [makeMenuItem('item-a'), makeMenuItem('item-b')];

    const { projections } = toggleMenuItem(items, 'item-a', false);

    const devProj = projections.find((p) => p.role === 'DEV')!;
    const disabledItem = devProj.items.find((i) => i.menuItemId === 'item-a');
    expect(disabledItem?.enabled).toBe(false);
  });
});
