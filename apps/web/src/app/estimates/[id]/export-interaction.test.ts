import { describe, it, expect } from 'vitest';
import {
  exportStateOf,
  exportButtonLabel,
  firstLine,
  formatMoment,
  lastExportLine,
  overwriteWarning,
} from './export-interaction';

const state = (over: Partial<Parameters<typeof exportStateOf>[0]> = {}) =>
  exportStateOf({ pending: false, error: null, url: null, exportedAt: 0, ...over });

describe('AEH-316: export button state', () => {
  it('is idle before anything has been exported', () => {
    expect(state()).toBe('idle');
    expect(exportButtonLabel('idle')).toBe('Export to Sheets');
  });

  it('reports progress while the action is in flight', () => {
    expect(state({ pending: true })).toBe('exporting');
    expect(exportButtonLabel('exporting')).toBe('Exporting…');
  });

  it('pending wins over every other signal, so a retry never looks finished', () => {
    expect(state({ pending: true, error: 'boom', url: 'u', exportedAt: Date.now() })).toBe('exporting');
  });

  it('shows the transient confirmation after a successful export', () => {
    expect(state({ url: 'u', exportedAt: Date.now() })).toBe('done');
    expect(exportButtonLabel('done')).toBe('Exported ✓');
  });

  it('decays to ready once the confirmation is cleared, and says it will replace the sheet', () => {
    expect(state({ url: 'u', exportedAt: 0 })).toBe('ready');
    expect(exportButtonLabel('ready')).toBe('Re-export to Sheets');
  });

  it('is ready on a fresh page load when a sheet already exists', () => {
    // The URL is persisted on the estimate, so a reload seeds this directly —
    // the link must survive without re-exporting.
    expect(state({ url: 'https://docs.google.com/spreadsheets/d/abc' })).toBe('ready');
  });

  it('a failure outranks a previously good sheet', () => {
    expect(state({ error: 'quota', url: 'u', exportedAt: Date.now() })).toBe('failed');
    expect(exportButtonLabel('failed')).toBe('Retry export');
  });
});

describe('AEH-316: error text for a narrow rail', () => {
  it("keeps the provider's first line, which is the actionable part", () => {
    const message =
      "Google Sheets export failed while creating the spreadsheet in folder abc: The user's Drive storage quota has been exceeded.\n\nA service account has no Drive storage quota of its own, so it cannot own — and therefore cannot create — a file.";
    expect(firstLine(message)).toMatch(/^Google Sheets export failed while creating/);
    expect(firstLine(message)).not.toMatch(/service account has no Drive storage/);
  });

  it('truncates a single overlong line rather than flooding the rail', () => {
    const out = firstLine('x'.repeat(400));
    expect(out).toHaveLength(160);
    expect(out.endsWith('…')).toBe(true);
  });

  it('skips leading blank lines', () => {
    expect(firstLine('\n\n  the real message  \nmore')).toBe('the real message');
  });

  it('never renders an empty error', () => {
    expect(firstLine('   \n  ')).toBe('The export failed.');
    expect(firstLine('')).toBe('The export failed.');
  });
});

describe('AEH-317: confirming an overwrite', () => {
  const warning = 'careful';

  it('an unanswered overwrite question outranks the success beat', () => {
    // Otherwise a re-export that stopped to ask would flash "Exported ✓" from
    // the run before it, which reads as though it already went through.
    expect(state({ warning, url: 'u', exportedAt: Date.now() })).toBe('confirming');
    expect(exportButtonLabel('confirming')).toBe('Overwrite the spreadsheet');
  });

  it('a real failure still outranks the question', () => {
    expect(state({ warning, error: 'quota' })).toBe('failed');
  });

  it('pending still wins, so the confirmed press does not re-ask mid-flight', () => {
    expect(state({ warning, pending: true })).toBe('exporting');
  });

  it('goes back to normal once the question is dismissed', () => {
    expect(state({ warning: null, url: 'u' })).toBe('ready');
  });
});

describe('AEH-317: overwrite warning text', () => {
  const modifiedAt = new Date('2026-09-04T14:22:00Z');
  const lastExportAt = new Date('2026-09-04T09:10:00Z');

  it('names who exported last and when, so a reader can spot their own edit', () => {
    const text = overwriteWarning({ modifiedAt, lastExportAt, lastExportBy: 'ae@codup.co' });
    expect(text).toContain('4 Sep 2026 at 14:22 UTC');
    expect(text).toContain('ae@codup.co');
    expect(text).toContain('4 Sep 2026 at 09:10 UTC');
  });

  it('says what survives and where the rest has gone', () => {
    const text = overwriteWarning({ modifiedAt, lastExportAt, lastExportBy: null });
    expect(text).toContain('Tabs somebody added themselves are left alone');
    expect(text).toContain('Version history');
    // A deleted account must not turn the sentence into "after null".
    expect(text).toContain('this system');
    expect(text).not.toContain('null');
  });

  it('formats in UTC, so the same file reads the same in every timezone', () => {
    expect(formatMoment(new Date('2026-01-09T05:07:00Z'))).toBe('9 Jan 2026 at 05:07 UTC');
  });

  it('attributes the sheet without needing it opened', () => {
    expect(lastExportLine({ at: lastExportAt, by: 'ae@codup.co' })).toBe(
      'Last exported by ae@codup.co on 4 Sep 2026 at 09:10 UTC',
    );
  });
});
