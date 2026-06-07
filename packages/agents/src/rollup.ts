import type { MenuItem, RoleLineItem, RoleKind } from '@repo/shared';

// ─── WS17-01: Roll-up calculator ─────────────────────────────────────────────

export type RoleTotal = {
  role: RoleKind;
  totalBaseHours: number;
  totalTaxedHours: number;
};

export type RollupResult = {
  perRole: RoleTotal[];
  grandTotalBaseHours: number;
  grandTotalTaxedHours: number;
};

/**
 * Compute totals per role + grand total across enabled menu items.
 * Pure function.
 */
export function computeRollup(menuItems: MenuItem[]): RollupResult {
  const enabledItems = menuItems.filter((m) => m.enabled);
  const roleMap = new Map<RoleKind, { base: number; taxed: number }>();

  for (const item of enabledItems) {
    for (const li of item.lineItems) {
      const current = roleMap.get(li.role) ?? { base: 0, taxed: 0 };
      roleMap.set(li.role, {
        base: current.base + li.baseHours,
        taxed: current.taxed + li.taxedHours,
      });
    }
  }

  const perRole: RoleTotal[] = Array.from(roleMap.entries()).map(([role, totals]) => ({
    role,
    totalBaseHours: totals.base,
    totalTaxedHours: totals.taxed,
  }));

  const grandTotalBaseHours = perRole.reduce((sum, r) => sum + r.totalBaseHours, 0);
  const grandTotalTaxedHours = perRole.reduce((sum, r) => sum + r.totalTaxedHours, 0);

  return { perRole, grandTotalBaseHours, grandTotalTaxedHours };
}

// ─── WS17-02: Per-role WBS projection ────────────────────────────────────────

export type RoleProjection = {
  role: RoleKind;
  items: Array<{
    menuItemId: string;
    title: string;
    taxonomyKey: string;
    baseHours: number;
    taxedHours: number;
    enabled: boolean;
    notes?: string;
  }>;
  total: RoleTotal;
};

/**
 * Generate per-role projections: same menu items, role-specific line items.
 * Four projections (DEV/QA/PM/BA), sharing item identity but distinct hours.
 */
export function computeRoleProjections(menuItems: MenuItem[]): RoleProjection[] {
  const roles: RoleKind[] = ['DEV', 'QA', 'PM', 'BA'];

  return roles.map((role) => {
    const items = menuItems.map((m) => {
      const li = m.lineItems.find((l) => l.role === role);
      return {
        menuItemId: m.id,
        title: m.title,
        taxonomyKey: m.taxonomyKey,
        baseHours: li?.baseHours ?? 0,
        taxedHours: li?.taxedHours ?? 0,
        enabled: m.enabled,
        notes: li?.notes,
      };
    });

    const enabledItems = items.filter((i) => i.enabled);
    const totalBase = enabledItems.reduce((s, i) => s + i.baseHours, 0);
    const totalTaxed = enabledItems.reduce((s, i) => s + i.taxedHours, 0);

    return {
      role,
      items,
      total: { role, totalBaseHours: totalBase, totalTaxedHours: totalTaxed },
    };
  });
}

// ─── WS17-03: Cost-optimisation toggle API ───────────────────────────────────

/**
 * Toggle a menu item enabled/disabled and recompute projections + totals.
 * Returns updated menu items, projections, and rollup.
 */
export function toggleMenuItem(
  menuItems: MenuItem[],
  itemId: string,
  enabled: boolean,
): {
  menuItems: MenuItem[];
  projections: RoleProjection[];
  rollup: RollupResult;
} {
  const updated = menuItems.map((m) =>
    m.id === itemId ? { ...m, enabled } : m,
  );

  return {
    menuItems: updated,
    projections: computeRoleProjections(updated),
    rollup: computeRollup(updated),
  };
}
