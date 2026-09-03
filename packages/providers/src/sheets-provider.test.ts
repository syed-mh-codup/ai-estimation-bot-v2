import { describe, it, expect, vi, beforeEach } from 'vitest';
// vi.mock below is hoisted above this import, so the mocked googleapis is in place.
import { LiveSheetsProvider, StubSheetsProvider, createSheetsProvider } from './sheets-provider';

// AEH-232: the live export path had never run. These tests pin the two things
// that were actually broken — where the file gets created, and whether a
// failure explains itself — against a mocked googleapis.

const h = vi.hoisted(() => ({
  jwtOptions: [] as Array<Record<string, unknown>>,
  authorize: vi.fn<() => Promise<unknown>>(),
  driveFilesCreate: vi.fn(),
  driveFilesList: vi.fn(),
  driveFilesGet: vi.fn(),
  driveFilesUpdate: vi.fn(),
  spreadsheetsCreate: vi.fn(),
  spreadsheetsGet: vi.fn(),
  spreadsheetsBatchUpdate: vi.fn(),
  valuesBatchClear: vi.fn(),
  valuesBatchUpdate: vi.fn(),
}));

vi.mock('googleapis', () => ({
  google: {
    auth: {
      JWT: class {
        constructor(options: Record<string, unknown>) {
          h.jwtOptions.push(options);
        }
        authorize = h.authorize;
      },
    },
    sheets: () => ({
      spreadsheets: {
        create: h.spreadsheetsCreate,
        get: h.spreadsheetsGet,
        batchUpdate: h.spreadsheetsBatchUpdate,
        values: { batchClear: h.valuesBatchClear, batchUpdate: h.valuesBatchUpdate },
      },
    }),
    drive: () => ({
      files: {
        create: h.driveFilesCreate,
        list: h.driveFilesList,
        get: h.driveFilesGet,
        update: h.driveFilesUpdate,
      },
    }),
  },
}));

const CREDS = JSON.stringify({ client_email: 'bot@project.iam.gserviceaccount.com', private_key: 'pem' });
const FOLDER = 'folder-abc';
const TABS = [
  { title: 'DEV', rows: [['Item', 'Base Hours'], ['Login', 4]] },
  { title: 'Roll-Up', rows: [['Role', 'Total']] },
];

beforeEach(() => {
  h.jwtOptions.length = 0;
  for (const fn of [
    h.authorize, h.driveFilesCreate, h.driveFilesList, h.driveFilesGet, h.driveFilesUpdate,
    h.spreadsheetsCreate, h.spreadsheetsGet, h.spreadsheetsBatchUpdate, h.valuesBatchClear, h.valuesBatchUpdate,
  ]) fn.mockReset();

  h.authorize.mockResolvedValue({});
  h.driveFilesCreate.mockResolvedValue({ data: { id: 'sheet-1' } });
  // A freshly created spreadsheet carries exactly one default tab.
  h.spreadsheetsGet.mockResolvedValue({ data: { sheets: [{ properties: { title: 'Sheet1', sheetId: 0 } }] } });
  h.spreadsheetsBatchUpdate.mockResolvedValue({ data: {} });
  h.valuesBatchClear.mockResolvedValue({ data: {} });
  h.valuesBatchUpdate.mockResolvedValue({ data: {} });
  h.driveFilesList.mockResolvedValue({ data: { files: [] } });
});

