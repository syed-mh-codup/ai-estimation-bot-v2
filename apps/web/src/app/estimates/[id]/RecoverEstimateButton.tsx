'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Undo2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { recoverEstimate } from './delete-actions';

/**
 * Put a deleted estimate back. AEH-375.
 *
 * Shared by the two places recovery is offered: the deleted estimate's own
 * page, which is the route an owner has, and `/admin/trash`, which is the
 * discoverable list an admin has. One component because the refusals are the
 * same in both — the action decides, not the screen.
 *
 * No confirm dialog. Recovery is not destructive, and the one thing this
 * feature exists to fix is a confirm dialog being the only thing between
 * somebody and a week of lost work; putting another one in the way back would
 * be a poor joke.
 *
 * `router.refresh()` rather than a redirect: on the estimate page it turns the
 * notice into the restored estimate in place, and on the trash list it drops
 * the row. Neither screen has to know which one it is.
 */
export function RecoverEstimateButton({
  estimateId,
  label = 'Recover this estimate',
  size = 'default',
  variant = 'default',
}: {
  estimateId: string;
  label?: string;
  size?: 'default' | 'sm' | 'xs';
  /**
   * `outline` down a table of rows, solid on the estimate's own page. The
   * notice has one thing to offer and should look like it; a list of them
   * repeating the page's primary green reads as ten primary actions.
   */
  variant?: 'default' | 'outline';
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const submit = (): void => {
    setError(null);
    startTransition(async () => {
      const out = await recoverEstimate(estimateId);
      if (out.kind === 'refused') return setError(out.error);
      router.refresh();
    });
  };

  return (
    <div>
      <Button
        type="button"
        size={size}
        variant={variant}
        onClick={submit}
        disabled={pending}
        data-testid={`recover-estimate-${estimateId}`}
      >
        <Undo2 className="h-4 w-4" />
        {pending ? 'Recovering…' : label}
      </Button>
      {error ? (
        <p className="mt-2 text-[12.5px] text-brick" data-testid="recover-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
