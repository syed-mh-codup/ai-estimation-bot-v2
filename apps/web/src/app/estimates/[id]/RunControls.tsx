'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ShieldCheck } from 'lucide-react';
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
import { StateBanner } from './StateBanner';

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
  /**
   * True when this estimate was forked from another. AEH-236.
   *
   * A fork with no children and no siblings is allowed to re-run — that is the
   * rule, deliberately. But a run REBUILDS the ledger from the SOW, which
   * discards every card the fork copied, and nothing else on this screen says
   * so. The refusal for children and siblings is enforced server-side; this is
   * the case the server permits and a person still needs warning about.
   */
  isFork?: boolean;
  /**
   * Findings still needing a decision, for the settled banner to name. Passed
   * in rather than read from the ledger because it is a server-side count of a
   * table the editor does not carry. AEH-377.
   */
  openRisk?: number;
};

/**
 * Reload-safe Run estimate control. The run executes in the background (POST
 * /run); this component polls GET /status every 1.5s while RUNNING, renders the
 * crew track, disables the button so you can't double-run, and refreshes the
 * page into the Menu Card on completion. Because all state is DB-backed, a hard
 * reload mid-run resumes the same progress.
 */
export function RunControls({
  estimateId,
  hasMenu,
  initial,
  isFork = false,
  openRisk = 0,
}: RunControlsProps) {
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
      // 202 = started. 409 is TWO different things and they must not be
      // conflated: `ALREADY_RUNNING` means somebody else started it and the
      // poller takes over, but a `REFUSED` 409 means the run never happened.
      //
      // Treating every 409 as fine left a refusal showing the optimistic
      // RUNNING state until a poll quietly reverted it — so a locked estimate,
      // or one with forks depending on its rows, read as "starting…" and then
      // as nothing at all. The server's message is the only thing that says
      // which locks, or which estimates, are in the way, so it is shown
      // verbatim rather than replaced with a status code. AEH-236.
      if (res.status !== 202) {
        const body = await res.json().catch(() => null);
        if (body?.code !== 'ALREADY_RUNNING') {
          setRun((r) => ({
            ...r,
            status: 'FAILED',
            stage: 'Failed',
            pct: 0,
            error: body?.error ?? `Could not start run (HTTP ${res.status})`,
          }));
        }
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
    const rerun = (
      <Button variant="outline" size="sm" onClick={start} data-testid="run-estimate">
        Re-run estimate
      </Button>
    );

    // A run that finished has something to say beyond that it happened: what it
    // produced, and what about it still needs a person. The banner says it.
    // AEH-377.
    if (run.status === 'DONE') {
      return <StateBanner openRisk={openRisk} elapsed={elapsed} onRerun={rerun} />;
    }

    // No run on record, but a menu card exists — somebody built it by hand.
    // There is no result to narrate, so this stays the quiet line it was.
    return (
      <section
        className="flex flex-wrap items-center gap-2.5 rounded-[10px] border border-line bg-surface px-4 py-3"
        data-testid="run-panel"
      >
        <span className="flex-1 text-[12.5px] text-ink-3">
          No crew run recorded for this menu card.
        </span>
        {rerun}
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
          {/* The one case the server allows and a person still needs telling
              about: a fork may be re-run, and doing so throws away the copy it
              was made for. Reconciling is the thing they almost always want. */}
          {isFork && hasMenu && !running && (
            <p
              className="mt-1.5 text-[11.5px] leading-snug text-bronze-ink"
              data-testid="run-fork-warning"
            >
              This estimate was forked. Re-running rebuilds it from the statement of work and
              discards every card it copied — reconcile instead to change it against the brief.
            </p>
          )}
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
