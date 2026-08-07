'use client';

import { useActionState, useEffect, useState } from 'react';
import { ArrowRightLeft } from 'lucide-react';
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Select, FieldLabel } from '@/components/ui/input';

export type ReassignState = { ok?: boolean; error?: string; moved?: number };

const initialState: ReassignState = {};

export type ReassignCandidate = { id: string; label: string };

/**
 * Move a user's estimates to someone else.
 *
 * Standalone on purpose — not buried inside the delete flow. The admin table's
 * tooltip used to say "reassign or remove them first" while no reassignment
 * existed anywhere in the codebase; and reassigning is a normal thing to want
 * when someone changes team, with nobody being deleted at all.
 */
export function ReassignDialog({
  action,
  fromUserId,
  fromLabel,
  count,
  candidates,
}: {
  action: (state: ReassignState, formData: FormData) => Promise<ReassignState>;
  fromUserId: string;
  fromLabel: string;
  count: number;
  candidates: ReassignCandidate[];
}) {
  const [state, formAction, pending] = useActionState(action, initialState);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (state.ok) setOpen(false);
  }, [state.ok]);

  const nobodyToMoveTo = candidates.length === 0;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size="xs"
          disabled={nobodyToMoveTo}
          title={nobodyToMoveTo ? 'No other account to move them to' : undefined}
          data-testid={`reassign-${fromUserId}`}
        >
          <ArrowRightLeft className="h-3 w-3" />
          Reassign
        </Button>
      </DialogTrigger>
      <DialogContent data-testid="reassign-form">
        <DialogTitle>Reassign estimates</DialogTitle>
        <DialogDescription>
          Move all {count} of {fromLabel}&rsquo;s estimates to another account. Nothing is deleted
          and the estimates themselves don&rsquo;t change.
        </DialogDescription>

        <form action={formAction} className="mt-4 space-y-3.5">
          <input type="hidden" name="fromUserId" value={fromUserId} />
          <div>
            <FieldLabel htmlFor={`to-${fromUserId}`}>New owner</FieldLabel>
            <Select
              id={`to-${fromUserId}`}
              name="toUserId"
              required
              className="w-full py-2"
              data-testid="reassign-to"
            >
              {candidates.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </Select>
          </div>

          {state.error && (
            <p
              className="rounded-md border border-brick-line bg-brick-tint px-3 py-2 text-[12.5px] font-medium text-brick"
              data-testid="reassign-error"
            >
              {state.error}
            </p>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending} data-testid="reassign-submit">
              {pending ? 'Moving…' : `Move ${count} estimate${count === 1 ? '' : 's'}`}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
