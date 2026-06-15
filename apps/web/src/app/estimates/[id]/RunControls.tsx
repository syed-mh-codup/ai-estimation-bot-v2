'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

type RunState = {
  status: 'IDLE' | 'RUNNING' | 'DONE' | 'FAILED';
  stage: string | null;
  pct: number;
  error: string | null;
};

export type RunControlsProps = {
  estimateId: string;
  hasMenu: boolean;
  initial: RunState;
};

/**
 * Reload-safe Run estimate control. The run executes in the background (POST
 * /run); this component polls GET /status every 1.5s while RUNNING, renders a
 * live stage + progress bar, disables the button so you can't double-run, and
 * refreshes the page into the Menu Card on completion. Because all state is
 * DB-backed, a hard reload mid-run resumes the same progress.
 */
export function RunControls({ estimateId, hasMenu, initial }: RunControlsProps) {
  const router = useRouter();
  const [run, setRun] = useState<RunState>(initial);
  const running = run.status === 'RUNNING';

  // Poll while RUNNING; stop + refresh on a terminal status.
  useEffect(() => {
    if (run.status !== 'RUNNING') return;
    let active = true;

    const tick = async () => {
      try {
        const res = await fetch(`/api/estimates/${estimateId}/status`, { cache: 'no-store' });
        if (!res.ok || !active) return;
        const data = await res.json();
        if (!active) return;
        setRun({
          status: data.runStatus,
          stage: data.runStage,
          pct: data.runPct ?? 0,
          error: data.runError ?? null,
        });
        if (data.runStatus === 'DONE' || data.runStatus === 'FAILED') {
          active = false;
          router.refresh();
        }
      } catch {
        /* transient — next tick retries */
      }
    };

    const iv = setInterval(tick, 1500);
    tick();
    return () => {
      active = false;
      clearInterval(iv);
    };
  }, [run.status, estimateId, router]);

  const start = useCallback(async () => {
    setRun({ status: 'RUNNING', stage: 'Queued', pct: 0, error: null });
    try {
      const res = await fetch(`/api/estimates/${estimateId}/run`, { method: 'POST' });
      // 202 = started, 409 = already running elsewhere — both fine, the poller
      // takes over. Anything else is a genuine start failure.
      if (res.status !== 202 && res.status !== 409) {
        setRun({ status: 'FAILED', stage: 'Failed', pct: 0, error: `Could not start run (HTTP ${res.status})` });
      }
    } catch {
      setRun({ status: 'FAILED', stage: 'Failed', pct: 0, error: 'Could not start run (network error)' });
    }
  }, [estimateId]);

  return (
    <div className="w-full">
      <button
        type="button"
        onClick={start}
        disabled={running}
        data-testid="run-estimate"
        aria-busy={running}
        className="inline-flex items-center gap-2 rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {running && (
          <span
            className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/40 border-t-white"
            aria-hidden
          />
        )}
        {running ? 'Running…' : hasMenu ? 'Re-run estimate' : 'Run estimate'}
      </button>

      {running && (
        <div className="mt-3 max-w-md" data-testid="run-progress">
          <div className="flex items-center justify-between text-xs text-gray-600">
            <span data-testid="run-stage">{run.stage ?? 'Working…'}</span>
            <span data-testid="run-pct">{run.pct}%</span>
          </div>
          <div className="mt-1 h-2 w-full overflow-hidden rounded-full bg-gray-200">
            <div
              className="h-full rounded-full bg-gray-900 transition-[width] duration-500 ease-out"
              style={{ width: `${Math.min(100, Math.max(3, run.pct))}%` }}
            />
          </div>
        </div>
      )}

      {run.status === 'FAILED' && run.error && (
        <div
          data-testid="run-error"
          className="mt-3 max-w-md rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
        >
          <span className="font-medium">Run failed:</span> {run.error}
        </div>
      )}
    </div>
  );
}
