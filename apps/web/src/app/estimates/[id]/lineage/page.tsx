import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';

import { familiesOf, prisma, projectNameOf, rootOf } from '@repo/db';
import { auth } from '@/lib/auth';
import { ProjectName } from './ProjectName';
import { LineageComparison, ROLES, type Role, type RoundRow } from './LineageComparison';

export const dynamic = 'force-dynamic';

/**
 * A project, read across its rounds. AEH-236.
 *
 * The screen that exists because a lineage is not a version chain. Both
 * estimates in a branch are current, so the question is never "which is latest"
 * — it is "which of these am I sending", and that is a comparison.
 *
 * Data assembly only; `LineageComparison` renders it. Split so the table can be
 * looked at with fixture data — a four-round family with a title long enough to
 * truncate is a nuisance to seed and a line to write.
 */
export default async function LineagePage({ params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session?.user) redirect('/login');

  const { id } = await params;

  // Every estimate, because a family is a recursive walk — the same set the
  // dashboard already loads, and only the columns the comparison needs.
  const all = await prisma.estimate.findMany({
    // Deleted members drop out of the tree, and the `notFound()` below means
    // this screen 404s for a deleted estimate rather than rendering an empty
    // family. AEH-375.
    where: { deletedAt: null },
    select: {
      id: true,
      title: true,
      parentId: true,
      projectName: true,
      lineageKind: true,
      status: true,
      createdAt: true,
      complexityScore: true,
    },
  });
  if (!all.some((e) => e.id === id)) notFound();

  const root = rootOf(all, id);
  if (!root) notFound();
  const members = familiesOf(all).get(root.id) ?? [];

  // A family of one has nothing to compare. Send them to the estimate rather
  // than render a table with a single row and no question in it.
  if (members.length < 2) redirect(`/estimates/${id}`);

  const ordered = [...members].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

  const cards = await prisma.menuItem.findMany({
    where: { estimateId: { in: ordered.map((m) => m.id) }, enabled: true },
    select: {
      estimateId: true,
      title: true,
      lineItems: { select: { role: true, taxedHours: true } },
    },
  });

  // Totals over ENABLED cards only — the same rule the roll-up on the estimate
  // page follows, so a figure here agrees with the one there.
  const blank = (): RoundRow['byRole'] => ({ DEV: 0, QA: 0, PM: 0, BA: 0 });
  const acc = new Map<string, { byRole: RoundRow['byRole']; grand: number }>(
    ordered.map((m) => [m.id, { byRole: blank(), grand: 0 }]),
  );
  const presence = new Set<string>();
  for (const card of cards) {
    const t = acc.get(card.estimateId);
    if (!t) continue;
    presence.add(`${card.estimateId} ${card.title}`);
    for (const li of card.lineItems) {
      if ((ROLES as readonly string[]).includes(li.role)) {
        t.byRole[li.role as Role] += li.taxedHours;
        t.grand += li.taxedHours;
      }
    }
  }

  const rounds: RoundRow[] = ordered.map((m) => {
    const t = acc.get(m.id)!;
    return {
      id: m.id,
      title: m.title,
      status: m.status,
      lineageKind: m.lineageKind,
      createdAt: m.createdAt,
      byRole: t.byRole,
      grand: t.grand,
      complexity: m.complexityScore,
    };
  });

  // Only the cards that DIFFER. Listing work every round shares would bury the
  // handful of lines that actually answer "what is different about these".
  //
  // Matched on title, which is the only option available: a fork gives every
  // card a new id by construction, so an id comparison would report every round
  // as entirely unlike every other.
  const allTitles = [...new Set(cards.map((c) => c.title))].sort();
  const differing = allTitles.filter((t) => {
    const present = ordered.map((m) => presence.has(`${m.id} ${t}`));
    return present.some(Boolean) && !present.every(Boolean);
  });

  return (
    <div data-testid="lineage-page">
      <Link href="/dashboard" className="text-[12.5px] text-ink-3 hover:text-green hover:underline">
        ← All projects
      </Link>

      <div className="mt-3">
        <ProjectName estimateId={root.id} initialName={projectNameOf(members, root)} />
        <p className="mt-1 text-[13px] text-ink-3">
          <span className="num">{ordered.length}</span> estimates in this project. A successor and a
          branch both stay live — nothing here is superseded.
        </p>
      </div>

      <LineageComparison rounds={rounds} differing={differing} presence={presence} />
    </div>
  );
}
