'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Link2, Unlink } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { FieldLabel, Select } from '@/components/ui/input';
import { linkToParent, unlinkFromParent } from './lineage-actions';

type Kind = 'SUCCESSOR' | 'BRANCH';

export type LinkCandidate = { id: string; title: string };

/**
 * Relate this estimate to one that already exists. AEH-236.
 *
 * Lineage otherwise only comes into being by forking, which leaves nothing to
 * say about the estimates already on the platform — and those are exactly the
 * ones that need it. Two takes on the same client's platform, estimated
 * separately before any of this existed, are alternates of each other by any
 * reading; without this they sit on the dashboard as unrelated projects that
 * happen to share a name.
 *
 * Says plainly that nothing is copied, because the word "fork" everywhere else
 * on this screen means a copy and this deliberately is not one. The rows on
 * both estimates stay exactly as they are, and no carried marks appear — which
 * is the truthful outcome: this estimate was not derived from that one, it was
 * written alongside it.
 */
export function LinkLineageDialog({
  estimateId,
  candidates,
}: {
  estimateId: string;
  candidates: LinkCandidate[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [parentId, setParentId] = useState('');
  const [kind, setKind] = useState<Kind>('BRANCH');
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  if (candidates.length === 0) return null;

  const submit = (): void => {
    if (!parentId) return setError('Pick the estimate this one relates to.');
    setError(null);
    startTransition(async () => {
      const out = await linkToParent(estimateId, parentId, kind);
      if (out.kind === 'refused') return setError(out.error);
      setOpen(false);
      router.refresh();
    });
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !pending && setOpen(next)}>
      <DialogTrigger asChild>
        <Button type="button" variant="outline" full data-testid="open-link-lineage">
          <Link2 className="h-4 w-4" />
          Relate to another estimate
        </Button>
      </DialogTrigger>
      <DialogContent data-testid="link-lineage-dialog">
        <DialogTitle>Relate to another estimate</DialogTitle>
        <DialogDescription>
          Records that this estimate belongs with another — for work already on the platform that
          was estimated before either could be forked. <strong className="text-ink">Nothing is
          copied</strong>, and neither estimate changes.
        </DialogDescription>

        <div className="mt-4 space-y-4">
          <div>
            <FieldLabel htmlFor="link-parent">This estimate follows</FieldLabel>
            {/* `w-full` is load-bearing: a native <select> sizes itself to its
                WIDEST option, and these options are whole estimate titles. Left
                intrinsic, one long title pushes the control straight through the
                side of the dialog, which is `max-w-md`. The base Select sets no
                width on purpose — some are meant to size to their content — so
                it is the caller's job. */}
            <Select
              id="link-parent"
              className="w-full"
              value={parentId}
              onChange={(e) => setParentId(e.currentTarget.value)}
              disabled={pending}
              data-testid="link-parent"
            >
              <option value="">Choose an estimate…</option>
              {candidates.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.title}
                </option>
              ))}
            </Select>
          </div>

          <div>
            <FieldLabel htmlFor="link-kind">As a</FieldLabel>
            <Select
              id="link-kind"
              className="w-full"
              value={kind}
              onChange={(e) => setKind(e.currentTarget.value as Kind)}
              disabled={pending}
              data-testid="link-kind"
            >
              <option value="BRANCH">Branch — another route to the same outcome</option>
              <option value="SUCCESSOR">Successor — a later round of the same job</option>
            </Select>
          </div>

          {error && (
            <p className="text-[12px] text-brick" data-testid="link-error">
              {error}
            </p>
          )}

          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={pending}>
              Cancel
            </Button>
            <Button type="button" onClick={submit} disabled={pending} data-testid="submit-link">
              {pending ? 'Relating…' : 'Relate'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Break a link. Nothing about either estimate's contents changes.
 *
 * Needed for the same reason linking is: a relationship asserted by hand can be
 * asserted wrongly. A child that was genuinely forked keeps its carried marks —
 * they stay true of a document it no longer points at.
 */
export function UnlinkButton({ estimateId }: { estimateId: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <div>
      {/* Same shape as every other control in the Actions box — outline, full
          width. It read as an afterthought when it was a quiet extra-small
          button among full-width ones, which is not what breaking a lineage
          is. */}
      <Button
        type="button"
        variant="outline"
        full
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            const out = await unlinkFromParent(estimateId);
            if (out.kind === 'refused') return setError(out.error);
            router.refresh();
          })
        }
        data-testid="unlink-lineage"
      >
        <Unlink className="h-4 w-4" />
        {pending ? 'Unlinking…' : 'Unlink from parent'}
      </Button>
      {error && <p className="mt-1 text-[11.5px] text-brick">{error}</p>}
    </div>
  );
}
