-- Disable an account without deleting it, and make a password change end other
-- sessions.
--
-- Both are read by the DB-backed jwt callback on every request, which is the
-- only hook that can end a LIVE session: `session: { strategy: 'jwt' }` means
-- there is no session table to revoke, so blocking authorize() would stop new
-- logins while leaving existing tokens working until they expired.
--
-- Nullable with no default, and deliberately not backfilled: every existing
-- account is active, and stamping passwordChangedAt now would invalidate every
-- signed-in session for no reason.
ALTER TABLE "User" ADD COLUMN "disabledAt" TIMESTAMP(3);
ALTER TABLE "User" ADD COLUMN "passwordChangedAt" TIMESTAMP(3);
