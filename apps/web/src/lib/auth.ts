import NextAuth, { type NextAuthResult } from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import { prisma } from '@repo/db';
import { verifyPassword } from './password';
import type { Role } from '@repo/db';
import { authConfig } from './auth.config';
import { sessionSurvives } from './session-rules';

declare module 'next-auth' {
  interface User {
    role: Role;
  }
  interface Session {
    user: {
      id: string;
      email: string;
      name?: string | null;
      role: Role;
    };
  }
}

// The exports are annotated via NextAuthResult rather than inferred: under
// pnpm's symlinked node_modules TS can't name the inferred type without an
// absolute path into next-auth's internals ("not portable"), which fails the
// production build. Annotating pins the public type. See auth.js#9493.
const nextAuth = NextAuth({
  ...authConfig,
  providers: [
    Credentials({
      name: 'credentials',
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' },
      },
      async authorize(credentials) {
        if (!credentials?.email || !credentials?.password) return null;

        const user = await prisma.user.findUnique({
          where: { email: credentials.email as string },
        });

        if (!user) return null;
        // Blocks NEW logins. Ending sessions already in flight is the jwt
        // callback's job below — see the comment there.
        if (user.disabledAt) return null;

        const valid = await verifyPassword(credentials.password as string, user.hash);
        if (!valid) return null;

        return { id: user.id, email: user.email, name: user.name ?? null, role: user.role };
      },
    }),
  ],
  session: { strategy: 'jwt' },
  callbacks: {
    ...authConfig.callbacks,
    // Override the lightweight (edge) jwt callback with a DB-backed one. This
    // runs in the Node runtime (prisma available; middleware keeps using the
    // edge config). Re-reading the user on every request makes changes take
    // effect live — an admin promoting/demoting someone, or a user renaming
    // themselves on /profile — without requiring a log out and back in.
    //
    // `name` rides the standard JWT claim, which Auth.js copies onto
    // session.user before the session callback runs, so it needs no mapping in
    // auth.config's session callback the way the custom `role`/`id` do.
    async jwt({ token, user }) {
      if (user) {
        token['role'] = (user as { role: Role }).role;
        token['id'] = user.id;
        token['name'] = user.name ?? null;
        // Stamped so a later password change can invalidate this token: any
        // token issued before passwordChangedAt is no longer trusted.
        token['issuedAt'] = Date.now();
        return token;
      }
      if (token['id']) {
        const dbUser = await prisma.user.findUnique({
          where: { id: token['id'] as string },
          select: { role: true, name: true, disabledAt: true, passwordChangedAt: true },
        });

        // Gone, disabled, or the password changed after this token was issued.
        // Returning null invalidates the session — see sessionSurvives for why
        // this callback is the only place that can end a live one.
        if (!sessionSurvives({ id: token['id'], issuedAt: token['issuedAt'] }, dbUser)) {
          return null;
        }
        // Narrowing for TS: sessionSurvives already rejected the null case.
        if (!dbUser) return null;

        token['role'] = dbUser.role;
        token['name'] = dbUser.name;
      }
      return token;
    },
  },
});

export const handlers: NextAuthResult['handlers'] = nextAuth.handlers;
export const auth: NextAuthResult['auth'] = nextAuth.auth;
export const signIn: NextAuthResult['signIn'] = nextAuth.signIn;
export const signOut: NextAuthResult['signOut'] = nextAuth.signOut;