describe('AEH-232: where the spreadsheet gets created', () => {
  it('creates directly inside the target folder, tagged for idempotency', async () => {
    const p = new LiveSheetsProvider(CREDS, FOLDER);
    const res = await p.createSpreadsheet('Acme — Estimate', TABS, 'est-42');

    expect(h.driveFilesCreate).toHaveBeenCalledTimes(1);
    const arg = h.driveFilesCreate.mock.calls[0]?.[0] as {
      requestBody: { name: string; mimeType: string; parents: string[]; appProperties: Record<string, string> };
      supportsAllDrives?: boolean;
    };
    expect(arg.requestBody.parents).toEqual([FOLDER]);
    expect(arg.requestBody.mimeType).toBe('application/vnd.google-apps.spreadsheet');
    expect(arg.requestBody.appProperties).toEqual({ estimateId: 'est-42' });
    expect(arg.requestBody.name).toBe('Acme — Estimate');
    expect(arg.supportsAllDrives).toBe(true);
    expect(res).toEqual({ spreadsheetId: 'sheet-1', url: 'https://docs.google.com/spreadsheets/d/sheet-1' });
  });

  it('never takes the old My Drive hop — a service account has no My Drive', async () => {
    const p = new LiveSheetsProvider(CREDS, FOLDER);
    await p.createSpreadsheet('T', TABS, 'est-42');

    // The previous shape called sheets.spreadsheets.create and then re-parented
    // the file with drive.files.update. Both are what failed on quota.
    expect(h.spreadsheetsCreate).not.toHaveBeenCalled();
    expect(h.driveFilesUpdate).not.toHaveBeenCalled();
  });

  it('replaces the default Sheet1 with the export tabs in one batch', async () => {
    const p = new LiveSheetsProvider(CREDS, FOLDER);
    await p.createSpreadsheet('T', TABS, 'est-42');

    const body = h.spreadsheetsBatchUpdate.mock.calls[0]?.[0] as {
      requestBody: { requests: Array<Record<string, { properties?: { title?: string }; sheetId?: number }>> };
    };
    const requests = body.requestBody.requests;
    const added = requests.filter((r) => r['addSheet']).map((r) => r['addSheet']?.properties?.title);
    const deleted = requests.filter((r) => r['deleteSheet']).map((r) => r['deleteSheet']?.sheetId);

    expect(added).toEqual(['DEV', 'Roll-Up']);
    // The add requests run first, so deleting the only pre-existing sheet is
    // safe — the guard that used to require >1 existing sheet left Sheet1 behind.
    expect(deleted).toEqual([0]);
    expect(requests.findIndex((r) => r['deleteSheet'])).toBeGreaterThan(requests.findIndex((r) => r['addSheet']));
  });

  it('writes only the tabs that have rows', async () => {
    const p = new LiveSheetsProvider(CREDS, FOLDER);
    await p.createSpreadsheet('T', [...TABS, { title: 'BA', rows: [] }], 'est-42');

    const body = h.valuesBatchUpdate.mock.calls[0]?.[0] as {
      requestBody: { data: Array<{ range: string }>; valueInputOption: string };
    };
    expect(body.requestBody.data.map((d) => d.range)).toEqual(["'DEV'!A1:B2", "'Roll-Up'!A1:B1"]);
    expect(body.requestBody.valueInputOption).toBe('RAW');
  });
});

describe('AEH-232: domain-wide delegation', () => {
  it('impersonates the configured subject', async () => {
    const p = new LiveSheetsProvider(CREDS, FOLDER, 'person@codup.co');
    await p.getSpreadsheetId('est-42');
    expect(h.jwtOptions[0]?.['subject']).toBe('person@codup.co');
  });

  it('omits subject entirely when none is configured', async () => {
    const p = new LiveSheetsProvider(CREDS, FOLDER);
    await p.getSpreadsheetId('est-42');
    expect(h.jwtOptions[0]).not.toHaveProperty('subject');
  });

  it('factory wires GOOGLE_IMPERSONATE_SUBJECT through', async () => {
    process.env['GOOGLE_SERVICE_ACCOUNT_JSON'] = CREDS;
    process.env['GOOGLE_DRIVE_FOLDER_ID'] = FOLDER;
    process.env['GOOGLE_IMPERSONATE_SUBJECT'] = 'owner@codup.co';
    try {
      const p = createSheetsProvider();
      expect(p).toBeInstanceOf(LiveSheetsProvider);
      await p.getSpreadsheetId('est-42');
      expect(h.jwtOptions[0]?.['subject']).toBe('owner@codup.co');
    } finally {
      delete process.env['GOOGLE_SERVICE_ACCOUNT_JSON'];
      delete process.env['GOOGLE_DRIVE_FOLDER_ID'];
      delete process.env['GOOGLE_IMPERSONATE_SUBJECT'];
    }
  });

  it('still falls back to the stub without credentials', () => {
    delete process.env['GOOGLE_SERVICE_ACCOUNT_JSON'];
    delete process.env['GOOGLE_DRIVE_FOLDER_ID'];
    expect(createSheetsProvider()).toBeInstanceOf(StubSheetsProvider);
  });
});

