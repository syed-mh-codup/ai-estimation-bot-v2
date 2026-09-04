// These tests exercise the tab-building + create/update branching logic
// against StubSheetsProvider (fast, offline, no API cost). LiveSheetsProvider
// (packages/providers/src/sheets-provider.ts) is verified separately against
// the real Google Sheets/Drive API.
//
// The layout they assert was settled in AEH-317: summary first, departments
// after it, phase grouping, and every aggregate a live formula.

import { describe, it, expect, vi } from 'vitest';
import { buildExportTabs, exportToSheets, MANAGED_TAB_TITLES } from './sheets-export';
import { StubSheetsProvider, type SpreadsheetTab } from '@repo/providers';
import { MenuItemSchema, type MenuItem } from '@repo/shared';

type Overrides = {
  enabled?: boolean;
  phase?: string;
  injected?: boolean;
  title?: string;
};

function makeMenuItem(id: string, overrides: Overrides = {}): MenuItem {
  const lineItems = [
    { role: 'DEV', title: `${id} dev work`, baseHours: 40, taxedHours: 40, edited: false },
    { role: 'QA', title: `${id} qa work`, baseHours: 15, taxedHours: 18, edited: false },
    { role: 'PM', title: `${id} pm work`, baseHours: 8, taxedHours: 9, edited: false },
    { role: 'BA', title: `${id} ba work`, baseHours: 10, taxedHours: 11, edited: false },
  ];
  return MenuItemSchema.parse({
    id,
    taxonomyKey: `feature.${id}`,
    title: overrides.title ?? `Feature ${id}`,
    enabled: overrides.enabled ?? true,
    injected: overrides.injected ?? false,
    ...(overrides.phase ? { phase: overrides.phase } : {}),
    lineItems,
  });
}

const META = { estimateTitle: 'Acme Portal', exportedAt: new Date('2026-09-04T10:00:00Z') };

const sampleItems = [
  makeMenuItem('checkout', { phase: 'Core' }),
  makeMenuItem('auth', { phase: 'Foundation' }),
  makeMenuItem('disabled', { enabled: false, phase: 'Core' }),
];

const tabNamed = (tabs: SpreadsheetTab[], title: string): SpreadsheetTab =>
  tabs.find((t) => t.title === title)!;

/** Column B carries every label; trimmed, because indentation is presentational. */
const labelAt = (tab: SpreadsheetTab, row: number): string => String(tab.rows[row]?.[1] ?? '').trim();

const rowWithLabel = (tab: SpreadsheetTab, label: string): number =>
  tab.rows.findIndex((_, i) => labelAt(tab, i) === label);

// ─── Tab set ─────────────────────────────────────────────────────────────────

describe('AEH-317: tab set', () => {
  it('is Summary first, then one tab per department', () => {
    const titles = buildExportTabs(sampleItems, META).map((t) => t.title);
    expect(titles).toEqual(['Summary', 'Development', 'QA', 'PM', 'BA']);
  });

  it('still claims the tabs it no longer produces, so they get cleaned up', () => {
    // Without these an existing spreadsheet keeps a DEV tab of last month's
    // numbers sitting next to the new Development one.
    expect(MANAGED_TAB_TITLES).toContain('DEV');
    expect(MANAGED_TAB_TITLES).toContain('Roll-Up');
  });
});

// ─── Summary tab ─────────────────────────────────────────────────────────────

