'use client';

import { useState, type ReactNode } from 'react';
import { Dialog, DialogTrigger, DialogContent, DialogTitle, DialogDescription } from './dialog';
import { Button } from './button';

/**
 * Two-click confirmation for a destructive server action. The trigger you pass
 * opens the dialog; confirming submits a form bound to `action` (with optional
 * hidden fields), so the destructive work stays a real server action / mutation
 * — the dialog just gates it behind an explicit second click.
 */
export function ConfirmDialog({
  trigger,
  title,
  description,
  confirmLabel = 'Delete',
  action,
  hidden = {},
}: {
  trigger: ReactNode;
  title: string;
  description: ReactNode;
  confirmLabel?: string;
  action: (formData: FormData) => void | Promise<void>;
  hidden?: Record<string, string>;
}) {
  const [open, setOpen] = useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent data-testid="confirm-dialog">
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{description}</DialogDescription>
        <div className="mt-5 flex justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setOpen(false)}
            data-testid="confirm-cancel"
          >
            Cancel
          </Button>
          <form action={action}>
            {Object.entries(hidden).map(([k, v]) => (
              <input key={k} type="hidden" name={k} value={v} />
            ))}
            <Button type="submit" variant="destructive" size="sm" data-testid="confirm-submit">
              {confirmLabel}
            </Button>
          </form>
        </div>
      </DialogContent>
    </Dialog>
  );
}
