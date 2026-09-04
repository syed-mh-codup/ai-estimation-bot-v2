import type { ISheetsProvider, SpreadsheetTab, TabFormat } from '@repo/providers';
import type { MenuItem, Phase, RoleKind, RoleLineItem } from '@repo/shared';

// ─── AEH-317: tab structure ───────────────────────────────────────────────────
//
// This file used to emit an internal data dump: one tab per role, one flat row
// per line item, a Taxonomy Key column that means nothing outside the platform,
// and a roll-up tab last. It was organised by the system's own model, so no tab
// answered the only question its readers ask, which is what a deliverable costs.
//
// Its actual audience, established by grilling AEH-317 rather than by guessing:
// account executives who cost and present the work, each department keeping the
// durable record of its own estimate, and executive management who read the
// summary and hold a veto over the numbers. It never goes to a client, and no
// money appears anywhere — rates belong to the AE team and are theirs to apply.
//
// Hence the two rules the layout below exists to serve. Everything a reader
// aggregates is a formula, so editing one hour moves every figure that depends
// on it across every tab. And every generated tab is disposable, so the file
// says so, loudly, at the top of the one people work in.

/** Departments across the file, in reading order, with the tab each one owns. */
const DEPARTMENTS: ReadonlyArray<{ role: RoleKind; tab: string }> = [
  { role: 'DEV', tab: 'Development' },
  { role: 'QA', tab: 'QA' },
  { role: 'PM', tab: 'PM' },
  { role: 'BA', tab: 'BA' },
];

const SUMMARY_TAB = 'Summary';

/**
 * Every tab title this exporter is answerable for, including the two it no
 * longer produces.
 *
 * `DEV` and `Roll-Up` are here precisely because they are gone: naming them is
 * what lets an existing spreadsheet migrate in place instead of carrying a
 * stale tab of last month's numbers next to the new one. Anything NOT in this
 * list is somebody's own work and is never touched — see the ownership rule in
 * `syncTabs`.
 */
export const MANAGED_TAB_TITLES: readonly string[] = [
  SUMMARY_TAB,
  ...DEPARTMENTS.map((d) => d.tab),
  'DEV',
  'Roll-Up',
];

/** Phase blocks, in delivery order, with a home for cards that carry no phase. */
const PHASE_ORDER: readonly Phase[] = ['Foundation', 'Core', 'Enhancement'];
const UNPHASED = 'Unphased';

const BANNER =
  '⚠  This tab is rebuilt from scratch every time the estimate is exported — anything typed here is lost. ' +
  'Copy the tab (or the whole file) before working in it.';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * Deliberately not `toLocaleDateString`: the export runs on a server whose
 * locale nobody chose, and a date that renders differently depending on which
 * machine produced the file is not a record.
 */
function formatDate(at: Date): string {
  return `${at.getUTCDate()} ${MONTHS[at.getUTCMonth()]} ${at.getUTCFullYear()}`;
}

