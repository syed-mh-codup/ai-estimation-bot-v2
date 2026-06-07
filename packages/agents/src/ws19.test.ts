// BLOCKED-CREDENTIAL: Integration test with real Google Sheets API requires
// GOOGLE_SERVICE_ACCOUNT_JSON. All tests use StubSheetsProvider.

import { describe, it, expect, vi } from 'vitest';
import { buildExportTabs, exportToSheets } from './sheets-export';
import { StubSheetsProvider } from '@repo/providers';
import type { MenuItem, RoleLineItem } from '@repo/shared';

function makeMenuItem(id: string, enabled = true): MenuItem {
  const lineItems: RoleLineItem[] = [
    { role: 'DEV', baseHours: 40, taxedHours: 40, edited: false },
    { role: 'QA', baseHours: 15, taxedHours: 18, edited: false },
    { role: 'PM', baseHours: 8, taxedHours: 9, edited: false },
    { role: 'BA', baseHours: 10, taxedHours: 11, edited: false },
  ];
  return { id, taxonomyKey: `feature.${id}`, title: `Feature ${id}`, enabled, lineItems };
}

const sampleItems = [makeMenuItem('checkout'), makeMenuItem('auth'), makeMenuItem('disabled', false)];

// ─── WS19-01: SheetsProvider creates a spreadsheet (stub) ────────────────────

describe('WS19-01: SheetsProvider — create spreadsheet (BLOCKED-CREDENTIAL stub)', () => {
  it('StubSheetsProvider returns a spreadsheet URL', async () => {
    const provider = new StubSheetsProvider();
    const result = await provider.createSpreadsheet('Test Estimate', [
      { title: 'DEV', rows: [['Item', 'Hours'], ['Feature A', 40]] },
    ]);

    expect(result.spreadsheetId).toBeTruthy();
    expect(result.url).toContain('docs.google.com/spreadsheets');
  });
});

// ─── WS19-02: Write one tab per role + roll-up tab ───────────────────────────

describe('WS19-02: Tab structure — one per role + roll-up', () => {
  it('buildExportTabs creates 5 tabs (DEV/QA/PM/BA + Roll-Up)', () => {
    const tabs = buildExportTabs(sampleItems);
    expect(tabs).toHaveLength(5);
    const titles = tabs.map((t) => t.title);
    expect(titles).toContain('DEV');
    expect(titles).toContain('QA');
    expect(titles).toContain('PM');
    expect(titles).toContain('BA');
    expect(titles).toContain('Roll-Up');
  });

  it('role tabs only contain enabled items', () => {
    const tabs = buildExportTabs(sampleItems);
    const devTab = tabs.find((t) => t.title === 'DEV')!;

    // Header row + 2 enabled items (checkout + auth), not the disabled one
    expect(devTab.rows).toHaveLength(3); // header + 2 items
  });

  it('roll-up tab contains correct totals matching in-app projection', () => {
    const items = [makeMenuItem('item-a'), makeMenuItem('item-b')];
    const tabs = buildExportTabs(items);
    const rollupTab = tabs.find((t) => t.title === 'Roll-Up')!;

    // Find DEV row
    const devRow = rollupTab.rows.find((r) => r[0] === 'DEV')!;
    expect(devRow[1]).toBe(80); // 40 + 40

    // Find TOTAL row
    const totalRow = rollupTab.rows.find((r) => r[0] === 'TOTAL')!;
    expect(typeof totalRow[1]).toBe('number');
    expect(Number(totalRow[1])).toBeGreaterThan(0);
  });

  it('tab columns match expected format', () => {
    const tabs = buildExportTabs([makeMenuItem('item-a')]);
    const devTab = tabs.find((t) => t.title === 'DEV')!;
    const header = devTab.rows[0]!;
    expect(header).toContain('Item');
    expect(header).toContain('Base Hours');
    expect(header).toContain('Taxed Hours');
  });
});

// ─── WS19-03: Re-export is idempotent ────────────────────────────────────────

describe('WS19-03: Re-export updates same spreadsheet (idempotent by estimateId)', () => {
  it('second export updates rather than duplicates (mock provider)', async () => {
    const mockProvider = {
      createSpreadsheet: vi.fn().mockResolvedValue({ spreadsheetId: 'sheet-123', url: 'https://docs.google.com/spreadsheets/d/sheet-123' }),
      updateSpreadsheet: vi.fn().mockResolvedValue({ spreadsheetId: 'sheet-123', url: 'https://docs.google.com/spreadsheets/d/sheet-123' }),
      getSpreadsheetId: vi.fn(),
    };

    // First export: no existing sheet
    mockProvider.getSpreadsheetId.mockResolvedValue(null);
    const first = await exportToSheets('est-1', 'Test', sampleItems, mockProvider);
    expect(mockProvider.createSpreadsheet).toHaveBeenCalledOnce();

    // Second export: existing sheet found
    mockProvider.getSpreadsheetId.mockResolvedValue('sheet-123');
    const second = await exportToSheets('est-1', 'Test', sampleItems, mockProvider);
    expect(mockProvider.updateSpreadsheet).toHaveBeenCalledOnce();
    expect(mockProvider.createSpreadsheet).toHaveBeenCalledOnce(); // not called again

    expect(first.spreadsheetId).toBe(second.spreadsheetId);
  });
});
