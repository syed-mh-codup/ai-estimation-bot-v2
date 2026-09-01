import { describe, it, expect, vi, beforeEach } from 'vitest';
// vi.mock below is hoisted above this import.
import { diagnoseSheetsConfig, formatDiagnosis } from './sheets-diagnostics';

const h = vi.hoisted(() => ({
  jwtOptions: [] as Array<Record<string, unknown>>,
  authorize: vi.fn<() => Promise<unknown>>(),
  filesGet: vi.fn(),
  filesList: vi.fn(),
  aboutGet: vi.fn(),
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
    drive: () => ({ files: { get: h.filesGet, list: h.filesList }, about: { get: h.aboutGet } }),
    sheets: () => ({ spreadsheets: {} }),
  },
}));

const KEY = '-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----\n';
const CREDS = JSON.stringify({
  client_email: 'bot@proj.iam.gserviceaccount.com',
  private_key: KEY,
  client_id: '110768422158258397617',
  project_id: 'proj',
});
const FOLDER = 'folder-abc';

const env = (over: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  GOOGLE_SERVICE_ACCOUNT_JSON: CREDS,
  GOOGLE_DRIVE_FOLDER_ID: FOLDER,
  ...over,
});

const FOLDER_OK = {
  data: {
    id: FOLDER,
    name: 'AI Estimates',
    mimeType: 'application/vnd.google-apps.folder',
    capabilities: { canAddChildren: true },
  },
};

const statusOf = (d: Awaited<ReturnType<typeof diagnoseSheetsConfig>>, name: string) =>
  d.checks.find((c) => c.name === name)?.status;

beforeEach(() => {
  h.jwtOptions.length = 0;
  for (const fn of [h.authorize, h.filesGet, h.filesList, h.aboutGet]) fn.mockReset();
  h.authorize.mockResolvedValue({});
  h.filesGet.mockResolvedValue(FOLDER_OK);
  h.filesList.mockResolvedValue({ data: { files: [] } });
  h.aboutGet.mockResolvedValue({ data: { user: { emailAddress: 'person@codup.co' }, storageQuota: { limit: '1000', usage: '10' } } });
});

describe('AEH-232 diagnostics: configuration faults', () => {
  it('reports the stub fallback when the env vars are absent', async () => {
    const d = await diagnoseSheetsConfig({});
    expect(d.configured).toBe(false);
    expect(d.ok).toBe(false);
    expect(d.checks[0]?.detail).toMatch(/stub provider, which fabricates a URL/);
  });

  it('catches credentials that are not JSON before any network call', async () => {
    const d = await diagnoseSheetsConfig(env({ GOOGLE_SERVICE_ACCOUNT_JSON: 'not-json' }));
    expect(statusOf(d, 'credentials parse')).toBe('fail');
    expect(h.authorize).not.toHaveBeenCalled();
  });

  it('catches a private key whose newlines were escaped', async () => {
    const broken = JSON.stringify({ client_email: 'a@b.com', private_key: '-----BEGIN X-----\\nabc' });
    const d = await diagnoseSheetsConfig(env({ GOOGLE_SERVICE_ACCOUNT_JSON: broken }));
    expect(statusOf(d, 'credentials parse')).toBe('fail');
    expect(d.remedy).toMatch(/real newlines/);
  });

  it('turns an unauthorized_client into the delegation instructions, with the client id', async () => {
    h.authorize.mockRejectedValue(new Error('unauthorized_client'));
    const d = await diagnoseSheetsConfig(env({ GOOGLE_IMPERSONATE_SUBJECT: 'person@codup.co' }));
    expect(statusOf(d, 'authorize')).toBe('fail');
    expect(d.remedy).toMatch(/Domain-wide delegation/);
    expect(d.remedy).toMatch(/110768422158258397617/);
    expect(d.remedy).toMatch(/person@codup\.co — the grant above is what is missing/);
  });

  it('passes the impersonation subject to the JWT', async () => {
    await diagnoseSheetsConfig(env({ GOOGLE_IMPERSONATE_SUBJECT: 'person@codup.co' }));
    expect(h.jwtOptions[0]?.['subject']).toBe('person@codup.co');
  });
});

