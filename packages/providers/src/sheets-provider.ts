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

/**
 * Real Google Sheets + Drive integration via a service account. Creates one
 * spreadsheet per estimate in a shared Drive folder, tagged with the
 * estimate's id (Drive `appProperties`) so re-exports update in place instead
 * of duplicating. Requires the service account to already have edit access
 * to the target folder (shared by a human owner — service accounts have no
 * personal Drive storage of their own).
 */
export class LiveSheetsProvider implements ISheetsProvider {
  private readonly folderId: string;
  private readonly auth: InstanceType<typeof google.auth.JWT>;
  private authorized: Promise<void> | null = null;

  constructor(credentialsJson: string, folderId: string) {
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
    });
  }

  private async clients() {
    this.authorized ??= this.auth.authorize().then(() => undefined);
    await this.authorized;
    return {
      sheets: google.sheets({ version: 'v4', auth: this.auth }),
      drive: google.drive({ version: 'v3', auth: this.auth }),
    };
  }

  async createSpreadsheet(title: string, tabs: SpreadsheetTab[], estimateId: string): Promise<ExportResult> {
    const { sheets, drive } = await this.clients();

    const created = await sheets.spreadsheets.create({
      requestBody: {
        properties: { title },
        sheets: tabs.map((t) => ({ properties: { title: t.title } })),
      },
    });
    const spreadsheetId = created.data.spreadsheetId;
    if (!spreadsheetId) throw new Error('Google Sheets create returned no spreadsheetId');

    if (tabs.some((t) => t.rows.length > 0)) {
      await sheets.spreadsheets.values.batchUpdate({
        spreadsheetId,
        requestBody: {
          valueInputOption: 'RAW',
          data: tabs.filter((t) => t.rows.length > 0).map((t) => ({ range: tabRange(t), values: t.rows })),
        },
      });
    }

    // Move out of the service account's own Drive space into the shared
    // folder, and tag with the estimateId for idempotent lookup later.
    const existing = await drive.files.get({ fileId: spreadsheetId, fields: 'parents' });
    await drive.files.update({
      fileId: spreadsheetId,
      addParents: this.folderId,
      removeParents: (existing.data.parents ?? []).join(','),
      requestBody: { appProperties: { estimateId } },
    });

    return { spreadsheetId, url: `https://docs.google.com/spreadsheets/d/${spreadsheetId}` };
  }

  async updateSpreadsheet(spreadsheetId: string, tabs: SpreadsheetTab[]): Promise<ExportResult> {
    const { sheets } = await this.clients();

    const meta = await sheets.spreadsheets.get({ spreadsheetId });
    const existingSheets = meta.data.sheets ?? [];
    const existingByTitle = new Map(existingSheets.map((s) => [s.properties?.title ?? '', s.properties?.sheetId]));
    const wantedTitles = new Set(tabs.map((t) => t.title));

    const requests: Array<Record<string, unknown>> = [];
    // Add sheets that don't exist yet.
    for (const t of tabs) {
      if (!existingByTitle.has(t.title)) {
        requests.push({ addSheet: { properties: { title: t.title } } });
      }
    }
    // Drop sheets from a previous export shape that this export no longer produces.
    for (const s of existingSheets) {
      const sheetTitle = s.properties?.title ?? '';
      const sheetId = s.properties?.sheetId;
      if (!wantedTitles.has(sheetTitle) && sheetId !== undefined && existingSheets.length > 1) {
        requests.push({ deleteSheet: { sheetId } });
      }
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

    return { spreadsheetId, url: `https://docs.google.com/spreadsheets/d/${spreadsheetId}` };
  }

  async getSpreadsheetId(estimateId: string): Promise<string | null> {
    const { drive } = await this.clients();
    const res = await drive.files.list({
      q: `'${this.folderId}' in parents and appProperties has { key='estimateId' and value='${estimateId}' } and trashed=false`,
      fields: 'files(id)',
      pageSize: 1,
    });
    return res.data.files?.[0]?.id ?? null;
  }
}

export function createSheetsProvider(): ISheetsProvider {
  const creds = process.env['GOOGLE_SERVICE_ACCOUNT_JSON'];
  const folderId = process.env['GOOGLE_DRIVE_FOLDER_ID'];
  if (!creds || !folderId) {
    return new StubSheetsProvider();
  }
  return new LiveSheetsProvider(creds, folderId);
}
