import Link from 'next/link';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { prisma } from '@repo/db';
import { auth } from '@/lib/auth';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Button } from '@/components/ui/button';
import { Heading } from '@/components/ui/card';
import { Pill, STATUS_TONE } from '@/components/ui/pill';

async function deleteEstimateAction(formData: FormData) {
  'use server';
  const session = await auth();
  if (!session?.user) return;
  const id = formData.get('id');
  if (typeof id !== 'string') return;
  await prisma.estimate.delete({ where: { id } });
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

export default async function DashboardPage() {
  const session = await auth();
  if (!session?.user) {
    redirect('/login');
  }

  const estimates = await prisma.estimate.findMany({
    orderBy: { createdAt: 'desc' },
    include: { owner: { select: { email: true } } },
  });

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
           the span anchors to <html> at the table's full 640px width and drags
           the whole page sideways on mobile. */
        <div className="relative mt-6 overflow-x-auto rounded-[10px] border border-line bg-surface">
          <table className="w-full min-w-[640px] border-collapse text-sm" data-testid="estimates-table">
            <thead>
              <tr className="border-b border-line bg-surface-2">
                <Th>Title</Th>
                <Th>Status</Th>
                <Th>Owner</Th>
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
                  <td className="px-3 py-3 text-[13px] text-ink-2">{e.owner.email}</td>
                  <td className="num px-3 py-3 text-[12.5px] whitespace-nowrap text-ink-3">
                    {new Date(e.createdAt).toLocaleDateString()}
                  </td>
                  <td className="px-3 py-3 text-right">
                    {/* Destruction stays quiet: it surfaces on hover/focus and never
                        competes with "New estimate". */}
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
