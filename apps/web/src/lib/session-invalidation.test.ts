import { describe, it, expect } from 'vitest';
import { sessionSurvives } from './session-rules';

/**
 * With `session: { strategy: 'jwt' }` there is NO session table to revoke, so
 * the only place a live session can be ended is the DB-backed jwt callback,
 * which re-reads the user on every request. These tests pin the two decisions
 * that callback makes. The rule is imported from session-rules, not restated
 * here, so these can't pass while auth.ts diverges.
 *
 * Blocking `authorize()` is not enough on its own: it stops new sign-ins while
 * an already-signed-in user keeps working until their token expires.
 */

const T0 = 1_000_000;
const active = { disabledAt: null, passwordChangedAt: null };

describe('live session invalidation', () => {
  it('keeps an ordinary session alive', () => {
    expect(sessionSurvives({ id: 'u1', issuedAt: T0 }, active)).toBe(true);
  });

  it('ends the session of a disabled account, not just its next login', () => {
    expect(
      sessionSurvives({ id: 'u1', issuedAt: T0 }, { ...active, disabledAt: new Date(T0 + 5) }),
    ).toBe(false);
  });

  it('ends a session whose account was deleted underneath it', () => {
    expect(sessionSurvives({ id: 'u1', issuedAt: T0 }, null)).toBe(false);
  });

  it('ends sessions issued BEFORE a password change', () => {
    expect(
      sessionSurvives(
        { id: 'u1', issuedAt: T0 },
        { ...active, passwordChangedAt: new Date(T0 + 1) },
      ),
    ).toBe(false);
  });

  it('keeps sessions issued AFTER a password change — signing back in works', () => {
    // Otherwise the user could never get back in: they'd change the password,
    // sign in with the new one, and be ejected again immediately.
    expect(
      sessionSurvives(
        { id: 'u1', issuedAt: T0 + 10 },
        { ...active, passwordChangedAt: new Date(T0) },
      ),
    ).toBe(true);
  });

  it('treats a token with no issuedAt as pre-dating any password change', () => {
    // Tokens minted before this feature existed carry no stamp. Failing closed
    // is right: we cannot prove they were issued after the change.
    expect(sessionSurvives({ id: 'u1' }, { ...active, passwordChangedAt: new Date(T0) })).toBe(
      false,
    );
  });

  it('leaves such a token alone when the password never changed', () => {
    expect(sessionSurvives({ id: 'u1' }, active)).toBe(true);
  });

  it('disable wins over a matching password timestamp', () => {
    expect(
      sessionSurvives(
        { id: 'u1', issuedAt: T0 + 100 },
        { disabledAt: new Date(T0), passwordChangedAt: new Date(T0) },
      ),
    ).toBe(false);
  });
});
