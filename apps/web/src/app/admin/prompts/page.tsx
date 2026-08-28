import Link from 'next/link';
import { TRACK_META, agentsByTrack, prisma, type AgentKind } from '@repo/db';
import { Card, Eyebrow, Heading } from '@/components/ui/card';
import { Pill } from '@/components/ui/pill';
import { AgentPipeline } from './AgentPipeline';

/**
 * Every agent's prompt, grouped by which system the agent belongs to.
 *
 * This page used to be a flat table of enum values. It let an admin rewrite the
 * system prompt of any agent while telling them nothing about what that agent
 * reads, what it produces, where it sits in a run, or — for one of them —
 * whether editing it does anything at all. The descriptions come from the
 * catalogue in @repo/db, so they cannot drift from the set of agents.
 *
 * The grouping is the part that matters most now that Oracle exists. Editing a
 * crew prompt changes what every future estimate is worth; editing Oracle's
 * changes the next answer somebody gets and no estimate at all. Those are not
 * the same risk and should not look the same.
 *
 * Colour is not used to carry the distinction. globals.css reserves green for
 * settled quantity, bronze for in-flight and brick for failure, and states that
 * the three jobs never mix — so grouping, headings and wording do the work.
 */
export default async function PromptsAdminPage() {
  const prompts = await prisma.prompt.findMany({
    include: { versions: { orderBy: { version: 'desc' } } },
  });
  const byKind = new Map(prompts.map((p) => [p.kind as AgentKind, p]));

  return (
    <div data-testid="admin-prompts">
      <Heading level={1}>Agents</Heading>
      <p className="mt-1.5 text-[13px] text-ink-3">
        One system prompt per agent. Editing one creates a new active version, and takes effect
        the next time that agent runs — there is no deploy in the loop.
      </p>

      {agentsByTrack().map(({ track, agents }) => {
        const meta = TRACK_META[track];
        return (
          <section key={track} className="mt-7" data-testid={`agent-track-${track}`}>
            <Eyebrow>{meta.label}</Eyebrow>
            <p className="mt-1 max-w-[720px] text-[12.5px] leading-relaxed text-ink-3">
              {meta.description}
            </p>

            {track === 'RUN_CREW' && (
              <div className="mt-3">
                <AgentPipeline />
              </div>
            )}

            <Card className="mt-3 overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-[13px]">
                  <thead>
                    <tr className="border-b border-line bg-surface-2 text-left">
                      <th className="eyebrow px-4 py-2.5 font-bold">Agent</th>
                      <th className="eyebrow px-4 py-2.5 font-bold">What it does</th>
                      <th className="eyebrow px-4 py-2.5 font-bold">Active</th>
                      <th className="eyebrow px-4 py-2.5 font-bold">Model</th>
                      <th className="eyebrow px-4 py-2.5 text-right font-bold">Versions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {agents.map((agent) => {
                      const prompt = byKind.get(agent.kind);
                      const active = prompt?.versions.find((v) => v.active);
                      return (
                        <tr
                          key={agent.kind}
                          className="border-b border-line-soft align-top last:border-0 hover:bg-surface-2"
                        >
                          <td className="px-4 py-3">
                            <Link
                              href={`/admin/prompts/${agent.kind}`}
                              className="font-semibold text-ink hover:text-green hover:underline"
                              data-testid={`prompt-link-${agent.kind}`}
                            >
                              {agent.label}
                            </Link>
                            <div className="num mt-0.5 text-[10.5px] text-ink-4">{agent.kind}</div>
                          </td>

                          <td className="max-w-[420px] px-4 py-3">
                            <p className="text-[12.5px] leading-relaxed text-ink-2">
                              {agent.blurb}
                            </p>
                            {/* The longer read stays folded away: this table is
                                scanned far more often than it is studied. */}
                            <details className="group mt-1">
                              <summary className="cursor-pointer list-none text-[11.5px] text-ink-3 hover:text-green">
                                <span className="group-open:hidden">More</span>
                                <span className="hidden group-open:inline">Less</span>
                              </summary>
                              <p className="mt-1.5 text-[12px] leading-relaxed text-ink-3">
                                {agent.summary}
                              </p>
                            </details>
                          </td>

                          <td className="px-4 py-3">
                            {!prompt ? (
                              <Pill tone="bronze">not seeded</Pill>
                            ) : active ? (
                              <Pill tone="green" dot={false} className="num">
                                v{active.version}
                              </Pill>
                            ) : (
                              <Pill tone="bronze">none active</Pill>
                            )}
                          </td>

                          <td className="num px-4 py-3 text-[12px] text-ink-2">
                            {active?.modelString ?? '—'}
                          </td>
                          <td className="num px-4 py-3 text-right text-ink-3">
                            {prompt?.versions.length ?? 0}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </Card>
          </section>
        );
      })}
    </div>
  );
}
