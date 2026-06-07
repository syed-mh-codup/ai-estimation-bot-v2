import type { NextAuthConfig } from 'next-auth';

/**
 * Minimal auth config for middleware (edge runtime compatible, no DB imports).
 * Full auth config (with credentials provider + DB) lives in auth.ts.
 */
export const authConfig: NextAuthConfig = {
  pages: { signIn: '/login' },
  callbacks: {
    authorized({ auth, request: { nextUrl } }) {
      const isLoggedIn = !!auth?.user;
      const isPublic =
        nextUrl.pathname === '/login' || nextUrl.pathname.startsWith('/api/auth');

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