describe('AEH-317: summary tab', () => {
  const summary = () => tabNamed(buildExportTabs(sampleItems, META), 'Summary');

  it('opens with the disclaimer, then the estimate identity', () => {
    const tab = summary();
    expect(String(tab.rows[0]?.[0])).toMatch(/rebuilt from scratch/i);
    expect(String(tab.rows[0]?.[0])).toMatch(/Copy the tab/i);
    expect(String(tab.rows[2]?.[1])).toBe('Acme Portal — Estimate');
    expect(String(tab.rows[2]?.[6])).toBe('Exported 4 Sep 2026');
  });

  it('groups deliverables by phase, in delivery order, with a subtotal each', () => {
    const tab = summary();
    const headings = tab.rows.map((_, i) => labelAt(tab, i)).filter((l) => /^(FOUNDATION|CORE|ENHANCEMENT|UNPHASED)$/.test(l));
    expect(headings).toEqual(['FOUNDATION', 'CORE']);
    expect(rowWithLabel(tab, 'Foundation subtotal')).toBeGreaterThan(0);
    expect(rowWithLabel(tab, 'Core subtotal')).toBeGreaterThan(0);
  });

  it('gives cards carrying no phase their own block rather than dropping them', () => {
    const tab = tabNamed(buildExportTabs([makeMenuItem('loose')], META), 'Summary');
    expect(rowWithLabel(tab, 'UNPHASED')).toBeGreaterThan(0);
    expect(rowWithLabel(tab, 'Unphased subtotal')).toBeGreaterThan(0);
  });

  it('excludes cards that were switched off', () => {
    const tab = summary();
    const labels = tab.rows.map((_, i) => labelAt(tab, i));
    expect(labels).toContain('Feature checkout');
    expect(labels).not.toContain('Feature disabled');
  });

  it('marks hidden-work cards but keeps them in the numbers', () => {
    const items = [makeMenuItem('audit', { phase: 'Core', injected: true })];
    const tab = tabNamed(buildExportTabs(items, META), 'Summary');
    const labels = tab.rows.map((_, i) => labelAt(tab, i));
    expect(labels.some((l) => l.includes('hidden work'))).toBe(true);
    // Still inside a phase block, so still inside that block's subtotal.
    expect(rowWithLabel(tab, 'Core subtotal')).toBeGreaterThan(0);
  });

  it('reads every department cell out of that department tab, never writes a number', () => {
    const tab = summary();
    const row = rowWithLabel(tab, 'Feature auth');
    const cells = tab.rows[row]!;
    // Sheet rows are 1-based; the formula must key on this row's own id cell.
    expect(cells[2]).toBe(`=SUMIF('Development'!$A:$A,$A${row + 1},'Development'!$E:$E)`);
    expect(cells[3]).toBe(`=SUMIF('QA'!$A:$A,$A${row + 1},'QA'!$E:$E)`);
    expect(cells[6]).toBe(`=SUM(C${row + 1}:F${row + 1})`);
    // The join key itself, which the reader never sees.
    expect(cells[0]).toBe('auth');
  });

  it('sums the estimate total from the phase subtotals, not from the cards', () => {
    const tab = summary();
    const foundation = rowWithLabel(tab, 'Foundation subtotal') + 1;
    const core = rowWithLabel(tab, 'Core subtotal') + 1;
    expect(tab.rows[5]?.[1]).toBe('ESTIMATE TOTAL');
    expect(tab.rows[5]?.[2]).toBe(`=SUM(C${foundation},C${core})`);
  });

  it('totals zero rather than a broken formula when nothing is in scope', () => {
    const tab = tabNamed(buildExportTabs([makeMenuItem('off', { enabled: false })], META), 'Summary');
    expect(tab.rows[5]?.[2]).toBe(0);
  });

  it('hides the join column and freezes through the estimate total', () => {
    const { format } = summary();
    expect(format?.hiddenColumns).toEqual([0]);
    expect(format?.frozenRows).toBe(6);
  });
});

// ─── Department tabs ─────────────────────────────────────────────────────────

