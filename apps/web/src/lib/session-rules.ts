/**
 * Whether a live session may continue.
 *
 * Extracted so it can be tested directly rather than through next-auth's
 * plumbing — and so the test can't drift from the rule the app actually applies.
 * Used by the DB-backed `jwt` callback in auth.ts.
 *
 * Why the callback is the only place this can live: `session: { strategy: 'jwt' }`
 * means there is no session table to revoke. Refusing inside `authorize()` stops
 * NEW sign-ins while an already-signed-in user keeps working until their token
 * expires. The callback re-reads the user on every request, so returning false
 * here is what actually ends a session that is already in flight.
 */
export type SessionUserState = {
  disabledAt: Date | null;
  passwordChangedAt: Date | null;
};

export function sessionSurvives(
  token: { id?: unknown; issuedAt?: unknown },
  dbUser: SessionUserState | null,
): boolean {
  // No identity on the token yet (first pass, right after sign-in).
  if (!token.id) return true;

  // The account was deleted underneath a live session.
  if (!dbUser) return false;

  if (dbUser.disabledAt) return false;

  // A password change signs the account's other devices out. Tokens minted
  // before this feature existed carry no stamp; treating them as issued at 0
  // fails closed, which is right — we can't prove they post-date the change.
  const issuedAt = typeof token.issuedAt === 'number' ? token.issuedAt : 0;
  if (dbUser.passwordChangedAt && dbUser.passwordChangedAt.getTime() > issuedAt) return false;

  return true;
}
