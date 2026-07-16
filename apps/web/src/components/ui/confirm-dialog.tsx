'use client';

import { useState, type ReactNode } from 'react';
import { Dialog, DialogTrigger, DialogContent, DialogTitle, DialogDescription } from './dialog';

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
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="rounded-md border border-gray-300 px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50"
            data-testid="confirm-cancel"
          >
            Cancel
          </button>
          <form action={action}>
            {Object.entries(hidden).map(([k, v]) => (
              <input key={k} type="hidden" name={k} value={v} />
            ))}
            <button
              type="submit"
              className="rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700"
              data-testid="confirm-submit"
            >
              {confirmLabel}
            </button>
          </form>
        </div>
      </DialogContent>
    </Dialog>
  );
}
