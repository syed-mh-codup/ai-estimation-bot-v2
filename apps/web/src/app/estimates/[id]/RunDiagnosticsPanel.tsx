import { prisma } from '@repo/db';
import type { RunDiagnostics } from '@repo/agents';
import { Eyebrow } from '@/components/ui/card';

/**
 * What the last run noticed about itself.
 *
 * `checkSupervisorGates` runs on every estimate and its warnings went to
 * `console.warn` and a Json column, which is to say nowhere a human would look.
 * The counts beside them answer the question an estimator actually asks of a
 * number they distrust — "did anything back this up?" — because an estimate
 * where the Archivist matched nothing and the Detective raised nothing is a
 * different kind of estimate from one where both did, and the totals look
 * identical either way.
 *
 * Read-only, and quiet. This is provenance, not a task list; the panel above it
 * is where work happens. AEH-253.
 */

/**
 * Read the diagnostics off a persisted estimate.
 *
 * Permissive: an estimate that has never run has `{}` here, and every field is
 * treated as absent rather than as a zero, because "no run" and "a run that
 * found nothing" are different facts and only one of them is worth showing.
 */
function parseDiagnostics(agentState: unknown): Partial<RunDiagnostics> {
  if (!agentState || typeof agentState !== 'object' || Array.isArray(agentState)) return {};
  return agentState as Partial<RunDiagnostics>;
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div>
      <div className="eyebrow">{label}</div>
      <div className="num mt-0.5 text-[15px] text-ink">{value}</div>
    </div>
  );
}

export async function RunDiagnosticsPanel({ estimateId }: { estimateId: string }) {
  const est = await prisma.estimate.findUnique({
    where: { id: estimateId },
    select: { agentState: true },
  });
  if (!est) return null;

  const state = parseDiagnostics(est.agentState);
  if (!state.ranAt) return null;

  const warnings = state.gateWarnings ?? [];
  const requirementCount = state.librarianOutput?.requirements.length ?? 0;

  return (
    <section
      className="rounded-[10px] border border-line bg-surface p-4"
      data-testid="run-diagnostics"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <Eyebrow>Last run</Eyebrow>
        <span className="num text-[11px] text-ink-4" data-testid="run-diagnostics-at">
          {state.ranAt.slice(0, 16).replace('T', ' ')}
        </span>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-x-4 gap-y-3">
        <Stat label="Requirements" value={requirementCount} />
        <Stat label="Preset matches" value={state.archivistMatchCount ?? 0} />
        <Stat label="Risks raised" value={state.detectiveRiskCount ?? 0} />
        <Stat label="Open questions" value={state.detectiveQuestionCount ?? 0} />
      </div>

      {state.complexity && (
        <p className="mt-3 border-t border-line-soft pt-2.5 text-[12px] text-ink-3">
          Complexity scored <span className="num text-ink-2">{state.complexity.score}</span> of 5.
        </p>
      )}

      {warnings.length > 0 && (
        <div className="mt-3 border-t border-line-soft pt-2.5" data-testid="run-diagnostics-warnings">
          {/* Bronze is in flight, and colour never travels alone — the label does
              the work. These are consistency checks the run flagged and carried
              on past, not failures. */}
          <div className="eyebrow text-bronze-ink">
            {warnings.length} consistency {warnings.length === 1 ? 'warning' : 'warnings'}
          </div>
          <ul className="mt-1.5 space-y-1">
            {warnings.map((w) => (
              <li key={w} className="text-[12px] leading-relaxed text-ink-2">
                {w}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
