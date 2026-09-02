'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

import { CARTOGRAPHER_STAGES } from '@repo/shared';

import { Button } from '@/components/ui/button';
import { CrewTrack, formatElapsed, type CrewStage } from '@/components/ui/crew-track';

import { deriveSummary, splitSseFrames, type DeriveEvent } from './scope-interaction';

/**
 * Ask the Cartographer to work out the dependency graph, and show what it is
 * doing while it does. AEH-235.
 *
 * The same shape as the run's own indicator (`RunControls` + `CrewTrack`), for
 * the same reason: a heavy model call that takes the better part of a minute is
 * indistinguishable from a hang unless the screen says otherwise.
 *
 * What is honest here and what is not:
 *
 *   - The four stages are real. Each begins when the work it names begins.
 *   - The model call is ONE call over the whole menu card. It is indivisible,
 *     so the bar does not creep through it pretending to know how far in it is.
 *   - What moves during it is the dependency count, read off the response as it
 *     streams. That is a counted number, not an interpolation, which is why it
 *     is worth showing at all.
 *
 * The elapsed clock is the other half of the answer: stage plus count plus time
 * is enough to judge whether to keep waiting.
 */

/** The stage list, in the shape `CrewTrack` renders. */
const STAGES: CrewStage[] = CARTOGRAPHER_STAGES.map((s) => ({
  key: s.key,
  name: s.name,
  from: s.from,
}));

type DeriveState =
  | { phase: 'idle' }
  | {
      phase: 'running';
      label: string;
      pct: number;
      cards?: number;
      edgesFound?: number;
      startedAt: number;
    }
  | { phase: 'done'; summary: string }
  | { phase: 'failed'; error: string };

