'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Button } from '@/components/ui/button';
import {
  exportButtonLabel,
  exportStateOf,
  firstLine,
  type ExportOutcome,
} from './export-interaction';

export type ExportSheetsProps = {
  estimateId: string;
  /** Persisted on the estimate, so the link survives a reload without re-exporting. */
  initialSheetUrl: string | null;
  action: (estimateId: string) => Promise<ExportOutcome>;
};

const CONFIRMATION_MS = 2500;

/**
 * AEH-316. The export used to be a bare form with a submit button: no pending
 * state, no result, and a failure that took the whole page down with it. The
 * spreadsheet link did exist, but only as two words in the metadata list in the
 * sidebar, which is not where anyone looks after pressing a button.
 *
 * So the link lives here, next to the thing that creates it. Re-exporting
 * replaces that same sheet rather than making another, and the button says so
 * once one exists — that behaviour was never discoverable before.
 */
export function ExportSheets({ estimateId, initialSheetUrl, action }: ExportSheetsProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [url, setUrl] = useState<string | null>(initialSheetUrl);
  const [error, setError] = useState<string | null>(null);
  const [exportedAt, setExportedAt] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);

  const run = () => {
    setError(null);
    startTransition(async () => {
      // The action reports failure by returning it. Any throw that still gets
      // through is a bug, not an export problem, so it is caught rather than
      // allowed to become a server-side exception page.
      let outcome: ExportOutcome;
      try {
        outcome = await action(estimateId);
      } catch (e) {
        setError(e instanceof Error ? e.message : 'The export failed for an unknown reason.');
        return;
      }

      if (!outcome.ok) {
        setError(outcome.error);
        return;
      }

      // A recreated sheet gets a new URL, so take it from the result rather
      // than assuming the one already on screen is still right.
      setUrl(outcome.url);
      setExportedAt(Date.now());
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setExportedAt(0), CONFIRMATION_MS);
      // Brings the sidebar's Sheet row into line with what just happened.
      router.refresh();
    });
  };

  const state = exportStateOf({ pending, error, url, exportedAt });

  return (
    <div className="flex flex-col gap-1.5" data-testid="export-panel">
      <Button
        type="button"
        variant="outline"
        full
        onClick={run}
        disabled={pending}
        data-testid="export-sheets"
      >
        {exportButtonLabel(state)}
      </Button>

      {url && (
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="text-[11.5px] text-green hover:underline"
          data-testid="export-sheet-link"
        >
          Open the spreadsheet ↗
        </a>
      )}

      {(state === 'ready' || state === 'done') && (
        <p className="text-[11px] leading-snug text-bronze-ink">
          Exporting again replaces this same sheet, so edits and re-runs stay in one file.
        </p>
      )}

      {state === 'failed' && error && (
        <p
          className="rounded-[8px] border border-red/40 bg-red/5 px-3 py-2 text-[11.5px] leading-snug text-red"
          title={error}
          data-testid="export-error"
        >
          {firstLine(error)}
        </p>
      )}
    </div>
  );
}