describe('AEH-232: failures explain themselves', () => {
  it('a quota failure on create names the ownership cause', async () => {
    h.driveFilesCreate.mockRejectedValue(new Error("The user's Drive storage quota has been exceeded."));
    const p = new LiveSheetsProvider(CREDS, FOLDER);

    await expect(p.createSpreadsheet('T', TABS, 'est-42')).rejects.toThrow(/GOOGLE_IMPERSONATE_SUBJECT/);
    await expect(p.createSpreadsheet('T', TABS, 'est-42')).rejects.toThrow(/no Drive storage quota of its own/);
  });

  it("Google's misleading wordings all reach the ownership hint", async () => {
    const p = new LiveSheetsProvider(CREDS, FOLDER);
    for (const message of ['The caller does not have permission', 'The service is currently unavailable.']) {
      h.driveFilesCreate.mockRejectedValue(new Error(message));
      await expect(p.createSpreadsheet('T', TABS, 'est-42')).rejects.toThrow(/domain-wide\s+delegation/);
    }
  });

  it('a 404 on lookup names the scope/sharing cause and keeps the original message', async () => {
    h.driveFilesList.mockRejectedValue(new Error('File not found: folder-abc.'));
    const p = new LiveSheetsProvider(CREDS, FOLDER);

    let err: unknown;
    try {
      await p.getSpreadsheetId('est-42');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    const asError = err as Error;
    expect(asError.message).toMatch(/drive\.file scope only ever sees files this app itself created/);
    expect(asError.message).toMatch(/File not found: folder-abc/);
    expect(asError.cause).toBeInstanceOf(Error);
  });

  it('a failed authorize is not cached as a poison pill', async () => {
    h.authorize.mockRejectedValueOnce(new Error('unauthorized_client'));
    const p = new LiveSheetsProvider(CREDS, FOLDER);

    await expect(p.getSpreadsheetId('est-42')).rejects.toThrow(/unauthorized_client/);
    // Second call re-authorizes rather than replaying the cached rejection.
    h.authorize.mockResolvedValue({});
    await expect(p.getSpreadsheetId('est-42')).resolves.toBeNull();
    expect(h.authorize).toHaveBeenCalledTimes(2);
  });
});

describe('AEH-232: idempotency lookup', () => {
  it('queries by appProperties with the all-drives flags set', async () => {
    h.driveFilesList.mockResolvedValue({ data: { files: [{ id: 'existing-sheet' }] } });
    const p = new LiveSheetsProvider(CREDS, FOLDER);

    expect(await p.getSpreadsheetId('est-42')).toBe('existing-sheet');
    const arg = h.driveFilesList.mock.calls[0]?.[0] as {
      q: string; supportsAllDrives?: boolean; includeItemsFromAllDrives?: boolean;
    };
    expect(arg.q).toContain("'folder-abc' in parents");
    expect(arg.q).toContain("value='est-42'");
    expect(arg.supportsAllDrives).toBe(true);
    expect(arg.includeItemsFromAllDrives).toBe(true);
  });

  it('returns null when nothing is tagged yet', async () => {
    const p = new LiveSheetsProvider(CREDS, FOLDER);
    expect(await p.getSpreadsheetId('est-none')).toBeNull();
  });
});
