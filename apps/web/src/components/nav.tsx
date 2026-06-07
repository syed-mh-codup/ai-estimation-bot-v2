import { auth } from '@/lib/auth';
import { signOut } from '@/lib/auth';
import Link from 'next/link';

export async function Nav() {
  const session = await auth();

  if (!session?.user) return null;

  const isAdmin = session.user.role === 'ADMIN';

  return (
    <nav
      className="flex items-center justify-between border-b border-gray-200 bg-white px-6 py-3"
      data-testid="nav"
    >
      <div className="flex items-center gap-6">
        <Link href="/dashboard" className="text-lg font-semibold text-gray-900">
          AI Estimation
        </Link>
        <Link
          href="/dashboard"
          className="text-sm text-gray-600 hover:text-gray-900"
          data-testid="nav-estimates"
        >
          Estimates
        </Link>
        {isAdmin && (
          <>
            <Link
              href="/admin/users"
              className="text-sm text-gray-600 hover:text-gray-900"
              data-testid="nav-admin-users"
            >
              Users
            </Link>
            <Link
              href="/admin/config"
              className="text-sm text-gray-600 hover:text-gray-900"
              data-testid="nav-admin-config"
            >
              Config
            </Link>
            <Link
              href="/admin/presets"
              className="text-sm text-gray-600 hover:text-gray-900"
              data-testid="nav-admin-presets"
            >
              Presets
            </Link>
            <Link
              href="/admin/prompts"
              className="text-sm text-gray-600 hover:text-gray-900"
              data-testid="nav-admin-prompts"
            >
              Prompts
            </Link>
            <Link
              href="/admin/mcp"
              className="text-sm text-gray-600 hover:text-gray-900"
              data-testid="nav-admin-mcp"
            >
              MCP
            </Link>
          </>
        )}
      </div>
      <div className="flex items-center gap-4">
        <span className="text-sm text-gray-500">
          {session.user.email} ({session.user.role})
        </span>
        <form
          action={async () => {
            'use server';
            await signOut({ redirectTo: '/login' });
          }}
        >
          <button
            type="submit"
            className="text-sm text-gray-600 hover:text-gray-900"
            data-testid="nav-signout"
          >
            Sign out
          </button>
        </form>
      </div>
    </nav>
  );
}
