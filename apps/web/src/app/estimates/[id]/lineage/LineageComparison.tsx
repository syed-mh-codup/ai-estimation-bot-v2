import Link from 'next/link';
import { ArrowUpRight } from 'lucide-react';

import { Heading } from '@/components/ui/card';
import { Pill, STATUS_TONE } from '@/components/ui/pill';
import type { LineageKind } from '@repo/db';

export const ROLES = ['DEV', 'QA', 'PM', 'BA'] as const;
export type Role = (typeof ROLES)[number];

const KIND_WORD: Record<LineageKind, string> = {
  SUCCESSOR: 'successor',
  BRANCH: 'branch',
};

const round = (n: number): string => (Math.round(n * 10) / 10).toLocaleString();

export type RoundRow = {
  id: string;
  title: string;
  status: string;
  lineageKind: LineageKind | null;
  createdAt: Date;
  byRole: Record<Role, number>;
  grand: number;
  /** The pipeline's own score for this round, 1-5. Null before a run. */
  complexity: number | null;
};

/**
 * A project's rounds, side by side. AEH-236.
 *
 * Presentation only — every figure is computed by the page, which is what lets
 * this be looked at with fixture data instead of a seeded database. Worth the
 * split: the interesting cases here are a four-round family, a title long
 * enough to need truncating and a diff with nothing in it, none of which are
 * convenient to produce for real.
 */
export function LineageComparison({
  rounds,
  differing,
  presence,
}: {
  rounds: RoundRow[];
  /** Card titles that some rounds have and others do not. */
  differing: string[];
  /** `${estimateId} ${cardTitle}` for every card a round holds. */
  presence: Set<string>;
}) {
  return (
    <>
      <div className="mt-6 overflow-x-auto rounded-[10px] border border-line bg-surface">
        <table className="w-full min-w-[640px] border-collapse text-sm" data-testid="lineage-table">
          <thead>
            <tr className="border-b border-line bg-surface-2">
              <th scope="col" className="eyebrow w-8 px-3 py-2.5 text-right font-bold">
                #
              </th>
              <th scope="col" className="eyebrow px-3 py-2.5 text-left font-bold">
                Round
              </th>
              {ROLES.map((r) => (
                <th key={r} scope="col" className="eyebrow px-3 py-2.5 text-right font-bold">
                  {r}
                </th>
              ))}
              <th scope="col" className="eyebrow px-3 py-2.5 text-right font-bold">
                Total
              </th>
              {/* Complexity, not a card count. How many cards a round happens
                  to be cut into says nothing about the work — the same scope
                  split three ways or thirty reads identically here. The
                  pipeline's score is a judgement about the work itself, which
                  is what a comparison across rounds is actually asking. */}
              <th scope="col" className="eyebrow px-3 py-2.5 text-right font-bold">
                Complexity
              </th>
            </tr>
          </thead>
          <tbody>
            {rounds.map((m, i) => (
              // `relative` on the row is what lets the title's stretched
              // ::after cover it, so the whole row is the hit area. A stretched
              // link rather than an onClick handler: this stays a real anchor,
              // so it keyboard-focuses, middle-clicks into a new tab and reads
              // to a screen reader as one link instead of a mystery row.
              <tr
                key={m.id}
                className="relative border-b border-line-soft last:border-0 hover:bg-surface-2"
                data-testid={`lineage-row-${m.id}`}
              >
                {/* The number is the legend for the diff table below, where a
                    column per round is the only shape that fits and no title
                    would survive the width. */}
                <td className="num px-3 py-3 text-right text-[12.5px] text-ink-4">{i + 1}</td>
                <td className="px-3 py-3">
                  <Link
                    href={`/estimates/${m.id}`}
                    className="after:absolute after:inset-0 after:content-[''] inline-flex items-center gap-1 font-serif text-[15px] text-ink hover:text-green hover:underline"
                  >
                    {m.title}
                    <ArrowUpRight className="h-3.5 w-3.5 shrink-0" />
                  </Link>
                  <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
                    <Pill
                      tone={STATUS_TONE[m.status] ?? 'neutral'}
                      className="px-1.5 py-0.5 text-[10px]"
                    >
                      {m.status}
                    </Pill>
                    <span className="text-[11px] text-ink-4">
                      {m.lineageKind ? KIND_WORD[m.lineageKind] : 'the original'} ·{' '}
                      {m.createdAt.toLocaleDateString('en-GB', {
                        day: 'numeric',
                        month: 'short',
                        year: 'numeric',
                        timeZone: 'UTC',
                      })}
                    </span>
                  </div>
                </td>
                {ROLES.map((r) => (
                  <td key={r} className="num px-3 py-3 text-right text-[12.5px] text-ink-3">
                    {m.byRole[r] > 0 ? round(m.byRole[r]) : '—'}
                  </td>
                ))}
                <td className="num px-3 py-3 text-right text-[13px] font-semibold text-green">
                  {round(m.grand)}
                </td>
                <td className="num px-3 py-3 text-right text-[12.5px] text-ink-3">
                  {m.complexity ?? '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-7">
        <Heading level={2}>What differs</Heading>
        {differing.length === 0 ? (
          <p className="mt-1.5 text-[13px] text-ink-3" data-testid="lineage-no-diff">
            Every round holds the same set of cards. Where they differ is in the hours above.
          </p>
        ) : (
          <div className="mt-3 overflow-x-auto rounded-[10px] border border-line bg-surface">
            <table
              className="w-full min-w-[560px] border-collapse text-sm"
              data-testid="lineage-diff"
            >
              <thead>
                <tr className="border-b border-line bg-surface-2">
                  <th scope="col" className="eyebrow px-3 py-2.5 text-left font-bold">
                    Card
                  </th>
                  {/* Numbers, not titles. Every round in a family shares the
                      project's name, so truncated titles all read "Supplying
                      Dem…" — the width is spent on the half that is identical
                      and the distinguishing half is what gets cut. At twelve
                      rounds the header row was both unreadable AND off the
                      right edge. The number keys to the table above, which was
                      already sitting there as a legend. */}
                  {rounds.map((m, i) => (
                    <th
                      key={m.id}
                      scope="col"
                      className="eyebrow w-10 px-2 py-2.5 text-center font-bold"
                      title={m.title}
                    >
                      <a href={`/estimates/${m.id}`} className="num hover:text-green">
                        {i + 1}
                      </a>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {differing.map((title) => (
                  <tr key={title} className="border-b border-line-soft last:border-0">
                    <td className="px-3 py-2 text-[12.5px] whitespace-nowrap text-ink-2">
                      {title}
                    </td>
                    {rounds.map((m) => {
                      const has = presence.has(`${m.id} ${title}`);
                      return (
                        <td
                          key={m.id}
                          className="px-2 py-2 text-center"
                          data-testid={`diff-${m.id}-${has ? 'has' : 'missing'}`}
                        >
                          {has ? (
                            <span className="text-green" aria-label="in this round">
                              ✓
                            </span>
                          ) : (
                            <span className="text-ink-4" aria-label="not in this round">
                              —
                            </span>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="mt-2 text-[11.5px] leading-snug text-ink-4">
          Columns are the numbered rounds above. Cards are matched on title — a fork gives every
          card an id of its own, so titles are the only thing the rounds have in common, which means
          a renamed card reads here as one dropped and one added.
        </p>
      </div>
    </>
  );
}
