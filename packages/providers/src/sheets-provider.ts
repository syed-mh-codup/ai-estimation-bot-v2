import { google } from 'googleapis';

/**
 * What a row *is*, not what it looks like. The tab builder knows it is emitting
 * a phase heading; it has no business knowing that a phase heading is bold on a
 * warm grey ground. Keeping the vocabulary semantic is what lets the whole
 * file's look change in one place here rather than in every builder. AEH-317.
 */
export type RowStyle = 'banner' | 'title' | 'header' | 'group' | 'subtotal' | 'total';

export type TabFormat = {
  /** How many rows stay pinned when the tab is scrolled. */
  frozenRows?: number;
  /** 0-based columns hidden from view — the join key nobody should have to see. */
  hiddenColumns?: number[];
  /** 0-based column index and the width, in pixels, it should get. */
  columnWidths?: Array<{ column: number; pixels: number }>;
  /** 0-based row index and how that row reads. */
  rowStyles?: Array<{ row: number; style: RowStyle }>;
  /** 0-based columns whose numbers render to one decimal place. */
  numericColumns?: number[];
};

export type SpreadsheetTab = {
  title: string;
  rows: Array<Array<string | number>>;
  /** Optional: a tab with no format is written as plain values, as before. */
  format?: TabFormat;
};

export type ExportResult = {
  spreadsheetId: string;
  url: string;
};

export interface ISheetsProvider {
  /** estimateId is used for idempotency tracking (tagging the created file so a later export can find it). */
  createSpreadsheet(
    title: string,
    tabs: SpreadsheetTab[],
    estimateId: string,
    managedTitles?: string[],
  ): Promise<ExportResult>;
  /**
   * `managedTitles` is every tab title this exporter is responsible for,
   * including ones it no longer produces — a tab named here but absent from
   * `tabs` gets deleted, and a tab named nowhere is left completely alone.
   * Omitting it means "delete nothing but what you are replacing", which is the
   * safe default rather than the useful one. See AEH-317.
   */
  updateSpreadsheet(
    spreadsheetId: string,
    tabs: SpreadsheetTab[],
    managedTitles?: string[],
  ): Promise<ExportResult>;
  getSpreadsheetId(estimateId: string): Promise<string | null>;
  /**
   * When Drive last saw this file change, or null if that cannot be
   * established. Null reads as "unknown", never as "unmodified".
   */
  getModifiedTime(spreadsheetId: string): Promise<Date | null>;
}

/**
 * Stub implementation — returns synthetic spreadsheet data, used when
 * GOOGLE_SERVICE_ACCOUNT_JSON/GOOGLE_DRIVE_FOLDER_ID are not configured.
 */
export class StubSheetsProvider implements ISheetsProvider {
  private readonly store = new Map<string, string>();

  async createSpreadsheet(
    _title: string,
    _tabs: SpreadsheetTab[],
    estimateId: string,
    _managedTitles?: string[],
  ): Promise<ExportResult> {
    const id = `stub-sheet-${Date.now()}`;
    this.store.set(estimateId, id);
    return {
      spreadsheetId: id,
      url: `https://docs.google.com/spreadsheets/d/${id}`,
    };
  }

  async updateSpreadsheet(
    spreadsheetId: string,
    _tabs: SpreadsheetTab[],
    _managedTitles?: string[],
  ): Promise<ExportResult> {
    return {
      spreadsheetId,
      url: `https://docs.google.com/spreadsheets/d/${spreadsheetId}`,
    };
  }

  async getSpreadsheetId(estimateId: string): Promise<string | null> {
    return this.store.get(estimateId) ?? null;
  }

  /** Nothing was ever written to Drive, so there is no modification to report. */
  async getModifiedTime(_spreadsheetId: string): Promise<Date | null> {
    return null;
  }
}

