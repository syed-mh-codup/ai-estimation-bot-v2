import { google } from 'googleapis';

/**
 * Read-only diagnosis of the Google Sheets export configuration.
 *
 * AEH-232 existed because this integration reported "done" for a month while
 * never having run once: the failure only appeared when a real export was
 * attempted, and Google's message for it ("The caller does not have
 * permission") pointed at sharing when the real cause was file ownership.
 * Every check here is a GET — it never creates, moves or deletes anything —
 * so it is safe to run against production config.
 */

export type CheckStatus = 'pass' | 'fail' | 'warn' | 'skip';

export type DiagnosticCheck = {
  name: string;
  status: CheckStatus;
  detail: string;
};

export type SheetsDiagnosis = {
  /** False if any check failed. */
  ok: boolean;
  /** False when the env vars are absent and the app would use the stub. */
  configured: boolean;
  serviceAccount: { clientEmail: string; clientId: string; projectId: string } | null;
  impersonating: string | null;
  folderId: string | null;
  checks: DiagnosticCheck[];
  /** Non-fatal observations worth knowing before trusting a live run. */
  notes: string[];
  /** Actionable next step when something is wrong, already formatted for a terminal. */
  remedy: string | null;
};

const SCOPES = ['https://www.googleapis.com/auth/spreadsheets', 'https://www.googleapis.com/auth/drive.file'];
const METADATA_SCOPE = 'https://www.googleapis.com/auth/drive.metadata.readonly';

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function delegationRemedy(clientId: string, subject: string | null): string {
  return [
    'Grant this service account domain-wide delegation, then set GOOGLE_IMPERSONATE_SUBJECT:',
    '',
    '  Google Admin console -> Security -> Access and data control',
    '    -> API controls -> Domain-wide delegation -> Add new',
    '',
    `  Client ID: ${clientId}`,
    `  OAuth scopes: ${SCOPES.join(', ')}`,
    '',
    subject
      ? `  GOOGLE_IMPERSONATE_SUBJECT is set to ${subject} — the grant above is what is missing.`
      : '  Then set GOOGLE_IMPERSONATE_SUBJECT to a Workspace user who owns Drive storage.',
    '',
    'Why: a service account has no Drive storage quota, so it cannot own a file and',
    'therefore cannot create one — not even inside a folder it can write to.',
  ].join('\n');
}

