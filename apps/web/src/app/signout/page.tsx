import { redirect } from 'next/navigation';
import { auth, signOut } from '@/lib/auth';
import { Eyebrow } from '@/components/ui/card';
import { SignOutActions } from './SignOutActions';

/**
 * Sign out, in the app's own voice.
 *
 * Replaces next-auth's built-in page (a dark, unstyled card asking "Are you
 * sure you want to sign out?"), which looked like a different product bolted
 * onto this one. Registered via `pages.signOut` in auth.config.ts.
 *
 * Deliberately mirrors /login — the same wordmark, paper card and measure —
 * because signing in and signing out are two states of one threshold and
 * should read that way.
 *
 * The substantive change is what it asks. "Are you sure?" is a question
 * without content. In a shared ledger where every estimate is owned by a
 * named person, and where people share machines, the question worth
 * answering is *which account* you're about to drop — so the card leads with
 * that.
 */
export default async function SignOutPage() {
  const session = await auth();
  // Nothing to sign out of — middleware normally catches this first.
  if (!session?.user) redirect('/login');

  const { name, email } = session.user;

  async function confirmSignOut() {
    'use server';
    await signOut({ redirectTo: '/login' });
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-canvas px-5 py-10">
      <div className="w-full max-w-[380px]">
        <div className="text-center">
          <h1 className="font-serif text-[30px] leading-tight font-medium tracking-[-0.015em] text-ink">
            AI Estimation
          </h1>
        </div>

        <div className="mt-6 rounded-[10px] border border-line bg-surface p-6 sm:p-7">
          <Eyebrow>Signed in as</Eyebrow>
          {/* Name above address when there is one, matching the sidebar's
              identity block — the same two facts in the same order. */}
          <div className="mt-2">
            {name && name !== email && (
              <div className="text-[15px] font-semibold break-words text-ink" data-testid="signout-name">
                {name}
              </div>
            )}
            <div className="text-[13px] break-words text-ink-2" data-testid="signout-email">
              {email}
            </div>
          </div>

          <p className="mt-4 border-t border-line-soft pt-4 text-[12.5px] leading-relaxed text-ink-3">
            Signing out ends this session on this device. Your estimates and any
            unsaved edits already written to the ledger stay exactly as they are.
          </p>

          <form action={confirmSignOut}>
            <SignOutActions />
          </form>
        </div>

        <p className="mt-5 text-center text-[11.5px] text-ink-4">
          Codup · internal estimation ledger
        </p>
      </div>
    </main>
  );
}
