/**
 * Google Sheets export verification (AEH-232).
 *
 * The export shipped, was marked done, and had never once run: every test and
 * every documented run took the stub path, so the first real attempt failed on
 * an error ("The caller does not have permission") that named the wrong cause.
 * This script is the check that was missing.
 *
 *   pnpm verify:sheets              # read-only: diagnose the configuration
 *   pnpm verify:sheets --live       # really export an estimate, read it back
 *   pnpm verify:sheets --live --estimate <id>
 *
 * --live writes to the real Drive folder in GOOGLE_DRIVE_FOLDER_ID. It exports
 * twice on purpose: the second run must update the first spreadsheet in place
 * rather than making a duplicate.
 */
import { PrismaClient, toMenuItem } from '@repo/db';
import {
  createSheetsProvider,
  diagnoseSheetsConfig,
  formatDiagnosis,
  LiveSheetsProvider,
  StubSheetsProvider,
} from '@repo/providers';
import type { MenuItem } from '@repo/shared';
import { buildExportTabs, exportToSheets } from '../sheets-export';
import { loadEnvFiles } from './load-env';

const EXPECTED_TABS = ['DEV', 'QA', 'PM', 'BA', 'Roll-Up'];
const EXPECTED_ROLE_HEADERS = ['Item', 'Line Item', 'Taxonomy Key', 'Base Hours', 'Taxed Hours', 'Notes'];
const EXPECTED_ROLLUP_HEADERS = ['Role', 'Total Base Hours', 'Total Taxed Hours'];

