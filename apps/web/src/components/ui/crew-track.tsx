'use client';

import { Check, X } from 'lucide-react';
import { cn } from '@/lib/utils';

export type RunStatus = 'IDLE' | 'RUNNING' | 'DONE' | 'FAILED';

/** A named agent and the slice of the run it owns. */
export type CrewStage = {
  key: string;
  name: string;
  /** Inclusive lower bound of this stage's percentage span. */
  from: number;
};

/**
 * The five agents of the run pipeline, mapped onto the percentage spans that
 * `packages/agents/src/run-estimate.ts` actually reports. Position is derived
 * from the percentage rather than by matching the stage string, so re-wording
 * a stage label can never desync the track.
 */
export const RUN_CREW: CrewStage[] = [
  { key: 'setup', name: 'Setup', from: 0 },
  { key: 'librarian', name: 'Librarian', from: 8 },
  { key: 'detective', name: 'Detective & Archivist', from: 20 },
  { key: 'specialists', name: 'Specialists', from: 35 },
  { key: 'architect', name: 'Architect', from: 85 },
];

/** Which stage owns this percentage. */
export function crewIndexFor(stages: CrewStage[], pct: number): number {
  let idx = 0;
  for (let i = 0; i < stages.length; i += 1) {
    if (pct >= stages[i]!.from) idx = i;
  }
  return idx;
}

/**
 * The crew track — the run's progress bar and its cast list in one element.
 *
 * A separate bar underneath would encode the same left-to-right progress
 * twice, so the track carries it: each connector is a stage span, filled green
 * once passed, and the span leaving the active agent fills bronze as that
 * stage advances. On failure the encoding stays honest — green in, red node,
 * grey out: reaching the agent succeeded, the agent is what failed, and
 * nothing past it ran.
 */
export function CrewTrack({
  stages,
  pct,
  status,
  className,
}: {
  stages: CrewStage[];
  pct: number;
  status: RunStatus;
  className?: string;
}) {
  const active = crewIndexFor(stages, pct);

  const stateOf = (i: number): 'done' | 'active' | 'failed' | 'todo' => {
    if (status === 'IDLE') return 'todo';
    if (status === 'DONE') return 'done';
    if (i < active) return 'done';
    if (i === active) return status === 'FAILED' ? 'failed' : 'active';
    return 'todo';
  };

  /** The connector running into node `i`, from the node before it. */
  const connector = (i: number): string => {
    const s = stateOf(i);
    if (s === 'done' || s === 'active' || s === 'failed') return 'var(--color-green)';
    // The span leaving the active agent fills as that stage progresses.
    if (status === 'RUNNING' && i === active + 1) {
      const from = stages[active]!.from;
      const to = stages[i]!.from;
      const within = to > from ? Math.max(0, Math.min(100, ((pct - from) / (to - from)) * 100)) : 0;
      return `linear-gradient(90deg, var(--color-bronze) ${within}%, var(--color-line) ${within}%)`;
    }
    return 'var(--color-line)';
  };

  return (
    <ol
      className={cn('grid gap-1', className)}
      style={{ gridTemplateColumns: `repeat(${stages.length}, minmax(0, 1fr))` }}
    >
      {stages.map((stage, i) => {
        const s = stateOf(i);
        return (
          <li
            key={stage.key}
            className="relative flex flex-col items-center gap-2 pt-0.5 text-center"
            data-state={s}
            data-testid={`crew-${stage.key}`}
          >
            {i > 0 && (
              <span
                aria-hidden
                className="absolute top-[9px] left-[-50%] h-[3px] w-full rounded-full"
                style={{ background: connector(i) }}
              />
            )}

            <span
              className={cn(
                'relative z-[1] grid h-3.5 w-3.5 shrink-0 place-items-center rounded-full border-2',
                s === 'done' && 'border-green bg-green',
                s === 'active' && 'border-bronze bg-bronze',
                s === 'failed' && 'border-brick bg-brick',
                s === 'todo' && 'border-line bg-surface',
              )}
            >
              {s === 'active' && (
                <span
                  aria-hidden
                  className="absolute -inset-[5px] animate-ping rounded-full border-2 border-bronze opacity-50"
                />
              )}
              {s === 'done' && <Check className="h-2 w-2 text-surface" strokeWidth={4} aria-hidden />}
              {s === 'failed' && <X className="h-2 w-2 text-surface" strokeWidth={4} aria-hidden />}
            </span>

            <span
              className={cn(
                'text-[11px] leading-tight',
                s === 'active' && 'font-bold text-bronze-ink',
                s === 'failed' && 'font-bold text-brick',
                s === 'done' && 'text-ink-2',
                s === 'todo' && 'text-ink-3',
              )}
            >
              {stage.name}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/** "Estimating items (Specialists 6/9)" → "Estimating items" + "Specialist 6 of 9". */
export function readStage(stage: string | null): { label: string; detail: string | null } {
  if (!stage) return { label: 'Working…', detail: null };

  const m = /^(.*?)\s*\(([^)]+)\)\s*$/.exec(stage);
  if (!m) return { label: stage, detail: null };

  const label = m[1]!.trim();
  const inner = m[2]!.trim();

  // The agent name in the parenthetical is already lit up on the track, so the
  // only part worth repeating is the count.
  const counted = /^Specialists\s+(\d+)\/(\d+)$/.exec(inner);
  if (counted) return { label, detail: `Specialist ${counted[1]} of ${counted[2]}` };

  return { label, detail: null };
}

/** 72 → "1m 12s" */
export function formatElapsed(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}
