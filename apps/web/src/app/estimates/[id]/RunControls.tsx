'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ShieldCheck, Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  CrewTrack,
  RUN_CREW,
  crewIndexFor,
  readStage,
  formatElapsed,
  type RunStatus,
} from '@/components/ui/crew-track';
import { cn } from '@/lib/utils';

type RunState = {
  status: RunStatus;
  stage: string | null;
  pct: number;
  error: string | null;
  startedAt: string | null;
  finishedAt: string | null;
};

export type RunControlsProps = {
  estimateId: string;
  hasMenu: boolean;
  initial: RunState;
};

/**
 * Reload-safe Run estimate control. The run executes in the background (POST
 * /run); this component polls GET /status every 1.5s while RUNNING, renders the
 * crew track, disables the button so you can't double-run, and refreshes the
 * page into the Menu Card on completion. Because all state is DB-backed, a hard
 * reload mid-run resumes the same progress.
 */
export function RunControls({ estimateId, hasMenu, initial }: RunControlsProps) {
  const router = useRouter();
  const [run, setRun] = useState<RunState>(initial);
  const [now, setNow] = useState(() => Date.now());
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
          startedAt: data.runStartedAt ?? null,
          finishedAt: data.runFinishedAt ?? null,
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

  // Tick the elapsed clock independently of the poller so it counts smoothly.
  useEffect(() => {
    if (run.status !== 'RUNNING') return;
    const iv = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(iv);
  }, [run.status]);

  const start = useCallback(async () => {
    setRun({
      status: 'RUNNING',
      stage: 'Queued',
      pct: 0,
      error: null,
      startedAt: new Date().toISOString(),
      finishedAt: null,
    });
    try {
      const res = await fetch(`/api/estimates/${estimateId}/run`, { method: 'POST' });
      // 202 = started, 409 = already running elsewhere — both fine, the poller
      // takes over. Anything else is a genuine start failure.
      if (res.status !== 202 && res.status !== 409) {
        setRun((r) => ({
          ...r,
          status: 'FAILED',
          stage: 'Failed',
          pct: 0,
          error: `Could not start run (HTTP ${res.status})`,
        }));
      }
    } catch {
      setRun((r) => ({
        ...r,
        status: 'FAILED',
        stage: 'Failed',
        pct: 0,
        error: 'Could not start run (network error)',
      }));
    }
  }, [estimateId]);

  const { label, detail } = readStage(run.stage);
  const elapsed = run.startedAt
    ? formatElapsed(
        ((run.status === 'RUNNING' ? now : Date.parse(run.finishedAt ?? '')) -
          Date.parse(run.startedAt)) /
          1000,
      )
    : null;

  // ── Settled: once a menu card exists and nothing is in flight, the run is
  //    history. It collapses to one quiet line — the card below is the thing
  //    worth looking at. The full crew track earns its space only when the run
  //    IS the event: in flight, failed, or nothing drafted yet.
  if (hasMenu && (run.status === 'DONE' || run.status === 'IDLE')) {
    return (
      <section
        className="flex flex-wrap items-center gap-2.5 rounded-[10px] border border-line bg-surface px-4 py-3"
        data-testid="run-panel"
      >
        {run.status === 'DONE' && (
          <Check className="h-3.5 w-3.5 shrink-0 text-green" strokeWidth={3} aria-hidden />
        )}
        <span className="flex-1 text-[12.5px] text-ink-3">
          {run.status === 'DONE' ? (
            <>
              The crew drafted this menu card
              {elapsed ? (
                <>
                  {' in '}
                  <span className="num">{elapsed}</span>
                </>
              ) : null}
              .
            </>
          ) : (
            'No crew run recorded for this menu card.'
          )}
        </span>
        <Button variant="outline" size="sm" onClick={start} data-testid="run-estimate">
          Re-run estimate
        </Button>
      </section>
    );
  }

  const tone =
    run.status === 'RUNNING' ? 'running' : run.status === 'FAILED' ? 'failed' : 'idle';

  return (
    <section
      className={cn(
        'rounded-[10px] border p-4',
        tone === 'running' && 'border-bronze-line bg-[#FDFBF4]',
        tone === 'failed' && 'border-brick-line bg-[#FDF8F6]',
        tone === 'idle' && 'border-line bg-surface',
      )}
      aria-live="polite"
      data-testid="run-panel"
    >
      <div className="flex flex-wrap items-start gap-3.5">
        <div className="min-w-[220px] flex-1">
          <div className="eyebrow">
            {running
              ? 'The crew is working'
              : run.status === 'FAILED'
                ? 'The crew stopped'
                : 'The crew'}
          </div>

          <div className="mt-1.5 text-[14.5px] font-semibold text-ink" data-testid="run-stage">
            {running
              ? label
              : run.status === 'FAILED'
                ? `Run failed at ${RUN_CREW[crewIndexFor(RUN_CREW, run.pct)]!.name}`
                : hasMenu
                  ? 'Ready to run again'
                  : 'Ready to run'}
          </div>

          <p className="mt-1 text-[12.5px] text-ink-3">
            {running
              ? (detail ?? 'Reading the statement of work and drafting a menu card.')
              : run.status === 'FAILED'
                ? 'Work from the agents that finished was saved.'
                : 'Five agents read the statement of work and draft a menu card. Typically about two minutes.'}
          </p>
        </div>

        {running ? (
          <div className="text-right">
            <div className="num text-[26px] leading-none font-medium tracking-[-0.02em] text-bronze-ink">
              <span data-testid="run-pct">{run.pct}</span>
              <span className="text-[15px] text-bronze">%</span>
            </div>
            {elapsed && (
              <div className="num mt-1 text-[11.5px] text-ink-3">{elapsed} elapsed</div>
            )}
          </div>
        ) : (
          <Button onClick={start} disabled={running} aria-busy={running} data-testid="run-estimate">
            {hasMenu ? 'Re-run estimate' : 'Run estimate'}
          </Button>
        )}
      </div>

      <div data-testid={running ? 'run-progress' : undefined}>
        <CrewTrack className="mt-5" stages={RUN_CREW} pct={run.pct} status={run.status} />

        {running && (
          <p className="mt-3.5 flex items-center gap-2 text-xs text-ink-3">
            <ShieldCheck className="h-3.5 w-3.5 shrink-0" aria-hidden />
            Safe to close this tab — the run continues on the server and progress is saved.
          </p>
        )}
      </div>

      {run.status === 'FAILED' && run.error && (
        <>
          <div
            className="mt-3 rounded-md border border-brick-line bg-brick-tint px-3 py-2.5"
            data-testid="run-error"
          >
            <div className="text-[13px] font-semibold text-brick">
              The crew couldn&rsquo;t finish this run
            </div>
            <p className="mt-1 text-[12.5px] leading-relaxed break-words text-ink-2">{run.error}</p>
          </div>
          <div className="mt-3">
            <Button onClick={start} data-testid="run-retry">
              Retry run
            </Button>
          </div>
        </>
      )}
    </section>
  );
}