export async function diagnoseSheetsConfig(env: NodeJS.ProcessEnv = process.env): Promise<SheetsDiagnosis> {
  const checks: DiagnosticCheck[] = [];
  const push = (name: string, status: CheckStatus, detail: string) => checks.push({ name, status, detail });
  // A warning is something to know about, not something that stops the run; only
  // a FAIL sets the remedy, and only the first one does — the earliest failing
  // check is the one worth acting on.
  const notes: string[] = [];
  let remedy: string | null = null;
  const setRemedy = (text: string) => {
    remedy ??= text;
  };

  const rawCreds = env['GOOGLE_SERVICE_ACCOUNT_JSON'] ?? '';
  const folderId = env['GOOGLE_DRIVE_FOLDER_ID'] ?? '';
  const subject = env['GOOGLE_IMPERSONATE_SUBJECT'] ?? '';

  const result: SheetsDiagnosis = {
    ok: false,
    configured: Boolean(rawCreds && folderId),
    serviceAccount: null,
    impersonating: subject || null,
    folderId: folderId || null,
    checks,
    notes: [],
    remedy: null,
  };

  if (!result.configured) {
    push(
      'environment',
      'fail',
      `GOOGLE_SERVICE_ACCOUNT_JSON ${rawCreds ? 'set' : 'MISSING'}, GOOGLE_DRIVE_FOLDER_ID ${folderId ? 'set' : 'MISSING'} — the app falls back to the stub provider, which fabricates a URL and exports nothing.`,
    );
    result.remedy = 'Set both GOOGLE_SERVICE_ACCOUNT_JSON and GOOGLE_DRIVE_FOLDER_ID; without them no export happens at all.';
    return result;
  }
  push('environment', 'pass', `credentials present, folder ${folderId}${subject ? `, impersonating ${subject}` : ', no impersonation configured'}`);

  // ── credentials parse
  let creds: { client_email?: string; private_key?: string; client_id?: string; project_id?: string };
  try {
    creds = JSON.parse(rawCreds) as typeof creds;
  } catch (err) {
    push('credentials parse', 'fail', `GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON: ${errText(err)}`);
    result.remedy = 'Re-paste the service account JSON as a single line; the constructor calls JSON.parse on it and throws before any network call.';
    return result;
  }
  const clientEmail = creds.client_email ?? '';
  const privateKey = creds.private_key ?? '';
  result.serviceAccount = {
    clientEmail,
    clientId: creds.client_id ?? '(no client_id in the JSON)',
    projectId: creds.project_id ?? '(unknown)',
  };

  if (!clientEmail || !privateKey) {
    push('credentials parse', 'fail', 'the JSON is missing client_email or private_key.');
    result.remedy = 'Download a fresh service account key; this one is not a usable credential.';
    return result;
  }
  if (privateKey.includes('\\n')) {
    push('credentials parse', 'fail', 'private_key contains literal \\n sequences instead of real newlines — the usual .env escaping mistake.');
    result.remedy = 'Store the JSON so that private_key keeps real newlines (or unescape \\n before use).';
    return result;
  }
  push('credentials parse', 'pass', `${clientEmail} (project ${result.serviceAccount.projectId})`);

  // ── authorize, exactly as the provider does
  const auth = new google.auth.JWT({
    email: clientEmail,
    key: privateKey,
    scopes: SCOPES,
    ...(subject ? { subject } : {}),
  });
  try {
    await auth.authorize();
    push('authorize', 'pass', subject ? `token issued while acting as ${subject}` : 'token issued for the service account itself');
  } catch (err) {
    const message = errText(err);
    push('authorize', 'fail', message);
    result.remedy = /unauthorized_client|invalid_grant|access_denied/i.test(message)
      ? delegationRemedy(result.serviceAccount.clientId, subject || null)
      : `Authentication failed before any Drive call: ${message}`;
    return result;
  }

  const drive = google.drive({ version: 'v3', auth });

  // ── can the acting identity see the target folder?
  let canAddChildren = false;
  let sharedDriveId: string | null = null;
  try {
    const res = await drive.files.get({
      fileId: folderId,
      fields: 'id,name,mimeType,driveId,capabilities(canAddChildren)',
      supportsAllDrives: true,
    });
    const f = res.data;
    canAddChildren = f.capabilities?.canAddChildren === true;
    sharedDriveId = f.driveId ?? null;
    if (f.mimeType !== 'application/vnd.google-apps.folder') {
      push('target folder', 'fail', `GOOGLE_DRIVE_FOLDER_ID points at a ${f.mimeType}, not a folder.`);
      result.remedy = 'GOOGLE_DRIVE_FOLDER_ID must be a folder id — copy it from the folder URL, not from a file.';
      return result;
    }
    push('target folder', 'pass', `"${f.name}"${sharedDriveId ? ` in shared drive ${sharedDriveId}` : ' (My Drive)'}`);
    push(
      'write capability',
      canAddChildren ? 'pass' : 'fail',
      canAddChildren ? 'capabilities.canAddChildren is true' : 'capabilities.canAddChildren is FALSE — the acting identity may read the folder but not add to it.',
    );
    if (!canAddChildren) {
      setRemedy(`Share the folder with ${subject || clientEmail} as an Editor.`);
    }
  } catch (err) {
    const message = errText(err);
    // Distinguish "not shared" from "invisible under drive.file", which report
    // identically as 404. drive.file only ever sees files this app created.
    let visibleWithMetadataScope = false;
    try {
      // Deliberately NOT impersonating. A domain-wide delegation grant is
      // per-scope, so asking for drive.metadata.readonly with a subject fails
      // unauthorized_client unless that scope was granted too — which would
      // make this probe report "nobody can see the folder" on a correctly
      // configured install, the exact misdiagnosis this whole ticket is about.
      // The bare service account needs no grant and is a writer on the folder.
      const probe = new google.auth.JWT({ email: clientEmail, key: privateKey, scopes: [METADATA_SCOPE] });
      await probe.authorize();
      await google.drive({ version: 'v3', auth: probe }).files.get({ fileId: folderId, fields: 'id', supportsAllDrives: true });
      visibleWithMetadataScope = true;
    } catch {
      visibleWithMetadataScope = false;
    }

    if (!visibleWithMetadataScope) {
      // Nothing can see it: wrong id, or never shared. That is terminal.
      push('target folder', 'fail', message);
      setRemedy([
        `Neither the requested scopes nor drive.metadata.readonly can see folder ${folderId}.`,
        `Check the id, and share the folder with ${subject || clientEmail} as an Editor.`,
      ].join('\n'));
      result.remedy = remedy;
      return result;
    }

    // Shared correctly, just invisible to drive.file. Expected, and not fatal:
    // a create with parents:[folderId] may still succeed. Keep going — the
    // ownership check below is the one that decides whether anything can be
    // created at all.
    push('target folder', 'warn', `invisible under drive.file (${message}) but visible under drive.metadata.readonly — the folder exists and is shared; drive.file cannot see a folder this app did not create.`);
    push('write capability', 'skip', 'not checkable under drive.file; a live create is the real test.');
    notes.push([
      'Informational, not a fault. The drive.file scope cannot read the target folder itself,',
      'but it does see files this app created inside it — so creating into the folder and the',
      'getSpreadsheetId() idempotency lookup both work. Verified live on 2026-09-03: create,',
      'read-back and a second export that updated in place rather than duplicating.',
    ].join('\n'));
  }

  // ── who owns what gets created, and does that identity have quota?
  try {
    const about = await drive.about.get({ fields: 'storageQuota,user' });
    const quota = about.data.storageQuota ?? {};
    const actingAs = about.data.user?.emailAddress ?? '(unknown)';
    const limit = quota.limit ? Number(quota.limit) : null;

    if (sharedDriveId) {
      push('file ownership', 'pass', `files land in shared drive ${sharedDriveId}, which carries its own storage — the acting identity's quota is irrelevant.`);
    } else if (limit === 0) {
      push('file ownership', 'fail', `acting as ${actingAs}, whose Drive storage limit is 0 — it cannot own a file, so every create fails.`);
      setRemedy(delegationRemedy(result.serviceAccount.clientId, subject || null));
    } else {
      push('file ownership', 'pass', `acting as ${actingAs}${limit ? ` (quota limit ${limit}, usage ${quota.usage ?? '?'})` : ' (no storage limit reported)'} — created files are owned by this identity.`);
    }
  } catch (err) {
    push('file ownership', 'warn', `could not read the acting identity's quota: ${errText(err)}`);
  }

  // ── the idempotency lookup the export relies on
  try {
    await drive.files.list({
      q: `'${folderId}' in parents and appProperties has { key='estimateId' and value='diagnostics-probe' } and trashed=false`,
      fields: 'files(id)',
      pageSize: 1,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    push('idempotency lookup', 'pass', 'the appProperties query the export uses to find a previous run is accepted.');
  } catch (err) {
    push('idempotency lookup', 'warn', `the lookup query failed (${errText(err)}) — a re-export would create a duplicate instead of updating.`);
  }

  result.ok = !checks.some((c) => c.status === 'fail');
  result.remedy = remedy ?? (notes.length > 0 ? notes.join('\n\n') : null);
  result.notes = notes;
  return result;
}

export function formatDiagnosis(d: SheetsDiagnosis): string {
  const glyph: Record<CheckStatus, string> = { pass: 'PASS', fail: 'FAIL', warn: 'WARN', skip: 'SKIP' };
  const lines = ['Google Sheets export — configuration check', ''];
  for (const c of d.checks) {
    lines.push(`  ${glyph[c.status].padEnd(5)} ${c.name}`);
    for (const part of c.detail.split('\n')) lines.push(`        ${part}`);
  }
  lines.push('');
  const warned = d.checks.some((c) => c.status === 'warn');
  lines.push(
    d.ok
      ? warned
        ? 'No blocking fault found, but see the caveat below before trusting it.'
        : 'Configuration looks usable.'
      : 'Configuration is NOT usable yet.',
  );
  if (d.remedy) {
    lines.push('');
    lines.push(d.ok ? 'Caveat:' : 'Next step:');
    for (const part of d.remedy.split('\n')) lines.push(`  ${part}`);
  }
  return lines.join('\n');
}