/** A1 column letter for a 0-based index, for the formulas below. */
function col(index: number): string {
  let n = index;
  let s = '';
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

/** Sheets rows are 1-based; every array index in here is 0-based. */
const sheetRow = (index: number): number => index + 1;

type Row = Array<string | number>;

/**
 * The hidden-work marker. An injected card is a placeholder the audit added, not
 * work anybody asked for; its hours are real so they stay in the totals, but an
 * AE presenting this must be able to tell the two apart.
 */
function label(item: MenuItem): string {
  return item.injected ? `${item.title}  ·  hidden work` : item.title;
}

function phaseOf(item: MenuItem): string {
  return item.phase ?? UNPHASED;
}

/**
 * Cards grouped into phase blocks, in delivery order, skipping empty phases.
 * Disabled cards never appear: the sheet shows the scope as it currently
 * stands, which is what the app itself shows.
 */
function phaseBlocks(menuItems: MenuItem[]): Array<{ phase: string; items: MenuItem[] }> {
  const enabled = menuItems.filter((m) => m.enabled);
  const order: string[] = [...PHASE_ORDER, UNPHASED];
  return order
    .map((phase) => ({ phase, items: enabled.filter((m) => phaseOf(m) === phase) }))
    .filter((block) => block.items.length > 0);
}

function lineItemsFor(item: MenuItem, role: RoleKind): RoleLineItem[] {
  return item.lineItems.filter((li) => li.role === role);
}

// ─── Department tabs ─────────────────────────────────────────────────────────

const DEPT_COLUMNS = {
  cardId: 0,
  label: 1,
  phase: 2,
  base: 3,
  taxed: 4,
  notes: 5,
} as const;

const DEPT_HEADER: Row = ['Card ID', 'Deliverable / line item', 'Phase', 'Base', 'Taxed', 'Notes'];

/**
 * One department's record: its ≤4h line items, grouped under the deliverable
 * they belong to, each group closed by a subtotal.
 *
 * Only the line item rows carry the card id. That is load-bearing, not tidiness:
 * the summary joins to this tab with a whole-column SUMIF on that id, so a
 * subtotal row carrying the same id would be counted a second time and every
 * number on the summary would come out doubled.
 */
function buildDepartmentTab(role: RoleKind, title: string, menuItems: MenuItem[]): SpreadsheetTab {
  const rows: Row[] = [DEPT_HEADER];
  const rowStyles: NonNullable<TabFormat['rowStyles']> = [{ row: 0, style: 'header' }];

  for (const block of phaseBlocks(menuItems)) {
    for (const item of block.items) {
      const lineItems = lineItemsFor(item, role);
      if (lineItems.length === 0) continue;

      rows.push([]);
      rowStyles.push({ row: rows.length, style: 'group' });
      rows.push(['', label(item).toUpperCase(), block.phase, '', '', '']);

      const firstDataRow = sheetRow(rows.length);
      for (const li of lineItems) {
        rows.push([
          item.id,
          `    ${li.title ?? item.title}`,
          '',
          li.baseHours,
          li.taxedHours,
          li.notes ?? '',
        ]);
      }
      const lastDataRow = sheetRow(rows.length - 1);

      rowStyles.push({ row: rows.length, style: 'subtotal' });
      rows.push([
        '',
        '    Subtotal',
        '',
        `=SUM(${col(DEPT_COLUMNS.base)}${firstDataRow}:${col(DEPT_COLUMNS.base)}${lastDataRow})`,
        `=SUM(${col(DEPT_COLUMNS.taxed)}${firstDataRow}:${col(DEPT_COLUMNS.taxed)}${lastDataRow})`,
        '',
      ]);
    }
  }

  return {
    title,
    rows,
    format: {
      frozenRows: 1,
      hiddenColumns: [DEPT_COLUMNS.cardId],
      numericColumns: [DEPT_COLUMNS.base, DEPT_COLUMNS.taxed],
      columnWidths: [
        { column: DEPT_COLUMNS.label, pixels: 320 },
        { column: DEPT_COLUMNS.phase, pixels: 110 },
        { column: DEPT_COLUMNS.base, pixels: 70 },
        { column: DEPT_COLUMNS.taxed, pixels: 70 },
        { column: DEPT_COLUMNS.notes, pixels: 280 },
      ],
      rowStyles,
    },
  };
}

// ─── Summary tab ─────────────────────────────────────────────────────────────

const SUMMARY_COLUMNS = {
  cardId: 0,
  label: 1,
  /** Departments occupy the columns from here, in DEPARTMENTS order. */
  firstDepartment: 2,
} as const;

const SUMMARY_TOTAL_COLUMN = SUMMARY_COLUMNS.firstDepartment + DEPARTMENTS.length;

/** Where the body starts, fixed by the banner/identity/header block above it. */
const SUMMARY_BODY_START = 7;

/** Column indexes for the departments plus the TOTAL column beside them. */
function columnIndexesFrom(start: number): number[] {
  return Array.from({ length: DEPARTMENTS.length + 1 }, (_, i) => start + i);
}

function columnsFrom(start: number): string[] {
  return columnIndexesFrom(start).map(col);
}

/** The department column headings, repeated on every phase heading row so they
 *  are still readable a long way down the tab. */
function departmentHeadings(leading: string): Row {
  return ['', leading, ...DEPARTMENTS.map((d) => d.role), 'TOTAL'];
}

/**
 * The tab an executive opens, and the only one that answers "what does this
 * feature cost" — deliverables down, departments across, grouped by phase so
 * the subtotals answer "and what if we drop Enhancement".
 *
 * Not one number here is written. Every department cell reads its department
 * tab, every subtotal sums the cards above it, and the estimate total sums the
 * subtotals, so an hour corrected in a department tab moves all four.
 */
function buildSummaryTab(menuItems: MenuItem[], meta: ExportMeta): SpreadsheetTab {
  const blocks = phaseBlocks(menuItems);
  const rowStyles: NonNullable<TabFormat['rowStyles']> = [];

  const body: Row[] = [];
  const subtotalRows: number[] = [];
  const bodyStyle = (offset: number, style: 'group' | 'subtotal'): void => {
    rowStyles.push({ row: SUMMARY_BODY_START + offset, style });
  };

  for (const block of blocks) {
    bodyStyle(body.length, 'group');
    body.push(departmentHeadings(block.phase.toUpperCase()));

    const firstCardRow = sheetRow(SUMMARY_BODY_START + body.length);
    for (const item of block.items) {
      const row = sheetRow(SUMMARY_BODY_START + body.length);
      const idCell = `$${col(SUMMARY_COLUMNS.cardId)}${row}`;
      const cells = DEPARTMENTS.map((d) => {
        // Whole-column, so it survives an AE inserting or reordering rows in the
        // department tab. A direct cell reference would not, and they do edit
        // these files.
        const key = `'${d.tab}'!$${col(DEPT_COLUMNS.cardId)}:$${col(DEPT_COLUMNS.cardId)}`;
        const hours = `'${d.tab}'!$${col(DEPT_COLUMNS.taxed)}:$${col(DEPT_COLUMNS.taxed)}`;
        return `=SUMIF(${key},${idCell},${hours})`;
      });
      body.push([
        item.id,
        label(item),
        ...cells,
        `=SUM(${col(SUMMARY_COLUMNS.firstDepartment)}${row}:${col(SUMMARY_TOTAL_COLUMN - 1)}${row})`,
      ]);
    }
    const lastCardRow = sheetRow(SUMMARY_BODY_START + body.length - 1);

    bodyStyle(body.length, 'subtotal');
    subtotalRows.push(sheetRow(SUMMARY_BODY_START + body.length));
    body.push([
      '',
      `    ${block.phase} subtotal`,
      ...columnsFrom(SUMMARY_COLUMNS.firstDepartment).map(
        (c) => `=SUM(${c}${firstCardRow}:${c}${lastCardRow})`,
      ),
    ]);

    body.push([]);
  }

  const totals: Row = columnsFrom(SUMMARY_COLUMNS.firstDepartment).map((c) =>
    subtotalRows.length === 0 ? 0 : `=SUM(${subtotalRows.map((r) => `${c}${r}`).join(',')})`,
  );

  const head: Row[] = [
    [BANNER],
    [],
    ['', `${meta.estimateTitle} — Estimate`, '', '', '', '', `Exported ${formatDate(meta.exportedAt)}`],
    [],
    departmentHeadings(''),
    ['', 'ESTIMATE TOTAL', ...totals],
    [],
  ];

  rowStyles.push(
    { row: 0, style: 'banner' },
    { row: 2, style: 'title' },
    { row: 4, style: 'header' },
    { row: 5, style: 'total' },
  );

  return {
    title: SUMMARY_TAB,
    rows: [...head, ...body],
    format: {
      // Through the estimate total, so the number under discussion stays on
      // screen however far down the deliverables somebody scrolls.
      frozenRows: 6,
      hiddenColumns: [SUMMARY_COLUMNS.cardId],
      numericColumns: columnIndexesFrom(SUMMARY_COLUMNS.firstDepartment),
      columnWidths: [
        { column: SUMMARY_COLUMNS.label, pixels: 300 },
        ...columnIndexesFrom(SUMMARY_COLUMNS.firstDepartment).map((column) => ({ column, pixels: 90 })),
      ],
      rowStyles,
    },
  };
}

// ─── Assembly ────────────────────────────────────────────────────────────────

export type ExportMeta = {
  estimateTitle: string;
  exportedAt: Date;
};

/**
 * Blank rows separate the phase blocks, so the last block leaves one dangling.
 * Google drops trailing empties on the way back out, which would make every
 * read-back row count disagree with what was built by exactly one — a
 * discrepancy that looks like a bug in the export and is not. Cheaper to not
 * write the row.
 */
function trimTrailingBlankRows(tab: SpreadsheetTab): SpreadsheetTab {
  const rows = [...tab.rows];
  while (rows.length > 0 && rows[rows.length - 1]!.every((cell) => cell === '')) rows.pop();
  return { ...tab, rows };
}

/**
 * Build every tab for a spreadsheet export. Summary first, because it is the
 * tab anybody opens the file for.
 */
export function buildExportTabs(menuItems: MenuItem[], meta: ExportMeta): SpreadsheetTab[] {
  return [
    buildSummaryTab(menuItems, meta),
    ...DEPARTMENTS.map((d) => buildDepartmentTab(d.role, d.tab, menuItems)),
  ].map(trimTrailingBlankRows);
}

// ─── Export pipeline ─────────────────────────────────────────────────────────

export type SheetsExportResult = {
  spreadsheetId: string;
  url: string;
  tabCount: number;
  /**
   * Drive's modifiedTime read straight after the write. The check for "somebody
   * edited this since we last wrote it" has to compare against this rather than
   * against the wall clock, because our own write bumps modifiedTime — comparing
   * against anything else reports a modification on every single re-export.
   */
  modifiedAt: Date | null;
};

/**
 * Export an estimate to Google Sheets.
 * Creates a new spreadsheet or updates the existing one (idempotent by estimateId).
 */
export async function exportToSheets(
  estimateId: string,
  estimateTitle: string,
  menuItems: MenuItem[],
  sheetsProvider: ISheetsProvider,
  exportedAt: Date = new Date(),
): Promise<SheetsExportResult> {
  const tabs = buildExportTabs(menuItems, { estimateTitle, exportedAt });
  const managed = [...MANAGED_TAB_TITLES];

  const existingId = await sheetsProvider.getSpreadsheetId(estimateId);

  const result = existingId
    ? await sheetsProvider.updateSpreadsheet(existingId, tabs, managed)
    : await sheetsProvider.createSpreadsheet(`${estimateTitle} — Estimate`, tabs, estimateId, managed);

  return {
    spreadsheetId: result.spreadsheetId,
    url: result.url,
    tabCount: tabs.length,
    modifiedAt: await sheetsProvider.getModifiedTime(result.spreadsheetId),
  };
}
