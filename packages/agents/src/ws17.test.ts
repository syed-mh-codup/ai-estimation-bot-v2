import { describe, it, expect } from 'vitest';
import {
  computeRollup,
} from './rollup';
import { MenuItemSchema, type MenuItem } from '@repo/shared';

function makeMenuItem(
  id: string,
  enabled = true,
  devH = 40,
  qaH = 15,
  pmH = 8,
  baH = 10,
): MenuItem {
  const lineItems = [
    { role: 'DEV', baseHours: devH, taxedHours: devH, provenance: 'CREW' },
    { role: 'QA', baseHours: qaH, taxedHours: Math.round(qaH * 1.2), provenance: 'CREW' },
    { role: 'PM', baseHours: pmH, taxedHours: Math.round(pmH * 1.15), provenance: 'CREW' },
    { role: 'BA', baseHours: baH, taxedHours: Math.round(baH * 1.1), provenance: 'CREW' },
  ];
  return MenuItemSchema.parse({ id, taxonomyKey: `feature.${id}`, title: id, enabled, lineItems });
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

// ─── WS17-03: Toggle API ─────────────────────────────────────────────────────

describe('WS17-03: Toggle menu item → updated projections + totals', () => {
  // The toggle itself is a server action (setItemEnabled); what belongs here is
  // that the rollup and projections follow `enabled`.
  it('disabling an item removes it from totals', () => {
    const items = [makeMenuItem('item-a'), makeMenuItem('item-b')];

    const toggled = items.map((m) => (m.id === 'item-b' ? { ...m, enabled: false } : m));
    const rollup = computeRollup(toggled);

    const devTotal = rollup.perRole.find((r) => r.role === 'DEV');
    expect(devTotal?.totalBaseHours).toBe(40); // only item-a
  });

  it('re-enabling an item adds it back to totals', () => {
    const items = [makeMenuItem('item-a'), makeMenuItem('item-b', false)];

    const toggled = items.map((m) => (m.id === 'item-b' ? { ...m, enabled: true } : m));
    const rollup = computeRollup(toggled);

    const devTotal = rollup.perRole.find((r) => r.role === 'DEV');
    expect(devTotal?.totalBaseHours).toBe(80); // both items
  });
});
