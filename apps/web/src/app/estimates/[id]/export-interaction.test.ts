import { describe, it, expect } from 'vitest';
import { exportStateOf, exportButtonLabel, firstLine } from './export-interaction';

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
