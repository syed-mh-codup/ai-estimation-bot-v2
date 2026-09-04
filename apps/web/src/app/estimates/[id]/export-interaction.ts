/**
 * AEH-316: the Export to Sheets button's state, kept out of the component so
 * it can be tested. Component logic is unreachable by this repo's test setup
 * (node environment, no jsdom), which is the same reason `saveStateOf` lives
 * in `scope-interaction.ts` rather than inside `ScopeConfigurator`.
 */

/** What the server action hands back. It never throws: a throw from a server
 *  action reaches the user as a bare "Application error" page, which is how
 *  the AEH-232 export failure managed to look like a site outage.
 *
 *  `needs-confirmation` is AEH-317: the export rewrites every generated tab
 *  wholesale, so when somebody has edited the spreadsheet since this system last
 *  wrote to it, the destruction is put to the user before it happens rather than
 *  reported afterwards. */
export type ExportOutcome =
  | { kind: 'exported'; url: string; lastExport: string }
  | { kind: 'needs-confirmation'; warning: string }
  | { kind: 'failed'; error: string };

export type ExportState = 'idle' | 'exporting' | 'done' | 'ready' | 'confirming' | 'failed';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * UTC, matching how this app already renders `dueAt`. A shared record that reads
 * differently depending on which timezone opened it is worse than one that reads
 * the same everywhere and says so.
 */
export function formatMoment(at: Date): string {
  const hh = String(at.getUTCHours()).padStart(2, '0');
  const mm = String(at.getUTCMinutes()).padStart(2, '0');
  return `${at.getUTCDate()} ${MONTHS[at.getUTCMonth()]} ${at.getUTCFullYear()} at ${hh}:${mm} UTC`;
}

/**
 * The sentence somebody reads immediately before deciding whether to destroy a
 * colleague's afternoon. It names who last exported and when, so the reader can
 * tell their own edit from somebody else's, and it says where the work has gone
 * rather than only that it is gone.
 */
export function overwriteWarning(args: {
  modifiedAt: Date;
  lastExportAt: Date;
  lastExportBy: string | null;
}): string {
  const who = args.lastExportBy ?? 'this system';
  return (
    `This spreadsheet was edited on ${formatMoment(args.modifiedAt)}, after ${who} last exported it ` +
    `on ${formatMoment(args.lastExportAt)}. Exporting again rewrites Summary and every department tab ` +
    `from scratch, so those edits will be gone. Tabs somebody added themselves are left alone, and ` +
    `File > Version history in Google Sheets is the way back. Export anyway?`
  );
}

/** The line under the link, so the sheet's provenance is visible without opening it. */
export function lastExportLine(args: { at: Date; by: string | null }): string {
  return `Last exported by ${args.by ?? 'this system'} on ${formatMoment(args.at)}`;
}

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
  /** Set while an overwrite is waiting to be confirmed. */
  warning?: string | null;
}): ExportState {
  if (args.pending) return 'exporting';
  if (args.error) return 'failed';
  // Outranks `done`: an unanswered question about destroying somebody's work is
  // the only thing on this button worth looking at.
  if (args.warning) return 'confirming';
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
    case 'confirming':
      return 'Overwrite the spreadsheet';
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
