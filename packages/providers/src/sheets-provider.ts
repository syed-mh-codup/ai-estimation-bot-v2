// BLOCKED-CREDENTIAL: Google service account credentials required.
// Replace StubSheetsProvider with LiveSheetsProvider when GOOGLE_SERVICE_ACCOUNT_JSON is available.

export type SpreadsheetTab = {
  title: string;
  rows: Array<Array<string | number>>;
};

export type ExportResult = {
  spreadsheetId: string;
  url: string;
};

export interface ISheetsProvider {
  createSpreadsheet(title: string, tabs: SpreadsheetTab[]): Promise<ExportResult>;
  updateSpreadsheet(spreadsheetId: string, tabs: SpreadsheetTab[]): Promise<ExportResult>;
  getSpreadsheetId(estimateId: string): Promise<string | null>;
}

/**
 * BLOCKED-CREDENTIAL: Stub implementation — returns synthetic spreadsheet data.
 * Used when GOOGLE_SERVICE_ACCOUNT_JSON is not configured.
 */
export class StubSheetsProvider implements ISheetsProvider {
  private readonly store = new Map<string, string>();

  async createSpreadsheet(title: string, _tabs: SpreadsheetTab[]): Promise<ExportResult> {
    const id = `stub-sheet-${Date.now()}`;
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

export function createSheetsProvider(): ISheetsProvider {
  const creds = process.env['GOOGLE_SERVICE_ACCOUNT_JSON'];
  if (!creds) {
    return new StubSheetsProvider();
  }
  // BLOCKED-CREDENTIAL: LiveSheetsProvider would be instantiated here
  return new StubSheetsProvider();
}
