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
          <NavLink href="/admin/prompts" testId="nav-admin-prompts">
            Prompts
          </NavLink>
          <NavLink href="/admin/mcp" testId="nav-admin-mcp">
            MCP
          </NavLink>
        </nav>
      )}

      <div className="mt-auto border-t border-line px-2 pt-3 max-md:mt-0 max-md:ml-auto max-md:border-0 max-md:pt-0">
        <div className="text-xs break-words text-ink-2 max-md:hidden">{session.user.email}</div>
        <div className="mt-0.5 text-[10.5px] text-ink-3 max-md:hidden">
          {session.user.role === 'ADMIN' ? 'Admin' : 'Estimator'}
        </div>
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
    </aside>
  );
}