/** A1-style column letter for a 0-based column index (0 -> A, 25 -> Z, 26 -> AA...). */
function columnLetter(index: number): string {
  let n = index;
  let s = '';
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

function tabWidth(tab: SpreadsheetTab): number {
  return Math.max(1, ...tab.rows.map((r) => r.length));
}

function tabRange(tab: SpreadsheetTab): string {
  // The widest row, not the first one: a summary tab's banner is one cell and
  // its data rows are six, and writing a six-wide row into a one-wide range is
  // rejected by the API.
  const lastCol = columnLetter(tabWidth(tab) - 1);
  return `'${tab.title}'!A1:${lastCol}${Math.max(1, tab.rows.length)}`;
}

/**
 * What a re-export is allowed to blank: this export's own columns, all the way
 * down. Deliberately not the whole sheet — an account executive who adds a
 * money column beside the hours keeps it, which is half of what makes the
 * exported file usable to them. AEH-317.
 */
function clearRange(tab: SpreadsheetTab): string {
  return `'${tab.title}'!A1:${columnLetter(tabWidth(tab) - 1)}10000`;
}

/**
 * USER_ENTERED asks Google to interpret a value the way a person typing it
 * would mean it, which is the only way a written `=SUM(...)` becomes a formula
 * rather than the literal text of one. The cost is that it interprets
 * everything else too: a line item titled "3-4 retries" is read as a date, and
 * "1/2 done" as the first of February. A leading apostrophe is Sheets' own
 * "this is text" marker — it is consumed on entry and never appears in the
 * cell, in a copy of it, or in a read-back.
 *
 * Applied to every non-formula string rather than to the ones that look risky,
 * because the set of things Google's parser will have an opinion about is not
 * knowable from here, and a guard with an exception list is a guard that fails
 * on the input nobody thought of. AEH-317.
 */
function guardCell(value: string | number): string | number {
  if (typeof value === 'number') return value;
  if (value.length === 0) return value;
  if (value.startsWith('=')) return value;
  return `'${value}`;
}

/** Sheets wants colours as 0..1 floats, which is easy to get wrong by 255x. */
const rgb = (r: number, g: number, b: number) => ({ red: r / 255, green: g / 255, blue: b / 255 });

/**
 * How each row role actually looks. One table, so the file reads as one design
 * rather than as whatever each call site felt like.
 */
const ROW_STYLE_FORMAT: Record<RowStyle, Record<string, unknown>> = {
  // The "copy this before you edit it" warning. Amber, because it is the one
  // thing on the tab a reader must not skim past.
  banner: { backgroundColor: rgb(253, 240, 213), textFormat: { bold: true, foregroundColor: rgb(122, 79, 1) } },
  title: { textFormat: { bold: true, fontSize: 12 } },
  header: { backgroundColor: rgb(238, 234, 227), textFormat: { bold: true } },
  group: { backgroundColor: rgb(246, 244, 240), textFormat: { bold: true } },
  subtotal: { textFormat: { italic: true }, borders: { top: { style: 'SOLID', color: rgb(200, 194, 184) } } },
  total: { backgroundColor: rgb(232, 227, 218), textFormat: { bold: true } },
};

/**
 * Turn a tab's declared format into batchUpdate requests.
 *
 * Leads with a reset of the whole grid. The export rewrites values wholesale
 * but formatting is not a value: without this, a row that used to be a subtotal
 * keeps its border after the estimate shrinks and the row becomes something
 * else, and the sheet slowly accumulates the ghosts of previous exports.
 */
function formatRequests(sheetId: number, tab: SpreadsheetTab): Array<Record<string, unknown>> {
  const fmt = tab.format;
  if (!fmt) return [];
  const width = Math.max(1, ...tab.rows.map((r) => r.length));
  const requests: Array<Record<string, unknown>> = [
    { repeatCell: { range: { sheetId }, cell: {}, fields: 'userEnteredFormat' } },
  ];

  for (const { row, style } of fmt.rowStyles ?? []) {
    requests.push({
      repeatCell: {
        range: { sheetId, startRowIndex: row, endRowIndex: row + 1, startColumnIndex: 0, endColumnIndex: width },
        cell: { userEnteredFormat: ROW_STYLE_FORMAT[style] },
        fields: 'userEnteredFormat(backgroundColor,textFormat,borders)',
      },
    });
  }

  for (const column of fmt.numericColumns ?? []) {
    requests.push({
      repeatCell: {
        range: { sheetId, startColumnIndex: column, endColumnIndex: column + 1 },
        cell: { userEnteredFormat: { numberFormat: { type: 'NUMBER', pattern: '0.0' }, horizontalAlignment: 'RIGHT' } },
        fields: 'userEnteredFormat(numberFormat,horizontalAlignment)',
      },
    });
  }

  for (const { column, pixels } of fmt.columnWidths ?? []) {
    requests.push({
      updateDimensionProperties: {
        range: { sheetId, dimension: 'COLUMNS', startIndex: column, endIndex: column + 1 },
        properties: { pixelSize: pixels },
        fields: 'pixelSize',
      },
    });
  }

  for (const column of fmt.hiddenColumns ?? []) {
    requests.push({
      updateDimensionProperties: {
        range: { sheetId, dimension: 'COLUMNS', startIndex: column, endIndex: column + 1 },
        properties: { hiddenByUser: true },
        fields: 'hiddenByUser',
      },
    });
  }

  if (fmt.frozenRows !== undefined) {
    requests.push({
      updateSheetProperties: {
        properties: { sheetId, gridProperties: { frozenRowCount: fmt.frozenRows } },
        fields: 'gridProperties.frozenRowCount',
      },
    });
  }

  return requests;
}

const SPREADSHEET_MIME = 'application/vnd.google-apps.spreadsheet';

/**
 * Two failure modes cost this integration a month of being "done" while never
 * having run (AEH-232), because Google reports both of them in language that
 * points nowhere near the cause. Name them explicitly instead.
 */
const OWNERSHIP_HINT =
  'A service account has no Drive storage quota of its own, so it cannot own — and therefore cannot create — ' +
  'a file, even inside a folder it has writer access to. Google reports this variously as "storage quota has ' +
  'been exceeded", "The caller does not have permission" and even "The service is currently unavailable". Set ' +
  'GOOGLE_IMPERSONATE_SUBJECT to a Workspace user who has quota and grant this service account domain-wide ' +
  'delegation for the spreadsheets and drive.file scopes, so created files are owned by that user.';

const VISIBILITY_HINT =
  'The drive.file scope only ever sees files this app itself created, so a folder shared with the service ' +
  'account by a human is invisible to it and reads back as 404. Check that GOOGLE_DRIVE_FOLDER_ID is right, ' +
  'that the folder is shared with the service account (or with the impersonated user) as an editor, and that ' +
  'the folder is reachable under the scopes being requested.';

function explainSheetsError(err: unknown, action: string): Error {
  const message = err instanceof Error ? err.message : String(err);
  const hints: string[] = [];
  const looksLikeOwnership = /storage quota|storage.*exceeded|do not have storage|currently unavailable/i.test(message);
  const looksLikeVisibility = /not found|caller does not have permission|insufficient permission/i.test(message);

  // Creating is the step ownership breaks, and Google's permission wording
  // overlaps with a genuine visibility problem — so on create, lead with
  // ownership and offer visibility second.
  if (action.startsWith('creating')) {
    if (looksLikeOwnership || looksLikeVisibility) hints.push(OWNERSHIP_HINT);
    if (looksLikeVisibility) hints.push(VISIBILITY_HINT);
  } else {
    if (looksLikeVisibility) hints.push(VISIBILITY_HINT);
    if (looksLikeOwnership) hints.push(OWNERSHIP_HINT);
  }

  const suffix = hints.length > 0 ? `\n\n${hints.join('\n\n')}` : '';
  return new Error(`Google Sheets export failed while ${action}: ${message}${suffix}`, { cause: err });
}

/**
 * Real Google Sheets + Drive integration via a service account. Creates one
 * spreadsheet per estimate directly inside a shared Drive folder, tagged with
 * the estimate's id (Drive `appProperties`) so re-exports update in place
 * instead of duplicating.
 *
 * Two requirements that are easy to get wrong, both verified live under
 * AEH-232:
 *
 * 1. The service account must have edit access to the target folder (shared by
 *    a human owner — service accounts have no personal Drive of their own).
 * 2. Something with storage quota must own the created file. A service account
 *    has none, so `impersonateSubject` (domain-wide delegation) names the
 *    Workspace user to act as; without it, every create fails.
 */
export class LiveSheetsProvider implements ISheetsProvider {
  private readonly folderId: string;
  private readonly auth: InstanceType<typeof google.auth.JWT>;
  private authorized: Promise<void> | null = null;

  constructor(credentialsJson: string, folderId: string, impersonateSubject?: string | undefined) {
    this.folderId = folderId;
    const creds = JSON.parse(credentialsJson) as { client_email: string; private_key: string };
    // Constructing the JWT client does no network/crypto work — authorize()
    // (which does) is deferred to first actual use in clients(), so merely
    // instantiating this class (e.g. via createSheetsProvider()) never
    // produces an unhandled rejection from bad/placeholder credentials.
    this.auth = new google.auth.JWT({
      email: creds.client_email,
      key: creds.private_key,
      scopes: ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive.file'],
      // Domain-wide delegation: act as this Workspace user, so the files this
      // export creates are owned by (and charged to) a real account.
      ...(impersonateSubject ? { subject: impersonateSubject } : {}),
    });
  }

  private async clients() {
    this.authorized ??= this.auth.authorize().then(() => undefined);
    try {
      await this.authorized;
    } catch (err) {
      // A failed authorize must not be cached as a permanent poison pill, and
      // its message ("invalid_grant", "unauthorized_client") is the one that
      // tells you delegation was never granted for these scopes.
      this.authorized = null;
      throw explainSheetsError(err, 'authenticating with Google');
    }
    return {
      sheets: google.sheets({ version: 'v4', auth: this.auth }),
      drive: google.drive({ version: 'v3', auth: this.auth }),
    };
  }

  /**
   * Bring a spreadsheet's tabs to exactly `tabs`: add what is missing, drop the
   * ones this exporter owns and no longer produces, rewrite every value, then
   * apply formatting.
   *
   * `managedTitles` is the whole point of the ownership rule. Before AEH-317
   * this deleted every tab it did not itself produce, which meant an account
   * executive who added their own pricing tab to the exported file lost it
   * entirely — not blanked, deleted, along with any formula pointing into it —
   * the next time anybody pressed Export. A tab this exporter has never claimed
   * is somebody's work and is left alone.
   *
   * `ownsEverything` is the create path: the file was made by this call a
   * moment ago, so its default "Sheet1" is ours to remove even though no
   * exporter would ever list it as a managed title.
   */
  private async syncTabs(
    sheets: ReturnType<typeof google.sheets>,
    spreadsheetId: string,
    tabs: SpreadsheetTab[],
    opts: { managedTitles: Set<string>; ownsEverything: boolean },
  ): Promise<void> {
    const meta = await sheets.spreadsheets.get({ spreadsheetId });
    const existingSheets = meta.data.sheets ?? [];
    const existingTitles = new Set(existingSheets.map((s) => s.properties?.title ?? ''));
    const wantedTitles = new Set(tabs.map((t) => t.title));

    const requests: Array<Record<string, unknown>> = [];
    for (const t of tabs) {
      if (!existingTitles.has(t.title)) requests.push({ addSheet: { properties: { title: t.title } } });
    }
    // Requests inside one batch run in order, so the adds above already
    // guarantee a surviving sheet — a spreadsheet may never be left with zero.
    // That is why this can drop the default "Sheet1" of a freshly created file,
    // which a check against the pre-batch sheet count could not.
    const willHaveTabs = tabs.length > 0;
    for (const s of existingSheets) {
      const sheetTitle = s.properties?.title ?? '';
      const sheetId = s.properties?.sheetId;
      if (wantedTitles.has(sheetTitle) || sheetId === undefined) continue;
      if (!opts.ownsEverything && !opts.managedTitles.has(sheetTitle)) continue;
      if (willHaveTabs || existingSheets.length > 1) requests.push({ deleteSheet: { sheetId } });
    }
    if (requests.length > 0) {
      await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } });
    }

    // Clear + rewrite every tab's values fresh, so a shrinking export doesn't
    // leave stale rows behind. The clear stops at the width this export writes:
    // it used to run to column ZZ, which would take out anything somebody had
    // added to the right of the generated columns.
    const tabsWithData = tabs.filter((t) => t.rows.length > 0);
    if (tabsWithData.length > 0) {
      await sheets.spreadsheets.values.batchClear({
        spreadsheetId,
        requestBody: { ranges: tabs.map((t) => clearRange(t)) },
      });
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId,
        requestBody: {
          // Formulas are the export's whole reason for existing now: a summary
          // cell reads out of a department tab, so an edited hour moves every
          // number that depends on it. RAW would store "=SUMIF(...)" as those
          // nine characters of text. See guardCell for what this costs.
          valueInputOption: 'USER_ENTERED',
          data: tabsWithData.map((t) => ({
            range: tabRange(t),
            values: t.rows.map((row) => row.map(guardCell)),
          })),
        },
      });
    }

    // Ordering and formatting both need sheet ids, and any tab added above did
    // not have one when this method started — hence the second read rather than
    // unpicking the batch's replies.
    const after = await sheets.spreadsheets.get({ spreadsheetId });
    const idByTitle = new Map(
      (after.data.sheets ?? []).map((s) => [s.properties?.title ?? '', s.properties?.sheetId]),
    );

    // Tab order is not implied by anything Google does — an added sheet lands
    // at the end of the file. A spreadsheet migrating from the old per-role
    // layout already had QA, PM and BA, so Summary and Development were
    // appended after them and the tab the whole design insists opens first
    // opened fourth. Caught only by the live run; no offline test sees an
    // index Google assigned.
    //
    // Assigned ascending, which is what makes a plain sequence of moves land
    // where it is asked to: each request applies to the state the one before
    // it left behind. Tabs this exporter does not own keep their relative order
    // and follow the generated ones.
    const requestsAfter: Array<Record<string, unknown>> = tabs.flatMap((t, index) => {
      const sheetId = idByTitle.get(t.title);
      if (sheetId === undefined || sheetId === null) return [];
      return [{ updateSheetProperties: { properties: { sheetId, index }, fields: 'index' } }];
    });

    for (const t of tabs) {
      if (!t.format) continue;
      const sheetId = idByTitle.get(t.title);
      if (sheetId === undefined || sheetId === null) continue;
      requestsAfter.push(...formatRequests(sheetId, t));
    }

    if (requestsAfter.length > 0) {
      await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests: requestsAfter } });
    }
  }

  async createSpreadsheet(
    title: string,
    tabs: SpreadsheetTab[],
    estimateId: string,
    managedTitles?: string[],
  ): Promise<ExportResult> {
    const { sheets, drive } = await this.clients();

    // Create straight into the target folder. The previous shape — create via
    // the Sheets API, then re-parent — always landed the new file in the
    // caller's own My Drive first, which a service account does not have.
    let spreadsheetId: string;
    try {
      const created = await drive.files.create({
        requestBody: {
          name: title,
          mimeType: SPREADSHEET_MIME,
          parents: [this.folderId],
          appProperties: { estimateId },
        },
        fields: 'id',
        supportsAllDrives: true,
      });
      const id = created.data.id;
      if (!id) throw new Error('Drive create returned no file id');
      spreadsheetId = id;
    } catch (err) {
      throw explainSheetsError(err, `creating the spreadsheet in folder ${this.folderId}`);
    }

    try {
      // Everything in this file was put there by the create call a moment ago,
      // so there is nothing in it worth protecting — including Drive's own
      // default "Sheet1", which no caller would think to declare as managed.
      await this.syncTabs(sheets, spreadsheetId, tabs, {
        managedTitles: new Set(managedTitles ?? tabs.map((t) => t.title)),
        ownsEverything: true,
      });
    } catch (err) {
      throw explainSheetsError(err, `writing tabs into spreadsheet ${spreadsheetId}`);
    }

    return { spreadsheetId, url: `https://docs.google.com/spreadsheets/d/${spreadsheetId}` };
  }

  async updateSpreadsheet(
    spreadsheetId: string,
    tabs: SpreadsheetTab[],
    managedTitles?: string[],
  ): Promise<ExportResult> {
    const { sheets } = await this.clients();
    try {
      await this.syncTabs(sheets, spreadsheetId, tabs, {
        managedTitles: new Set(managedTitles ?? tabs.map((t) => t.title)),
        ownsEverything: false,
      });
    } catch (err) {
      throw explainSheetsError(err, `updating spreadsheet ${spreadsheetId}`);
    }
    return { spreadsheetId, url: `https://docs.google.com/spreadsheets/d/${spreadsheetId}` };
  }

  /**
   * Drive's own record of when the file last changed, used to notice that a
   * human edited the spreadsheet since this system last wrote to it.
   *
   * Returns null rather than throwing when Drive cannot be asked. This feeds a
   * warning, and a warning that can take the export down with it is worse than
   * no warning at all — the degradation is back to the pre-AEH-317 behaviour of
   * overwriting without asking, which is survivable, where a hard failure on a
   * courtesy check is not.
   */
  async getModifiedTime(spreadsheetId: string): Promise<Date | null> {
    try {
      const { drive } = await this.clients();
      const res = await drive.files.get({
        fileId: spreadsheetId,
        fields: 'modifiedTime',
        supportsAllDrives: true,
      });
      const raw = res.data.modifiedTime;
      if (!raw) return null;
      const at = new Date(raw);
      return Number.isNaN(at.getTime()) ? null : at;
    } catch {
      return null;
    }
  }

  /**
   * Read a spreadsheet's actual shape back: tab titles in order, each with its
   * header row and how many data rows landed. Deliberately not on
   * ISheetsProvider — nothing in the product ever reads an export back. It
   * exists so a live verification can assert what really arrived in Drive
   * instead of trusting that the write returned 200.
   */
  async describeTabs(
    spreadsheetId: string,
  ): Promise<Array<{ title: string; headers: string[]; dataRows: number; rows: Array<Array<string | number>> }>> {
    const { sheets } = await this.clients();
    try {
      const meta = await sheets.spreadsheets.get({ spreadsheetId });
      const titles = (meta.data.sheets ?? []).map((s) => s.properties?.title ?? '');
      if (titles.length === 0) return [];

      const values = await sheets.spreadsheets.values.batchGet({
        spreadsheetId,
        ranges: titles.map((t) => `'${t}'`),
      });
      const ranges = values.data.valueRanges ?? [];

      return titles.map((title, i) => {
        const rows = (ranges[i]?.values ?? []) as Array<Array<string | number>>;
        const [header = []] = rows;
        return {
          title,
          headers: header.map((c) => String(c)),
          dataRows: Math.max(0, rows.length - 1),
          // Rendered values, not formulas: the default render option gives what
          // a reader sees. That is exactly what makes it possible to prove the
          // formulas were evaluated rather than stored as text — a cell still
          // reading "=SUMIF(...)" here means the write went out as RAW.
          rows,
        };
      });
    } catch (err) {
      throw explainSheetsError(err, `reading spreadsheet ${spreadsheetId} back`);
    }
  }

  /**
   * Add an empty tab, standing in for one a person made themselves.
   *
   * Verification-only, and on the same footing as `describeTabs`: deliberately
   * not on ISheetsProvider, because nothing in the product creates a tab it does
   * not then fill. It exists so the live check can prove the thing AEH-317
   * actually fixed — that a re-export leaves somebody else's tab alone — which
   * no offline test can demonstrate, since the deletion happened inside Google.
   */
  async createBareTab(spreadsheetId: string, title: string): Promise<void> {
    const { sheets } = await this.clients();
    try {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: { requests: [{ addSheet: { properties: { title } } }] },
      });
    } catch (err) {
      throw explainSheetsError(err, `adding a tab named ${title} to spreadsheet ${spreadsheetId}`);
    }
  }

  async getSpreadsheetId(estimateId: string): Promise<string | null> {
    const { drive } = await this.clients();
    try {
      const res = await drive.files.list({
        q: `'${this.folderId}' in parents and appProperties has { key='estimateId' and value='${estimateId}' } and trashed=false`,
        fields: 'files(id)',
        pageSize: 1,
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
      });
      return res.data.files?.[0]?.id ?? null;
    } catch (err) {
      throw explainSheetsError(err, `looking up an existing export for estimate ${estimateId}`);
    }
  }
}

export function createSheetsProvider(): ISheetsProvider {
  const creds = process.env['GOOGLE_SERVICE_ACCOUNT_JSON'];
  const folderId = process.env['GOOGLE_DRIVE_FOLDER_ID'];
  if (!creds || !folderId) {
    return new StubSheetsProvider();
  }
  return new LiveSheetsProvider(creds, folderId, process.env['GOOGLE_IMPERSONATE_SUBJECT']);
}