describe('AEH-232 diagnostics: the two faults that were actually live', () => {
  it('a folder invisible to drive.file but visible to metadata scope warns, and does not stop the run', async () => {
    h.filesGet
      .mockRejectedValueOnce(new Error('File not found: folder-abc.'))
      .mockResolvedValueOnce(FOLDER_OK);

    const d = await diagnoseSheetsConfig(env({ GOOGLE_IMPERSONATE_SUBJECT: 'person@codup.co' }));

    expect(statusOf(d, 'target folder')).toBe('warn');
    // The decisive check still runs — returning early here is what hid the real
    // blocker in the first draft of this diagnosis.
    expect(statusOf(d, 'file ownership')).toBe('pass');
    expect(d.ok).toBe(true);
    expect(d.notes.join('\n')).toMatch(/re-exports would duplicate instead of/);
  });

  it('the metadata fallback probe never impersonates — a DWD grant is per-scope', async () => {
    // The regression this guards: with delegation granted for exactly
    // spreadsheets + drive.file, a probe that asked for
    // drive.metadata.readonly AS THE SUBJECT would fail unauthorized_client,
    // and the diagnosis would wrongly announce that nobody can see the folder
    // on a correctly configured install.
    h.filesGet.mockRejectedValueOnce(new Error('File not found: folder-abc.')).mockResolvedValueOnce(FOLDER_OK);
    const d = await diagnoseSheetsConfig(env({ GOOGLE_IMPERSONATE_SUBJECT: 'person@codup.co' }));

    expect(h.jwtOptions).toHaveLength(2);
    expect(h.jwtOptions[0]?.['subject']).toBe('person@codup.co'); // the real client impersonates
    expect(h.jwtOptions[1]).not.toHaveProperty('subject'); // the probe must not
    expect(h.jwtOptions[1]?.['scopes']).toEqual(['https://www.googleapis.com/auth/drive.metadata.readonly']);
    expect(statusOf(d, 'target folder')).toBe('warn');
    expect(d.ok).toBe(true);
  });

  it('survives the probe token being refused outright', async () => {
    // Even if the probe cannot authorize for any reason, the diagnosis must
    // still reach a verdict rather than throwing.
    h.filesGet.mockRejectedValue(new Error('File not found: folder-abc.'));
    h.authorize.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('unauthorized_client'));

    const d = await diagnoseSheetsConfig(env({ GOOGLE_IMPERSONATE_SUBJECT: 'person@codup.co' }));
    expect(statusOf(d, 'target folder')).toBe('fail');
    expect(d.ok).toBe(false);
  });

  it('a folder nothing can see is terminal', async () => {
    h.filesGet.mockRejectedValue(new Error('File not found: folder-abc.'));
    const d = await diagnoseSheetsConfig(env());
    expect(statusOf(d, 'target folder')).toBe('fail');
    expect(d.ok).toBe(false);
    expect(d.remedy).toMatch(/share the folder with bot@proj\.iam\.gserviceaccount\.com as an Editor/i);
  });

  it('a zero storage quota fails with the delegation remedy — the real AEH-232 blocker', async () => {
    h.aboutGet.mockResolvedValue({
      data: { user: { emailAddress: 'bot@proj.iam.gserviceaccount.com' }, storageQuota: { limit: '0', usage: '0' } },
    });
    const d = await diagnoseSheetsConfig(env());

    expect(statusOf(d, 'file ownership')).toBe('fail');
    expect(d.ok).toBe(false);
    expect(d.remedy).toMatch(/GOOGLE_IMPERSONATE_SUBJECT/);
    expect(d.remedy).toMatch(/no Drive storage quota/);
  });

  it('a shared drive makes the quota question moot', async () => {
    h.filesGet.mockResolvedValue({ data: { ...FOLDER_OK.data, driveId: 'shared-drive-1' } });
    h.aboutGet.mockResolvedValue({ data: { user: { emailAddress: 'bot@proj.iam.gserviceaccount.com' }, storageQuota: { limit: '0' } } });

    const d = await diagnoseSheetsConfig(env());
    expect(statusOf(d, 'file ownership')).toBe('pass');
    expect(d.checks.find((c) => c.name === 'file ownership')?.detail).toMatch(/shared drive shared-drive-1/);
    expect(d.ok).toBe(true);
  });

  it('a folder id pointing at a file, not a folder, is caught', async () => {
    h.filesGet.mockResolvedValue({ data: { ...FOLDER_OK.data, mimeType: 'application/pdf' } });
    const d = await diagnoseSheetsConfig(env());
    expect(statusOf(d, 'target folder')).toBe('fail');
    expect(d.remedy).toMatch(/must be a folder id/);
  });

  it('reports a healthy configuration as usable', async () => {
    const d = await diagnoseSheetsConfig(env({ GOOGLE_IMPERSONATE_SUBJECT: 'person@codup.co' }));
    expect(d.ok).toBe(true);
    expect(d.remedy).toBeNull();
    expect(d.checks.every((c) => c.status === 'pass')).toBe(true);
    expect(formatDiagnosis(d)).toMatch(/Configuration looks usable/);
  });

  it('formats a warned-but-passing run as a caveat, not a next step', async () => {
    h.filesGet.mockRejectedValueOnce(new Error('File not found.')).mockResolvedValueOnce(FOLDER_OK);
    const d = await diagnoseSheetsConfig(env({ GOOGLE_IMPERSONATE_SUBJECT: 'person@codup.co' }));
    const text = formatDiagnosis(d);
    expect(text).toMatch(/No blocking fault found, but see the caveat below/);
    expect(text).toMatch(/Caveat:/);
  });
});
