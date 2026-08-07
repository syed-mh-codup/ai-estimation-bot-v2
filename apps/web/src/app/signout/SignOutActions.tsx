'use client';

import { useFormStatus } from 'react-dom';
import Link from 'next/link';
import { Button } from '@/components/ui/button';

/**
 * Split out purely so the submit button can read `useFormStatus` — the page
 * itself stays a server component so it can name the account being signed out
 * without shipping the session to the client.
 */
export function SignOutActions() {
  const { pending } = useFormStatus();

  return (
    <div className="mt-5 flex flex-col gap-2">
      <Button type="submit" size="lg" full disabled={pending} data-testid="confirm-signout">
        {pending ? 'Signing out…' : 'Sign out'}
      </Button>
      {/* The default page offers no way back. Landing here by mistake — a
          mis-click, a stale bookmark — shouldn't cost you your session. */}
      <Button asChild variant="outline" size="lg" full>
        <Link href="/dashboard" data-testid="cancel-signout">
          Stay signed in
        </Link>
      </Button>
    </div>
  );
}
