// BLOCKED-CREDENTIAL: Full integration test requires GOOGLE_SERVICE_ACCOUNT_JSON.
// All tests use StubSheetsProvider.

import type { ISheetsProvider, SpreadsheetTab } from '@repo/providers';
import type { MenuItem, RoleKind } from '@repo/shared';
import { computeRollup, computeRoleProjections } from './rollup';

// ─── WS19-02: Tab structure ───────────────────────────────────────────────────

const ROLE_COLUMNS: Array<string | number> = ['Item', 'Taxonomy Key', 'Base Hours', 'Taxed Hours', 'Notes'];
const ROLLUP_COLUMNS: Array<string | number> = ['Role', 'Total Base Hours', 'Total Taxed Hours'];

/**
 * Build a per-role tab from menu items.
 */
function buildRoleTab(role: RoleKind, menuItems: MenuItem[]): SpreadsheetTab {
  const rows: Array<Array<string | number>> = [ROLE_COLUMNS];

  for (const item of menuItems) {
    if (!item.enabled) continue;
    const li = item.lineItems.find((l) => l.role === role);
    if (!li) continue;

    rows.push([
      item.title,
      item.taxonomyKey,
      li.baseHours,
      li.taxedHours,
      li.notes ?? '',
    ]);
  }

  return { title: role, rows };
}

/**
 * Build a roll-up summary tab.
 */
function buildRollupTab(menuItems: MenuItem[]): SpreadsheetTab {
  const rollup = computeRollup(menuItems);
  const rows: Array<Array<string | number>> = [ROLLUP_COLUMNS];

  for (const roleTotal of rollup.perRole) {
    rows.push([roleTotal.role, roleTotal.totalBaseHours, roleTotal.totalTaxedHours]);
  }

  rows.push(['TOTAL', rollup.grandTotalBaseHours, rollup.grandTotalTaxedHours]);

  return { title: 'Roll-Up', rows };
}

/**
 * Build all tabs for a spreadsheet export.
 */
export function buildExportTabs(menuItems: MenuItem[]): SpreadsheetTab[] {
  const roles: RoleKind[] = ['DEV', 'QA', 'PM', 'BA'];
  return [
    ...roles.map((role) => buildRoleTab(role, menuItems)),
    buildRollupTab(menuItems),
  ];
}

// ─── WS19-01 + WS19-02: Export pipeline ──────────────────────────────────────

export type SheetsExportResult = {
  spreadsheetId: string;
  url: string;
  tabCount: number;
};

/**
 * Export an estimate to Google Sheets.
 * Creates a new spreadsheet or updates the existing one (idempotent by estimateId).
 * BLOCKED-CREDENTIAL: Uses StubSheetsProvider when Google SA not configured.
 */
export async function exportToSheets(
  estimateId: string,
  estimateTitle: string,
  menuItems: MenuItem[],
  sheetsProvider: ISheetsProvider,
): Promise<SheetsExportResult> {
  const tabs = buildExportTabs(menuItems);

  // WS19-03: Idempotent — update existing if it exists
  const existingId = await sheetsProvider.getSpreadsheetId(estimateId);

  const result = existingId
    ? await sheetsProvider.updateSpreadsheet(existingId, tabs)
    : await sheetsProvider.createSpreadsheet(`${estimateTitle} — Estimate`, tabs);

  return {
    spreadsheetId: result.spreadsheetId,
    url: result.url,
    tabCount: tabs.length,
  };
}
