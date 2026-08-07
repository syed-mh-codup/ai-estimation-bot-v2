import type { NextAuthConfig } from 'next-auth';

/**
 * Minimal auth config for middleware (edge runtime compatible, no DB imports).
 * Full auth config (with credentials provider + DB) lives in auth.ts.
 */
export const authConfig: NextAuthConfig = {
  // Derive the origin from each request's Host header instead of a hardcoded
  // AUTH_URL, so the same build works on any port (manual dev 3000, e2e 3001).
  trustHost: true,
  // Both are ours. Without `signOut`, next-auth renders its own built-in page
  // at /api/auth/signout — a dark unstyled card that looks like a different
  // product, reachable whenever anything GETs that URL.
  pages: { signIn: '/login', signOut: '/signout' },
  callbacks: {
    authorized({ auth, request: { nextUrl } }) {
      const isLoggedIn = !!auth?.user;
      const isPublic =
        nextUrl.pathname === '/login' ||
        nextUrl.pathname === '/api/health' ||
        nextUrl.pathname.startsWith('/api/auth') ||
        nextUrl.pathname.startsWith('/api/inngest');

      if (isPublic) return true;
      if (!isLoggedIn) return false;
      return true;
    },
    jwt({ token, user }) {
      if (user) {
        token['role'] = (user as { role: string }).role;
        token['id'] = user.id;
      }
      return token;
    },
    session({ session, token }) {
      if (session.user) {
        (session.user as { role: string; id: string }).role = token['role'] as string;
        (session.user as { id: string }).id = token['id'] as string;
      }
      return session;
    },
  },
  providers: [],
};
