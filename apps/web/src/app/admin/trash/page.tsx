import { prisma } from '@repo/db';

import { Card, Heading } from '@/components/ui/card';
import { Pill } from '@/components/ui/pill';
import { RecoverEstimateButton } from '@/app/estimates/[id]/RecoverEstimateButton';

/**
 * Every deleted estimate, and the way back. AEH-375.
 *
 * The discoverable half of recovery. An owner reaches a deleted estimate
 * through its own URL — the link they already have, which now renders a notice
 * instead of a 404 — but that only helps somebody who still knows the link.
 * This is the list for the case where nobody does.
 *
 * Admin-only because `/admin/*` is, not because recovery is: the action itself
 * takes the owner or an admin, and an owner who finds their way to a deleted
 * estimate can restore it without anybody's help. The split is about
 * discoverability, not permission.
 *
 * Unlike every other admin surface this one has a write action, and that is
 * the point of it. It is also the only screen in the product that reads
 * `deletedAt: { not: null }`; everywhere else filters the other way.
 *
 * Nothing here expires. There is no purge sweep and no retention window, so
 * this list only ever grows — which is the correct trade while the alternative
 * is a background job that can still lose somebody's week. If it ever gets
 * long enough to matter, paginate it; do not add a sweep by reflex.
 */
export default async function AdminTrashPage() {
  const deleted = await prisma.estimate.findMany({
    where: { deletedAt: { not: null } },
    orderBy: { deletedAt: 'desc' },
    select: {
      id: true,
      title: true,
      status: true,
      deletedAt: true,
      owner: { select: { email: true } },
      deletedBy: { select: { email: true, name: true } },
    },
  });

  return (
    <div data-testid="admin-trash">
      <Heading level={1} className="text-[28px]">
        Deleted estimates
      </Heading>
      <p className="mt-1 max-w-[70ch] text-[13px] text-ink-3">
        Deleting an estimate hides it; it does not destroy it. Every card, line
        item, statement, scope scenario, artifact and export is still here, with
        the same ids, so recovering one brings it back exactly as it was and
        anything forked from it still lines up. Nothing on this list expires —
        only a deletion run directly against the database removes an estimate
        for good.
      </p>

      {deleted.length === 0 ? (
        <Card className="mt-5">
          <p className="p-8 text-center text-[13px] text-ink-3" data-testid="trash-empty">
            Nothing has been deleted.
          </p>
        </Card>
      ) : (
        <Card className="mt-5 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[13px]" data-testid="trash-table">
              <thead>
                <tr className="border-b border-line bg-surface-2 text-left">
                  <th className="eyebrow px-4 py-2.5 font-bold">Estimate</th>
                  <th className="eyebrow px-4 py-2.5 font-bold">Owner</th>
                  <th className="eyebrow px-4 py-2.5 font-bold">Deleted by</th>
                  <th className="eyebrow px-4 py-2.5 font-bold">Deleted</th>
                  <th className="eyebrow px-4 py-2.5 font-bold text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {deleted.map((e) => (
                  <tr
                    key={e.id}
                    className="border-b border-line-soft last:border-0"
                    data-testid={`trash-row-${e.id}`}
                  >
                    <td className="px-4 py-3">
                      <div className="font-medium text-ink">{e.title}</div>
                      <Pill className="mt-1">{e.status}</Pill>
                    </td>
                    <td className="px-4 py-3 text-ink-2">{e.owner.email}</td>
                    <td className="px-4 py-3 text-ink-2">
                      {e.deletedBy?.name ?? e.deletedBy?.email ?? (
                        <span className="text-ink-4">a deleted account</span>
                      )}
                    </td>
                    <td className="num whitespace-nowrap px-4 py-3 text-ink-3">
                      {/* Formatted on the server in UTC, so this reads the same
                          in every browser and cannot trip hydration. */}
                      {e.deletedAt?.toLocaleString('en-GB', {
                        day: 'numeric',
                        month: 'short',
                        year: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit',
                        timeZone: 'UTC',
                      })}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end">
                        <RecoverEstimateButton estimateId={e.id} label="Recover" size="sm" />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
