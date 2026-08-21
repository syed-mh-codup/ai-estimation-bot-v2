import type { MenuItem, RoleKind } from '@repo/shared';

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
  /** One row per atomic line item — a menu card's role bucket can hold several <=4h items now. */
  items: Array<{
    menuItemId: string;
    /** The line item's own id (e.g. DEV-REQ003-04), if it carries one. */
    lineItemId?: string;
    menuItemTitle: string;
    /** The line item's own short description; falls back to the menu item's title for legacy/injected rows without one. */
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
 * Generate per-role projections: one row per atomic line item (not per menu
 * item) — a menu card's role bucket can hold several <=4h line items since
 * the FOUR-HOUR RULE decomposition. Four projections (DEV/QA/PM/BA).
 */
export function computeRoleProjections(menuItems: MenuItem[]): RoleProjection[] {
  const roles: RoleKind[] = ['DEV', 'QA', 'PM', 'BA'];

  return roles.map((role) => {
    const items = menuItems.flatMap((m) =>
      m.lineItems
        .filter((li) => li.role === role)
        .map((li) => ({
          menuItemId: m.id,
          lineItemId: li.id,
          menuItemTitle: m.title,
          title: li.title ?? m.title,
          taxonomyKey: m.taxonomyKey,
          baseHours: li.baseHours,
          taxedHours: li.taxedHours,
          enabled: m.enabled,
          notes: li.notes,
        })),
    );

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
