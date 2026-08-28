import { AGENT_CATALOGUE } from '@repo/db';

/**
 * The estimation crew, in the order a run actually calls them.
 *
 * Driven by the catalogue rather than drawn by hand, so it cannot drift from
 * the list underneath it. Agents sharing an `order` run in parallel and are
 * stacked in one column, which is the only structural fact this needs to carry
 * — the Detective and the Archivist genuinely do run at the same time, and a
 * flat left-to-right strip would quietly claim otherwise.
 *
 * Not a second copy of CrewTrack: that renders live run PROGRESS and is
 * driven by percentages reported during a run. This is a static map of who is
 * in the crew, for somebody about to edit one of their prompts.
 */
export function AgentPipeline() {
  const crew = AGENT_CATALOGUE.filter((a) => a.track === 'RUN_CREW');
  const stages = [...new Set(crew.map((a) => a.order))].sort((a, b) => a - b);

  return (
    <div className="flex items-stretch gap-1.5 overflow-x-auto" data-testid="agent-pipeline">
      {stages.map((order, i) => (
        <div key={order} className="flex items-stretch gap-1.5">
          <div className="flex min-w-[132px] flex-col gap-1">
            {crew
              .filter((a) => a.order === order)
              .map((a) => (
                <div
                  key={a.kind}
                  className="flex-1 rounded-md border border-line-soft bg-surface-2 px-2.5 py-1.5"
                >
                  <div className="text-[12px] font-medium text-ink">{a.label}</div>
                  <div className="eyebrow mt-0.5 text-[9.5px] text-ink-4">
                    {a.produces[0]}
                  </div>
                </div>
              ))}
          </div>
          {i < stages.length - 1 && (
            <div className="flex items-center text-ink-4" aria-hidden>
              →
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
