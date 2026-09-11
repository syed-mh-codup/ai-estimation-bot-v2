import Link from 'next/link';
import { Trash2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardBody, Eyebrow, Heading } from '@/components/ui/card';
import { RecoverEstimateButton } from './RecoverEstimateButton';

/**
 * What `/estimates/<id>` renders once the estimate has been deleted. AEH-375.
 *
 * Deliberately a page rather than a 404. The rows are all still there —
 * deleting stamps a column and touches nothing else — so the honest thing for
 * this URL to say is "this was deleted, here is who did it and when", not
 * "there is nothing here". It is also the only route an owner has back: the
 * discoverable list lives at `/admin/trash` behind the admin layout, and a
 * link in somebody's history or a chat message is what a non-admin actually
 * has in their hands.
 *
 * Says plainly that nothing was destroyed, because the whole reason anybody
 * lands here in a hurry is that they think it was.
 */
export function DeletedEstimateNotice({
  estimateId,
  title,
  deletedAt,
  deletedBy,
  canRecover,
}: {
  estimateId: string;
  title: string;
  deletedAt: Date;
  deletedBy: string | null;
  canRecover: boolean;
}) {
  // Formatted on the server and rendered as text: an instant run through
  // `toLocaleString` in the browser would disagree with the server's render
  // and trip hydration.
  const when = deletedAt.toLocaleString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
  });

  return (
    <div className="mx-auto max-w-[560px] py-16" data-testid="deleted-estimate-notice">
      <Card>
        <CardBody className="p-6">
          <div className="flex items-center gap-2 text-ink-3">
            <Trash2 className="h-4 w-4" />
            <Eyebrow>Deleted</Eyebrow>
          </div>

          <Heading level={2} className="mt-3">
            {title}
          </Heading>

          <p className="mt-3 text-[13px] leading-relaxed text-ink-2">
            Deleted by{' '}
            <strong className="font-semibold text-ink">{deletedBy ?? 'a deleted account'}</strong>{' '}
            on <span className="num">{when} UTC</span>.
          </p>

          <p className="mt-3 text-[13px] leading-relaxed text-ink-3">
            Nothing was destroyed. Every card, line item, statement, scope
            scenario, artifact and export is exactly where it was, and
            recovering this estimate brings all of it back untouched — the same
            rows, with the same ids, so anything forked from it still lines up.
            Deleted estimates are kept indefinitely.
          </p>

          <div className="mt-5 flex flex-wrap items-center gap-3">
            {canRecover ? (
              <RecoverEstimateButton estimateId={estimateId} />
            ) : (
              <p className="text-[12.5px] text-ink-3" data-testid="recover-not-permitted">
                Only its owner or an admin can recover it.
              </p>
            )}
            <Button asChild variant="outline">
              <Link href="/dashboard">Back to estimates</Link>
            </Button>
          </div>
        </CardBody>
      </Card>
    </div>
  );
}
