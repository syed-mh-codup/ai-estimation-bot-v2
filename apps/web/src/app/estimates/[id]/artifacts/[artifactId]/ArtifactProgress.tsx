'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Check, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardBody, Eyebrow } from '@/components/ui/card';

/**
 * What a generating artifact is actually doing. AEH-239.
 *
 * ## Why this is a checklist and not the run's CrewTrack
 *
 * `CrewTrack` is a horizontal grid with one column per stage and a centred
 * label under each node. That works for the run, whose five agents are fixed
 * and short-named. An artifact has between one and about nine sections, named
 * by the model, and "Re-allocation provenance" in a ninth of the width is not a
 * label anybody can read. Same colour language — green done, bronze in flight,
 * grey still to come — in the orientation that fits the content.
 *
 * ## Why the steps can be named at all
 *
 * Because the outline is persisted BEFORE any section is written. Once planning
 * finishes, the number of sections and each of their titles are facts on the
 * row, so this shows real names ticking off rather than a percentage nobody can
 * check. Before that there is genuinely nothing to name, and it says so.
 */

type Snapshot = {
  status: 'IDLE' | 'RUNNING' | 'DONE' | 'FAILED';
  stage: string | null;
  pct: number;
  error: string | null;
  title: string | null;
  sections: { id: string; title: string }[];
  written: string[];
};

export function ArtifactProgress({
  estimateId,
  artifactId,
  initial,
}: {
  estimateId: string;
  artifactId: string;
  initial: Snapshot;
}) {
  const router = useRouter();
  const [snap, setSnap] = useState<Snapshot>(initial);
  // Set the moment Stop is pressed and never cleared: Inngest cancels BETWEEN
  // steps, so the section already talking to the model finishes first and the
  // poll keeps reporting progress for up to a couple of minutes afterwards.
  // Without this the button would spring back to "Stop" and read as if the
  // click had been lost.
  const [stopping, setStopping] = useState(false);
  const [stopError, setStopError] = useState<string | null>(null);

  const live = snap.status === 'RUNNING' || snap.status === 'IDLE';

  const tick = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/estimates/${estimateId}/artifacts/${artifactId}/status`,
        { cache: 'no-store' },
      );
      if (!res.ok) return;
      const next = (await res.json()) as Snapshot;
      setSnap(next);
      // The finished document is rendered by the server component, so once
      // generation lands the page has to be re-fetched for the iframe to
      // appear. Without this the bar would sit at 100% next to nothing.
      if (next.status === 'DONE' || next.status === 'FAILED') router.refresh();
    } catch {
      // A dropped poll is not worth reporting — the next tick recovers, and an
      // error banner that flickers on a flaky connection is worse than silence.
    }
  }, [estimateId, artifactId, router]);

  const stop = useCallback(async () => {
    setStopping(true);
    setStopError(null);
    try {
      const res = await fetch(
        `/api/estimates/${estimateId}/artifacts/${artifactId}/cancel`,
        { method: 'POST' },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setStopError(body.error ?? 'Could not stop this generation.');
        setStopping(false);
        return;
      }
      // Don't wait for the next poll to show it — the row is already settled by
      // the route, and two seconds of "writing sections" after pressing Stop
      // reads as a broken button.
      void tick();
    } catch {
      setStopError('Could not reach the server. It may still be generating.');
      setStopping(false);
    }
  }, [estimateId, artifactId, tick]);

  useEffect(() => {
    if (!live) return;
    const iv = setInterval(() => void tick(), 2000);
    return () => clearInterval(iv);
  }, [live, tick]);

  if (!live) return null;

  const done = new Set(snap.written);
  const planned = snap.sections.length;
  const writtenCount = snap.sections.filter((s) => done.has(s.id)).length;
  // The first planned section that has not landed yet is the one in flight.
  const activeIndex = snap.sections.findIndex((s) => !done.has(s.id));

  return (
    <Card className="mt-5 max-w-[720px]" data-testid="artifact-progress">
      <CardBody>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <Eyebrow>{snap.stage ?? 'Working'}</Eyebrow>
          <div className="flex items-center gap-3">
            {planned > 0 && (
              <span className="num text-[11.5px] text-ink-3" data-testid="artifact-progress-count">
                {writtenCount} of {planned} written
              </span>
            )}
            <Button
              variant="danger"
              size="xs"
              onClick={() => void stop()}
              disabled={stopping}
              data-testid="stop-artifact"
            >
              <X size={12} strokeWidth={2.5} />
              {stopping ? 'Stopping' : 'Stop'}
            </Button>
          </div>
        </div>

        <div
          className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-line-soft"
          role="progressbar"
          aria-valuenow={snap.pct}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div
            className="h-full rounded-full bg-green transition-[width] duration-500"
            style={{ width: `${Math.max(2, Math.min(100, snap.pct))}%` }}
          />
        </div>

        {planned === 0 ? (
          <p className="mt-3 text-[12.5px] leading-relaxed text-ink-3">
            Planning the document. Until that finishes there is genuinely nothing to name — the
            sections, and how many there are, are decided by this step.
          </p>
        ) : (
          <>
            {snap.title && (
              <p className="mt-3 text-[13px] font-semibold text-ink">{snap.title}</p>
            )}
            <ol className="mt-2 space-y-1.5" data-testid="artifact-progress-sections">
              {snap.sections.map((s, i) => {
                const state =
                  done.has(s.id) ? 'done' : i === activeIndex ? 'active' : 'todo';
                return (
                  <li
                    key={s.id}
                    className="flex items-center gap-2 text-[12.5px]"
                    data-state={state}
                    data-testid={`artifact-section-${s.id}`}
                  >
                    <span
                      aria-hidden
                      className={
                        state === 'done'
                          ? 'flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-green text-surface'
                          : state === 'active'
                            ? 'h-4 w-4 shrink-0 animate-pulse rounded-full border-2 border-bronze bg-bronze-tint'
                            : 'h-4 w-4 shrink-0 rounded-full border border-line bg-surface-2'
                      }
                    >
                      {state === 'done' && <Check size={10} strokeWidth={3} />}
                    </span>
                    <span
                      className={
                        state === 'todo'
                          ? 'text-ink-4'
                          : state === 'active'
                            ? 'text-ink'
                            : 'text-ink-2'
                      }
                    >
                      {s.title}
                    </span>
                  </li>
                );
              })}
            </ol>
            <p className="mt-2.5 text-[11.5px] text-ink-4">
              Each section is written by its own model call, so they land one at a time. Anything
              already ticked is saved — a failure part-way keeps it, and so does stopping.
            </p>
          </>
        )}
        {stopping && (
          <p className="mt-2.5 text-[11.5px] text-ink-3" data-testid="stopping-notice">
            Stopping. The section being written right now will finish first — it is paid for
            either way, so it is kept rather than thrown away.
          </p>
        )}
        {stopError && (
          <p className="mt-2.5 text-[11.5px] text-brick" data-testid="stop-error">
            {stopError}
          </p>
        )}
      </CardBody>
    </Card>
  );
}