export function ScopeDerive({
  estimateId,
  edgeCount,
  manualCount,
  scenarioCount,
}: {
  estimateId: string;
  edgeCount: number;
  /** Of those, how many a person typed. Those survive a re-derive. */
  manualCount: number;
  /** Saved configurations, which survive regardless — worth saying so. */
  scenarioCount: number;
}) {
  const router = useRouter();
  const [state, setState] = useState<DeriveState>({ phase: 'idle' });
  const [now, setNow] = useState(() => Date.now());

  // Ticked independently of the stream so the clock counts smoothly even while
  // the model is silent — which, mid-call, is most of the time.
  useEffect(() => {
    if (state.phase !== 'running') return;
    const iv = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(iv);
  }, [state.phase]);

  const running = useRef(false);
  const [confirming, setConfirming] = useState(false);

  /**
   * Two steps before re-deriving over a graph that already exists, and the
   * second one spells out exactly what changes.
   *
   * An inline two-step rather than two stacked `confirm()` dialogs: the same
   * deliberateness, without training people to dismiss modals, and the wording
   * stays on screen while they decide. A first derivation needs no
   * confirmation at all — there is nothing to lose.
   */
  const start = () => {
    if (running.current) return;
    if (edgeCount === 0) {
      void derive();
      return;
    }
    setConfirming(true);
  };

  const derive = async () => {
    if (running.current) return;
    setConfirming(false);
    running.current = true;
    setState({ phase: 'running', label: 'Starting', pct: 0, startedAt: Date.now() });
    setNow(Date.now());

    try {
      const res = await fetch(`/api/estimates/${estimateId}/scope-map`, { method: 'POST' });

      // A refusal before the stream begins still arrives as JSON with a status
      // — a missing prompt, no menu card, not signed in. Worth reporting as
      // itself rather than as "the stream ended".
      if (!res.ok || !res.body) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setState({ phase: 'failed', error: body.error ?? `Could not start (HTTP ${res.status})` });
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let outcome: DeriveState | null = null;

      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const { events, rest } = splitSseFrames(buffer);
        buffer = rest;
        for (const ev of events) outcome = apply(ev) ?? outcome;
      }

      setState(
        outcome ?? { phase: 'failed', error: 'The stream ended without finishing. Try again.' },
      );
      if (outcome?.phase === 'done') router.refresh();
    } catch (e) {
      setState({
        phase: 'failed',
        error: e instanceof Error ? e.message : 'Could not reach the server',
      });
    } finally {
      running.current = false;
    }
  };

  /** Fold one frame into state; returns a terminal state if this was the last. */
  const apply = (ev: DeriveEvent): DeriveState | null => {
    if (ev.type === 'progress') {
      setState((prev) => ({
        phase: 'running',
        label: ev.label,
        pct: ev.pct,
        cards: ev.cards,
        edgesFound: ev.edgesFound,
        startedAt: prev.phase === 'running' ? prev.startedAt : Date.now(),
      }));
      return null;
    }
    if (ev.type === 'done') return { phase: 'done', summary: deriveSummary(ev.result) };
    return { phase: 'failed', error: ev.error };
  };

  const busy = state.phase === 'running';

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-3">
        <p className="text-[11.5px] text-ink-4">
          {edgeCount === 0
            ? 'None recorded yet — the cascade has nothing to act on.'
            : `${edgeCount} recorded on this estimate${
                manualCount > 0 ? `, ${manualCount} typed by hand` : ''
              }.`}
        </p>
        <Button
          variant="ghost"
          onClick={start}
          disabled={busy || confirming}
          data-testid="scope-graph-derive"
          title="Read the menu card and work out what depends on what"
        >
          {busy ? 'Working…' : edgeCount === 0 ? 'Work it out' : 'Work it out again'}
        </Button>
      </div>

      {confirming && (
        <div
          data-testid="scope-derive-confirm"
          className="rounded-[8px] border border-line bg-surface-2 px-3 py-2.5"
        >
          <p className="text-[12.5px] text-ink-1">Work the dependencies out again?</p>
          <ul className="mt-1.5 flex flex-col gap-0.5 text-[11.5px] text-ink-3">
            <li>
              Replaces the {edgeCount - manualCount} dependenc
              {edgeCount - manualCount === 1 ? 'y' : 'ies'} worked out last time.
            </li>
            {manualCount > 0 && (
              <li>
                Keeps the {manualCount} you typed by hand — a new one that contradicts yours is
                refused.
              </li>
            )}
            <li>
              {scenarioCount === 1 ? 'Your saved configuration is' : `All ${scenarioCount} saved configurations are`}{' '}
              kept. What each one includes may change, because a pick brings in whatever the graph
              says it needs.
            </li>
            <li>Costs a model call.</li>
          </ul>
          <div className="mt-2 flex gap-1.5">
            <Button onClick={derive} data-testid="scope-derive-confirm-yes">
              Yes, work it out again
            </Button>
            <Button
              variant="ghost"
              onClick={() => setConfirming(false)}
              data-testid="scope-derive-confirm-no"
            >
              Cancel
            </Button>
          </div>
        </div>
      )}

      {busy && (
        <div data-testid="scope-derive-progress" className="flex flex-col gap-1.5">
          <CrewTrack stages={STAGES} pct={state.pct} status="RUNNING" />
          <p className="flex items-baseline gap-2 text-[11.5px] text-ink-3">
            <span data-testid="scope-derive-stage">{state.label}</span>
            {/* The counted number, and the reason this is not just a spinner. */}
            {state.edgesFound !== undefined && state.edgesFound > 0 && (
              <span className="num text-ink-4" data-testid="scope-derive-found">
                {state.edgesFound} found
              </span>
            )}
            {state.cards !== undefined && (
              <span className="num text-ink-4">· {state.cards} modules read</span>
            )}
            <span className="num ml-auto text-ink-4" data-testid="scope-derive-elapsed">
              {formatElapsed(Math.floor((now - state.startedAt) / 1000))}
            </span>
          </p>
        </div>
      )}

      {state.phase === 'done' && (
        <p
          data-testid="scope-graph-derived"
          className="rounded-[8px] border border-line bg-surface-2 px-3 py-2 text-[12.5px] text-ink-2"
        >
          {state.summary}
        </p>
      )}

      {state.phase === 'failed' && (
        <p
          data-testid="scope-derive-error"
          className="rounded-[8px] border border-red/40 bg-red/5 px-3 py-2 text-[12.5px] text-red"
        >
          {state.error}
        </p>
      )}
    </div>
  );
}
