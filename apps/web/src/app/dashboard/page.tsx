import Link from 'next/link';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { prisma } from '@repo/db';
import { auth } from '@/lib/auth';
import { deleteEstimate } from '@/app/estimates/[id]/actions';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Button } from '@/components/ui/button';
import { Heading } from '@/components/ui/card';
import { Pill, STATUS_TONE, type PillTone } from '@/components/ui/pill';
import { compareByDue, dueLabel, dueState, formatDueDate, type DueState } from '@/lib/due-date';

// Routed through the shared `deleteEstimate` rather than calling prisma here:
// the owner-or-admin check lives in that one place, and a second delete path
// that skipped it is exactly how this row grew an authorization hole.
async function deleteEstimateAction(formData: FormData) {
  'use server';
  const id = formData.get('id');
  if (typeof id !== 'string') return;
  await deleteEstimate(id);
  revalidatePath('/dashboard');
}

/** The ledger's column heads: quiet, uppercase, structural. */
function Th({
  children,
  className = '',
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <th scope="col" className={`eyebrow px-3 py-2.5 text-left font-bold ${className}`}>
      {children}
    </th>
  );
}

/** Pills for the states that need acting on; quiet text for the ones that don't. */
const URGENT_TONE: Partial<Record<DueState, PillTone>> = {
  overdue: 'brick',
  'due-today': 'bronze',
};

function DueMark({ state, children }: { state: DueState; children: string }) {
  const tone = URGENT_TONE[state];
  if (tone) {
    return (
      <Pill tone={tone} className="px-2 py-0.5 text-[10px]">
        {state === 'overdue' ? 'Overdue' : 'Due today'}
      </Pill>
    );
  }
  // `settled` is a finalised estimate whose date has passed. It says the date
  // and stops there: nothing is owed, so nothing should catch the eye.
  return <span className="text-[11.5px] text-ink-4">{state === 'settled' ? '' : children}</span>;
}