let failures = 0;
const check = (ok: boolean, label: string, detail = ''): void => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'PASS ' : 'FAIL '} ${label}${detail ? ` — ${detail}` : ''}`);
};

/**
 * Load an estimate and map it with the very same `toMenuItem` the export's
 * server action uses — not a hand-rolled MenuItemSchema.parse, which would
 * differ from the app (it spreads the row's meta object and coerces nulls to
 * undefined) and so could fail on rows the real export handles fine.
 *
 * AEH-227 made this read strict: PhaseSchema is an enum while the DB column is
 * a free-form nullable string, so a bad row throws here rather than inside
 * Google's API — and telling those two apart is the point of doing it first.
 */
async function loadEstimate(db: PrismaClient, estimateId: string | null) {
  const estimate = estimateId
    ? await db.estimate.findUnique({ where: { id: estimateId }, include: { menuItems: { include: { lineItems: true } } } })
    : await db.estimate.findFirst({
        where: { menuItems: { some: {} } },
        orderBy: { createdAt: 'desc' },
        include: { menuItems: { include: { lineItems: true } } },
      });

  if (!estimate) {
    throw new Error(
      estimateId
        ? `No estimate ${estimateId}.`
        : 'No estimate with any menu items exists in this database — nothing to export.',
    );
  }

  const items: MenuItem[] = [];
  const parseFailures: string[] = [];
  for (const raw of estimate.menuItems) {
    try {
      items.push(toMenuItem(raw));
    } catch (err) {
      parseFailures.push(`${raw.id}: ${err instanceof Error ? err.message.replace(/\s+/g, ' ').slice(0, 200) : String(err)}`);
    }
  }

  return { estimate, items, parseFailures };
}

async function main(): Promise<void> {
  loadEnvFiles();

  const argv = process.argv.slice(2);
  const live = argv.includes('--live');
  const estimateFlag = argv.indexOf('--estimate');
  const estimateId = estimateFlag >= 0 ? (argv[estimateFlag + 1] ?? null) : null;

  // ─── Part 1: configuration, read-only
  const diagnosis = await diagnoseSheetsConfig();
  console.log(formatDiagnosis(diagnosis));
  if (diagnosis.serviceAccount) {
    console.log('');
    console.log(`  service account : ${diagnosis.serviceAccount.clientEmail}`);
    console.log(`  client id       : ${diagnosis.serviceAccount.clientId}`);
    console.log(`  impersonating   : ${diagnosis.impersonating ?? '(nobody — created files would be owned by the service account, which has no quota)'}`);
  }

  if (!live) {
    console.log('\nRead-only check complete. Re-run with --live to export a real estimate.');
    process.exitCode = diagnosis.ok ? 0 : 1;
    return;
  }

  if (!diagnosis.ok) {
    console.log('\nRefusing to run --live while the configuration check is failing: the export would');
    console.log('fail against a third party API and tell you less than the check above already has.');
    process.exitCode = 1;
    return;
  }

  // ─── Part 2: a real export, end to end
  const provider = createSheetsProvider();
  if (provider instanceof StubSheetsProvider) {
    console.log('\ncreateSheetsProvider() returned the STUB — the live path is not configured. Nothing was exported.');
    process.exitCode = 1;
    return;
  }
  if (!(provider instanceof LiveSheetsProvider)) {
    console.log('\ncreateSheetsProvider() returned an unexpected provider; aborting.');
    process.exitCode = 1;
    return;
  }

  const db = new PrismaClient();
  try {
    console.log('\nReading an estimate out of the database');
    const { estimate, items, parseFailures } = await loadEstimate(db, estimateId);
    console.log(`  estimate ${estimate.id} — "${estimate.title}" with ${estimate.menuItems.length} menu item(s)`);
    check(parseFailures.length === 0, 'every menu item parses against MenuItemSchema',
      parseFailures.length ? `${parseFailures.length} failed: ${parseFailures.slice(0, 3).join(' | ')}` : `${items.length} parsed`);
    if (parseFailures.length > 0) {
      console.log('\n  A parse failure here is a DATA problem, not an export bug (see AEH-227). Fix the rows first.');
      process.exitCode = 1;
      return;
    }

    const tabs = buildExportTabs(items);
    const expectedRowCounts = new Map(tabs.map((t) => [t.title, Math.max(0, t.rows.length - 1)]));
    console.log(`  built ${tabs.length} tab(s): ${tabs.map((t) => `${t.title}(${expectedRowCounts.get(t.title)})`).join(' ')}`);

    console.log('\nFirst export — expect a new spreadsheet');
    const first = await exportToSheets(estimate.id, estimate.title, items, provider);
    check(Boolean(first.spreadsheetId), 'createSpreadsheet returned an id', first.spreadsheetId);
    check(first.tabCount === EXPECTED_TABS.length, `tabCount is ${EXPECTED_TABS.length}`, String(first.tabCount));
    console.log(`  ${first.url}`);

    console.log('\nReading the spreadsheet back out of Drive');
    const readback = await provider.describeTabs(first.spreadsheetId);
    check(
      JSON.stringify(readback.map((t) => t.title)) === JSON.stringify(EXPECTED_TABS),
      `tabs are exactly ${EXPECTED_TABS.join(', ')}`,
      readback.map((t) => t.title).join(', ') || '(none)',
    );
    for (const tab of readback) {
      const expectedHeaders = tab.title === 'Roll-Up' ? EXPECTED_ROLLUP_HEADERS : EXPECTED_ROLE_HEADERS;
      const expectedRows = expectedRowCounts.get(tab.title);
      // An empty tab carries no header row at all, which is correct, not a fault.
      if (tab.dataRows === 0 && tab.headers.length === 0) {
        check(expectedRows === 0, `${tab.title}: empty, as built`, `expected ${expectedRows} data row(s)`);
        continue;
      }
      check(JSON.stringify(tab.headers) === JSON.stringify(expectedHeaders), `${tab.title}: header row`, tab.headers.join(' | '));
      check(tab.dataRows === expectedRows, `${tab.title}: ${expectedRows} data row(s)`, `found ${tab.dataRows}`);
    }

    console.log('\nIdempotency — the tag must be findable, and a second export must not duplicate');
    const found = await provider.getSpreadsheetId(estimate.id);
    check(found === first.spreadsheetId, 'getSpreadsheetId finds the file by its estimateId tag', found ?? '(null)');

    const second = await exportToSheets(estimate.id, estimate.title, items, provider);
    check(second.spreadsheetId === first.spreadsheetId, 'second export updated in place', second.spreadsheetId);

    const afterUpdate = await provider.describeTabs(second.spreadsheetId);
    check(
      JSON.stringify(afterUpdate.map((t) => t.title)) === JSON.stringify(EXPECTED_TABS),
      'tabs unchanged after the update path',
      afterUpdate.map((t) => t.title).join(', '),
    );
    const rowsStable = afterUpdate.every((t) => t.dataRows === (expectedRowCounts.get(t.title) ?? 0));
    check(rowsStable, 'row counts unchanged after the update path (no doubling, no stale rows)');

    console.log('');
    console.log(failures === 0 ? 'Live export verified.' : `Live export completed with ${failures} failed check(s).`);
    console.log(`Open it and eyeball the numbers: ${first.url}`);
    console.log('\nThe spreadsheet is left in place on purpose — AEH-232 asks for a human to look at it.');
    console.log('Delete it from Drive when done, or re-run any time; it updates that same file.');
    if (failures > 0) process.exitCode = 1;
  } finally {
    await db.$disconnect();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
