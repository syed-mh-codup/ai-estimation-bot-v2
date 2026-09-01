import { auth } from '@/lib/auth';
import { signOut } from '@/lib/auth';
import Link from 'next/link';
import { NavLink } from './nav-link';

/**
 * The app shell: a quiet putty rail rather than a top bar. A tool you sit in
 * all day should spend its vertical space on the document, and estimates are
 * tall. Admin is grouped separately because it is a different job.
 *
 * Collapses to a horizontal scrolling strip below md.
 */
export async function Nav() {
  const session = await auth();

  if (!session?.user) return null;

  const isAdmin = session.user.role === 'ADMIN';

  return (
    <aside
      className="flex shrink-0 flex-col gap-7 border-line bg-shell px-3.5 py-5 max-md:w-full max-md:flex-row max-md:items-center max-md:gap-4 max-md:overflow-x-auto max-md:border-b max-md:py-3 md:w-[216px] md:border-r"
      data-testid="nav"
    >
      <Link href="/dashboard" className="flex items-baseline gap-2 px-2">
        <span className="font-serif text-[19px] font-semibold tracking-[-0.01em] whitespace-nowrap text-ink">
          Estimation
        </span>
        <span className="text-[10.5px] tracking-[0.04em] text-ink-3 max-md:hidden">codup</span>
      </Link>

      <nav className="flex flex-col gap-0.5 max-md:flex-row max-md:items-center">
        <div className="eyebrow px-2 pb-1.5 max-md:hidden">Workspace</div>
        <NavLink href="/dashboard" testId="nav-estimates">
          Estimates
        </NavLink>
        <NavLink href="/estimates/new" testId="nav-new-estimate">
          New estimate
        </NavLink>
      </nav>

      {isAdmin && (
        <nav className="flex flex-col gap-0.5 max-md:flex-row max-md:items-center">
          <div className="eyebrow px-2 pb-1.5 max-md:hidden">Admin</div>
          <NavLink href="/admin/users" testId="nav-admin-users">
            Users
          </NavLink>
          <NavLink href="/admin/config" testId="nav-admin-config">
            Config
          </NavLink>
          <NavLink href="/admin/presets" testId="nav-admin-presets">
            Presets
          </NavLink>
          <NavLink href="/admin/taxonomy" testId="nav-admin-taxonomy">
            Taxonomy
          </NavLink>
          <NavLink href="/admin/prompts" testId="nav-admin-prompts">
            Prompts
          </NavLink>
          <NavLink href="/admin/oracle" testId="nav-admin-oracle">
            Oracle
          </NavLink>
          <NavLink href="/admin/usage" testId="nav-admin-usage">
            Usage
          </NavLink>
          <NavLink href="/admin/mcp" testId="nav-admin-mcp">
            MCP
          </NavLink>
          <NavLink href="/admin/changelog" testId="nav-admin-changelog">
            Changelog
          </NavLink>
        </nav>
      )}

      {/* Who you are, and the one page where you can change it. The name is
          read from the session, which the DB-backed jwt callback refreshes
          every request — so renaming yourself shows up on the next load. */}
      <div className="mt-auto border-t border-line px-2 pt-3 max-md:mt-0 max-md:ml-auto max-md:border-0 max-md:pt-0">
        <Link
          href="/profile"
          className="block max-md:hidden"
          data-testid="nav-profile"
        >
          {session.user.name && (
            <div className="text-xs font-semibold break-words text-ink hover:text-green" data-testid="nav-user-name">
              {session.user.name}
            </div>
          )}
          {/* Don't print the same string twice when someone's display name is
              their email address (which is what the seeds do). */}
          {session.user.name !== session.user.email && (
            <div className="text-xs break-words text-ink-2 hover:text-green">
              {session.user.email}
            </div>
          )}
          <div className="mt-0.5 text-[10.5px] text-ink-3">
            {session.user.role === 'ADMIN' ? 'Admin' : 'Estimator'}
          </div>
        </Link>

        <div className="flex items-center gap-3 max-md:gap-2.5">
          {/* The identity block above is the desktop way in; the collapsed
              strip has no room for it, so mobile gets a plain link. */}
          <Link
            href="/profile"
            className="mt-1.5 whitespace-nowrap text-xs text-ink-3 underline underline-offset-2 hover:text-ink max-md:mt-0 md:hidden"
            data-testid="nav-profile-compact"
          >
            Account
          </Link>
          <form
            action={async () => {
              'use server';
              await signOut({ redirectTo: '/login' });
            }}
          >
            <button
              type="submit"
              className="mt-1.5 whitespace-nowrap text-xs text-ink-3 underline underline-offset-2 hover:text-ink max-md:mt-0"
              data-testid="nav-signout"
            >
              Sign out
            </button>
          </form>
        </div>
      </div>
    </aside>
  );
}