export default async function DashboardPage() {
  const session = await auth();
  if (!session?.user) {
    redirect('/login');
  }

  // One clock for the whole table, so two rows a millisecond apart can't land
  // on different days.
  const now = new Date();

  // Ordered in memory rather than by the database: "overdue, then soonest, then
  // everything else" depends on today's date and on status together, which is a
  // rule SQL can only express as a CASE this page would then have to keep in
  // step with `compareByDue`. The dashboard loads every estimate anyway.
  const estimates = (
    await prisma.estimate.findMany({
      include: {
        owner: { select: { email: true } },
        custodian: { select: { email: true, name: true } },
      },
    })
  ).sort((a, b) => compareByDue(a, b, now));

  // Everyone sees every estimate — that's the shared ledger. Only the owner or
  // an admin may destroy one, so only they get the control.
  const isAdmin = session.user.role === 'ADMIN';
  const canDelete = (ownerId: string) => isAdmin || ownerId === session.user.id;

  return (
    <div data-testid="dashboard">
      {/* ── masthead ──────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <Heading level={1}>Estimates</Heading>
          <p className="mt-1 text-[13px] text-ink-3">
            {estimates.length === 0 ? (
              'Nothing on the books yet.'
            ) : (
              <>
                <span className="num">{estimates.length}</span>{' '}
                {estimates.length === 1 ? 'estimate' : 'estimates'} on the books.
              </>
            )}
          </p>
        </div>
        <Button asChild size="lg">
          <Link href="/estimates/new" data-testid="new-estimate">
            New estimate
          </Link>
        </Button>
      </div>

      {estimates.length === 0 ? (
        /* An empty ledger invites the first entry — it doesn't apologise. */
        <div
          className="mt-6 rounded-[10px] border border-dashed border-line bg-surface px-6 py-12 text-center"
          data-testid="estimates-empty"
        >
          <div className="font-serif text-[20px] text-ink">No estimates yet</div>
          <p className="mx-auto mt-1.5 max-w-[400px] text-[13px] leading-relaxed text-ink-3">
            Start with a statement of work and the crew will draft a menu card, hours and all. You
            can edit every line afterwards.
          </p>
          <Button asChild className="mt-5">
            <Link href="/estimates/new">Create the first estimate</Link>
          </Button>
        </div>
      ) : (
        /* `relative` is load-bearing. The header's `sr-only` span is
           position:absolute, and a scroll container only clips absolutely
           positioned descendants when it is their containing block. Without it
           the span anchors to <html> at the table's full width and drags
           the whole page sideways on mobile. */
        <div className="relative mt-6 overflow-x-auto rounded-[10px] border border-line bg-surface">
          <table className="w-full min-w-[760px] border-collapse text-sm" data-testid="estimates-table">
            <thead>
              <tr className="border-b border-line bg-surface-2">
                <Th>Title</Th>
                <Th>Status</Th>
                <Th>Custodian</Th>
                <Th>Due</Th>
                <Th>Created</Th>
                <Th className="text-right">
                  <span className="sr-only">Actions</span>
                </Th>
              </tr>
            </thead>
            <tbody>
              {estimates.map((e) => (
                <tr
                  key={e.id}
                  className="group border-b border-line-soft last:border-0 hover:bg-surface-2"
                >
                  <td className="px-3 py-3">
                    <Link
                      href={`/estimates/${e.id}`}
                      className="font-serif text-[15.5px] text-ink hover:text-green hover:underline"
                      data-testid={`estimate-row-${e.id}`}
                    >
                      {e.title}
                    </Link>
                  </td>
                  <td className="px-3 py-3">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Pill tone={STATUS_TONE[e.status] ?? 'neutral'}>{e.status}</Pill>
                      {/* Work in flight is visible from the list, not just the detail page. */}
                      {e.runStatus === 'RUNNING' && <Pill tone="bronze">Running</Pill>}
                      {e.runStatus === 'FAILED' && <Pill tone="brick">Run failed</Pill>}
                    </div>
                  </td>
                  {/* Custodian, not owner: the question this column answers on a
                      shared ledger is "whose desk is it on", and the owner is
                      only the fallback answer to that. */}
                  <td className="px-3 py-3 text-[13px] text-ink-2">
                    {e.custodian ? (
                      e.custodian.name ?? e.custodian.email
                    ) : (
                      <span className="text-ink-4" title={`Owner: ${e.owner.email}`}>
                        {e.owner.email}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-3 text-[12.5px] whitespace-nowrap">
                    {e.dueAt ? (
                      <div data-testid={`estimate-due-${e.id}`}>
                        <span className="num text-ink-2">{formatDueDate(e.dueAt)}</span>
                        {/* The state gets a WORD, not just a colour — the same
                            rule the status pills follow, and the reason this
                            survives greyscale, colourblindness and a printout.
                            Only urgency is worth a pill; everything else says
                            how far off it is in plain muted text. */}
                        <div className="mt-0.5">
                          <DueMark state={dueState(e.dueAt, now, e.status === 'FINALISED')}>
                            {dueLabel(e.dueAt, now)}
                          </DueMark>
                        </div>
                      </div>
                    ) : (
                      <span className="text-ink-4">—</span>
                    )}
                  </td>
                  <td className="num px-3 py-3 text-[12.5px] whitespace-nowrap text-ink-3">
                    {new Date(e.createdAt).toLocaleDateString()}
                  </td>
                  <td className="px-3 py-3 text-right">
                    {/* Destruction stays quiet: it surfaces on hover/focus and never
                        competes with "New estimate". */}
                    {canDelete(e.ownerId) && (
                    <ConfirmDialog
                      action={deleteEstimateAction}
                      hidden={{ id: e.id }}
                      title="Delete estimate?"
                      description={
                        <>
                          <span className="font-medium text-ink">{e.title}</span> and everything
                          under it will be permanently deleted. This can&rsquo;t be undone.
                        </>
                      }
                      confirmLabel="Delete estimate"
                      trigger={
                        <Button
                          type="button"
                          variant="quiet"
                          size="xs"
                          className="text-ink-4 opacity-100 transition-opacity hover:text-brick focus-visible:opacity-100 sm:opacity-0 sm:group-hover:opacity-100"
                          data-testid={`delete-estimate-${e.id}`}
                        >
                          Delete
                        </Button>
                      }
                    />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
