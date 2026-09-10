import Link from 'next/link';
import { ArrowUpRight, GitBranch } from 'lucide-react';

import { Pill, STATUS_TONE } from '@/components/ui/pill';
import type { LineageKind } from '@repo/db';

/** How a fork's relationship to its parent reads, from the fork's side. */
const FROM_CHILD: Record<LineageKind, string> = {
  SUCCESSOR: 'Successor to',
  BRANCH: 'Branch of',
};

/** And from the parent's, where the same edge is read the other way round. */
const FROM_PARENT: Record<LineageKind, string> = {
  SUCCESSOR: 'successor',
  BRANCH: 'branch',
};

/**
 * Where this estimate came from — one line, under the title. AEH-236.
 *
 * The minimum for not losing track of which round you are reading. It says the
 * relationship rather than just naming the parent, because "successor to" and
 * "branch of" are different claims: one supersedes a conversation, the other
 * runs alongside it.
 */
export function ForkedFrom({
  parent,
  kind,
}: {
  parent: { id: string; title: string };
  kind: LineageKind;
}) {
  return (
    <p className="mt-1 flex items-center gap-1.5 text-[12px] text-ink-3" data-testid="forked-from">
      <GitBranch className="h-3 w-3 shrink-0 text-ink-4" />
      <span>{FROM_CHILD[kind]}</span>
      <Link
        href={`/estimates/${parent.id}`}
        className="inline-flex items-center gap-0.5 font-medium text-ink-2 underline decoration-line underline-offset-2 hover:decoration-ink-3"
      >
        {parent.title}
        <ArrowUpRight className="h-3 w-3" />
      </Link>
    </p>
  );
}

/**
 * What came out of this estimate — a rail block on the PARENT. AEH-236.
 *
 * The half people forget to build, and the one that prevents the expensive
 * mistake: opening round 1 and quoting a number that round 2 has already moved.
 * A parent that cannot say it has been forked is a document that looks current
 * and is not.
 */
export function ForksOfThis({
  forks,
}: {
  forks: { id: string; title: string; status: string; lineageKind: LineageKind | null; createdAt: Date }[];
}) {
  if (forks.length === 0) return null;

  return (
    <div
      className="rounded-[10px] border border-line bg-surface px-4 py-3.5"
      data-testid="forks-of-this"
    >
      <div className="eyebrow font-bold text-ink-3">
        {forks.length === 1 ? 'Fork of this estimate' : 'Forks of this estimate'}
      </div>
      <ul className="mt-2.5 space-y-2.5">
        {forks.map((c) => (
          <li key={c.id}>
            <Link
              href={`/estimates/${c.id}`}
              className="group block"
              data-testid={`fork-child-${c.id}`}
            >
              <span className="flex items-baseline justify-between gap-2">
                <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink-2 underline decoration-transparent underline-offset-2 group-hover:decoration-line">
                  {c.title}
                </span>
                <Pill tone={STATUS_TONE[c.status] ?? 'neutral'} className="shrink-0 px-1.5 py-0.5 text-[10px]">
                  {c.status}
                </Pill>
              </span>
              <span className="mt-0.5 block text-[11px] text-ink-4">
                {c.lineageKind ? FROM_PARENT[c.lineageKind] : 'fork'} ·{' '}
                {c.createdAt.toLocaleDateString('en-GB', {
                  day: 'numeric',
                  month: 'short',
                  timeZone: 'UTC',
                })}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
