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
