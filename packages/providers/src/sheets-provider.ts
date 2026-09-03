import { google } from 'googleapis';

export type SpreadsheetTab = {
  title: string;
  rows: Array<Array<string | number>>;
};

export type ExportResult = {
  spreadsheetId: string;
  url: string;
};

export interface ISheetsProvider {
  /** estimateId is used for idempotency tracking (tagging the created file so a later export can find it). */
  createSpreadsheet(title: string, tabs: SpreadsheetTab[], estimateId: string): Promise<ExportResult>;
  updateSpreadsheet(spreadsheetId: string, tabs: SpreadsheetTab[]): Promise<ExportResult>;
  getSpreadsheetId(estimateId: string): Promise<string | null>;
}

/**
 * Stub implementation — returns synthetic spreadsheet data, used when
 * GOOGLE_SERVICE_ACCOUNT_JSON/GOOGLE_DRIVE_FOLDER_ID are not configured.
 */
export class StubSheetsProvider implements ISheetsProvider {
  private readonly store = new Map<string, string>();

  async createSpreadsheet(_title: string, _tabs: SpreadsheetTab[], estimateId: string): Promise<ExportResult> {
    const id = `stub-sheet-${Date.now()}`;
    this.store.set(estimateId, id);
    return {
      spreadsheetId: id,
      url: `https://docs.google.com/spreadsheets/d/${id}`,
    };
  }

  async updateSpreadsheet(spreadsheetId: string, _tabs: SpreadsheetTab[]): Promise<ExportResult> {
    return {
      spreadsheetId,
      url: `https://docs.google.com/spreadsheets/d/${spreadsheetId}`,
    };
  }

  async getSpreadsheetId(estimateId: string): Promise<string | null> {
    return this.store.get(estimateId) ?? null;
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

function tabRange(tab: SpreadsheetTab): string {
  const lastCol = columnLetter(Math.max(0, (tab.rows[0]?.length ?? 1) - 1));
  return `'${tab.title}'!A1:${lastCol}${Math.max(1, tab.rows.length)}`;
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
   * Bring a spreadsheet's tabs to exactly `tabs`: add what is missing, drop
   * what this export no longer produces, then rewrite every value. Shared by
   * create (against a one-sheet new file) and update.
   */
  private async syncTabs(
    sheets: ReturnType<typeof google.sheets>,
    spreadsheetId: string,
    tabs: SpreadsheetTab[],
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
      if (willHaveTabs || existingSheets.length > 1) requests.push({ deleteSheet: { sheetId } });
    }
    if (requests.length > 0) {
      await sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } });
    }

    // Clear + rewrite every tab's values fresh, so a shrinking export doesn't
    // leave stale rows behind.
    const tabsWithData = tabs.filter((t) => t.rows.length > 0);
    if (tabsWithData.length > 0) {
      await sheets.spreadsheets.values.batchClear({
        spreadsheetId,
        requestBody: { ranges: tabs.map((t) => `'${t.title}'!A1:ZZ10000`) },
      });
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId,
        requestBody: {
          valueInputOption: 'RAW',
          data: tabsWithData.map((t) => ({ range: tabRange(t), values: t.rows })),
        },
      });
    }
  }

  async createSpreadsheet(title: string, tabs: SpreadsheetTab[], estimateId: string): Promise<ExportResult> {
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
      await this.syncTabs(sheets, spreadsheetId, tabs);
    } catch (err) {
      throw explainSheetsError(err, `writing tabs into spreadsheet ${spreadsheetId}`);
    }

    return { spreadsheetId, url: `https://docs.google.com/spreadsheets/d/${spreadsheetId}` };
  }

  async updateSpreadsheet(spreadsheetId: string, tabs: SpreadsheetTab[]): Promise<ExportResult> {
    const { sheets } = await this.clients();
    try {
      await this.syncTabs(sheets, spreadsheetId, tabs);
    } catch (err) {
      throw explainSheetsError(err, `updating spreadsheet ${spreadsheetId}`);
    }
    return { spreadsheetId, url: `https://docs.google.com/spreadsheets/d/${spreadsheetId}` };
  }

  /**
   * Read a spreadsheet's actual shape back: tab titles in order, each with its
   * header row and how many data rows landed. Deliberately not on
   * ISheetsProvider — nothing in the product ever reads an export back. It
   * exists so a live verification can assert what really arrived in Drive
   * instead of trusting that the write returned 200.
   */
  async describeTabs(spreadsheetId: string): Promise<Array<{ title: string; headers: string[]; dataRows: number }>> {
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
        };
      });
    } catch (err) {
      throw explainSheetsError(err, `reading spreadsheet ${spreadsheetId} back`);
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
