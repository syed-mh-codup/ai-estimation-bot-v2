import NextAuth, { type NextAuthResult } from 'next-auth';
import { authConfig } from '@/lib/auth.config';

// Annotated, not inferred — see the note in lib/auth.ts (pnpm + next-auth v5
// produce a non-portable inferred type that breaks the production build).
export const middleware: NextAuthResult['auth'] = NextAuth(authConfig).auth;
export default middleware;

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
