/**
 * AEH-316: the Export to Sheets button's state, kept out of the component so
 * it can be tested. Component logic is unreachable by this repo's test setup
 * (node environment, no jsdom), which is the same reason `saveStateOf` lives
 * in `scope-interaction.ts` rather than inside `ScopeConfigurator`.
 */

/** What the server action hands back. It never throws: a throw from a server
 *  action reaches the user as a bare "Application error" page, which is how
 *  the AEH-232 export failure managed to look like a site outage. */
export type ExportOutcome = { ok: true; url: string } | { ok: false; error: string };

export type ExportState = 'idle' | 'exporting' | 'done' | 'ready' | 'failed';

/**
 * `done` is the transient "just worked" beat; it decays to `ready` once the
 * caller clears `exportedAt`. `ready` means a sheet exists from some earlier
 * export — including a previous page load, since the URL is persisted.
 */
export function exportStateOf(args: {
  pending: boolean;
  error: string | null;
  url: string | null;
  exportedAt: number;
}): ExportState {
  if (args.pending) return 'exporting';
  if (args.error) return 'failed';
  if (args.exportedAt > 0) return 'done';
  return args.url ? 'ready' : 'idle';
}

/** The button says what it will do, and once a sheet exists it says that
 *  pressing again replaces that one rather than making another. */
export function exportButtonLabel(state: ExportState): string {
  switch (state) {
    case 'exporting':
      return 'Exporting…';
    case 'done':
      return 'Exported ✓';
    case 'ready':
      return 'Re-export to Sheets';
    case 'failed':
      return 'Retry export';
    default:
      return 'Export to Sheets';
  }
}

const MAX_INLINE_ERROR = 160;

/**
 * The provider's failures carry multi-paragraph remediation notes — deliberately,
 * because the cause is never obvious. The rail has room for the first line; the
 * caller keeps the whole thing for a title attribute.
 */
export function firstLine(message: string): string {
  const line = message
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!line) return 'The export failed.';
  return line.length > MAX_INLINE_ERROR ? `${line.slice(0, MAX_INLINE_ERROR - 1).trimEnd()}…` : line;
}
