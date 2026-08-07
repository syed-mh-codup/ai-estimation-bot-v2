import { auth } from './auth';
import type { Role } from '@repo/db';
import { NextResponse } from 'next/server';
import { AuthError } from './errors';

export { AuthError };

export type SessionUser = { id: string; role: Role };

/**
 * Any authenticated user, plus who they are. `requireRole` answers "may they?";
 * this answers "who is asking?" — needed by ownership checks, which can't be
 * expressed as a role.
 */
export async function requireUser(): Promise<SessionUser> {
  const session = await auth();
  if (!session?.user) {
    throw new AuthError(401, 'Not authenticated');
  }
  return { id: session.user.id, role: session.user.role };
}

/**
 * Server-side role guard. Throws AuthError(401) if not authenticated,
 * AuthError(403) if authenticated but wrong role.
 */
export async function requireRole(required: Role): Promise<{ id: string; role: Role }> {
  const user = await requireUser();
  if (user.role !== required) {
    throw new AuthError(403, `Requires role ${required}; got ${user.role}`);
  }
  return user;
}

/** Convenience: require ADMIN role. */
export async function requireAdmin() {
  return requireRole('ADMIN');
}

/**
 * Wrap an API route handler with role enforcement.
 * Returns 401/403 JSON response on auth failure.
 */
export function withRole(required: Role, handler: (req: Request) => Promise<Response>) {
  return async (req: Request): Promise<Response> => {
    try {
      await requireRole(required);
      return handler(req);
    } catch (err) {
      if (err instanceof AuthError) {
        return NextResponse.json({ error: err.message }, { status: err.status });
      }
      throw err;
    }
  };
}