describe('AEH-317: department tabs', () => {
  const dev = () => tabNamed(buildExportTabs(sampleItems, META), 'Development');

  it('heads each card block and closes it with a subtotal over its own rows', () => {
    const tab = dev();
    const heading = rowWithLabel(tab, 'FEATURE AUTH');
    expect(heading).toBeGreaterThan(0);
    const subtotal = tab.rows.findIndex((_, i) => i > heading && labelAt(tab, i) === 'Subtotal');
    expect(tab.rows[subtotal]?.[3]).toBe(`=SUM(D${heading + 2}:D${subtotal})`);
    expect(tab.rows[subtotal]?.[4]).toBe(`=SUM(E${heading + 2}:E${subtotal})`);
  });

  it('carries the card id on line item rows ONLY, or the summary double-counts', () => {
    const tab = dev();
    for (const [i, row] of tab.rows.entries()) {
      const text = labelAt(tab, i);
      const isLineItem = text.length > 0 && text !== 'Subtotal' && text !== text.toUpperCase();
      if (row.length === 0 || i === 0) continue;
      expect(Boolean(row[0])).toBe(isLineItem);
    }
  });

  it('drops the taxonomy key and carries the phase instead', () => {
    const header = dev().rows[0]!;
    expect(header).not.toContain('Taxonomy Key');
    expect(header).toContain('Phase');
    expect(header).toContain('Base');
    expect(header).toContain('Taxed');
  });

  it('omits a card the department has no line items for', () => {
    const noQa = MenuItemSchema.parse({
      id: 'dev-only',
      taxonomyKey: 'feature.dev-only',
      title: 'Dev only',
      phase: 'Core',
      lineItems: [{ role: 'DEV', title: 'just dev', baseHours: 4, taxedHours: 4, edited: false }],
    });
    const tabs = buildExportTabs([noQa], META);
    expect(rowWithLabel(tabNamed(tabs, 'Development'), 'DEV ONLY')).toBeGreaterThan(0);
    expect(rowWithLabel(tabNamed(tabs, 'QA'), 'DEV ONLY')).toBe(-1);
  });
});

// ─── Provider plumbing ───────────────────────────────────────────────────────

describe('AEH-317: export pipeline', () => {
  it('StubSheetsProvider returns a spreadsheet URL', async () => {
    const provider = new StubSheetsProvider();
    const result = await provider.createSpreadsheet(
      'Test Estimate',
      [{ title: 'Summary', rows: [['Item', 'Hours']] }],
      'est-stub-01',
    );

    expect(result.spreadsheetId).toBeTruthy();
    expect(result.url).toContain('docs.google.com/spreadsheets');
  });

  it('tracks the created spreadsheet by estimateId for idempotent lookup', async () => {
    const provider = new StubSheetsProvider();
    expect(await provider.getSpreadsheetId('est-stub-02')).toBeNull();

    const result = await provider.createSpreadsheet('Test Estimate', [], 'est-stub-02');

    expect(await provider.getSpreadsheetId('est-stub-02')).toBe(result.spreadsheetId);
  });

  it('second export updates rather than duplicates, and declares what it owns', async () => {
    const mockProvider = {
      createSpreadsheet: vi.fn().mockResolvedValue({ spreadsheetId: 'sheet-123', url: 'https://docs.google.com/spreadsheets/d/sheet-123' }),
      updateSpreadsheet: vi.fn().mockResolvedValue({ spreadsheetId: 'sheet-123', url: 'https://docs.google.com/spreadsheets/d/sheet-123' }),
      getSpreadsheetId: vi.fn(),
      getModifiedTime: vi.fn().mockResolvedValue(new Date('2026-09-04T10:00:05Z')),
    };

    mockProvider.getSpreadsheetId.mockResolvedValue(null);
    const first = await exportToSheets('est-1', 'Test', sampleItems, mockProvider);
    expect(mockProvider.createSpreadsheet).toHaveBeenCalledOnce();

    mockProvider.getSpreadsheetId.mockResolvedValue('sheet-123');
    const second = await exportToSheets('est-1', 'Test', sampleItems, mockProvider);
    expect(mockProvider.updateSpreadsheet).toHaveBeenCalledOnce();
    expect(mockProvider.createSpreadsheet).toHaveBeenCalledOnce(); // not called again

    expect(first.spreadsheetId).toBe(second.spreadsheetId);

    // The ownership list is what stops the update deleting an AE's own tab.
    expect(mockProvider.updateSpreadsheet.mock.calls[0]?.[2]).toEqual([...MANAGED_TAB_TITLES]);
  });

  it('reports the modified time it read back, so a later export can spot an edit', async () => {
    const provider = new StubSheetsProvider();
    const result = await exportToSheets('est-2', 'Test', sampleItems, provider);
    // The stub never wrote to Drive, so "unknown" is the honest answer.
    expect(result.modifiedAt).toBeNull();
    expect(result.tabCount).toBe(5);
  });
});
