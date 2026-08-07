import { describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword, MIN_PASSWORD_LENGTH } from './password';

/**
 * The change-password flow rests on `verifyPassword` correctly rejecting a
 * wrong current password: an admin-set temporary password is exactly the case
 * where re-authentication matters, since anyone at an unlocked screen could
 * otherwise lock the real owner out.
 */
describe('password helpers', () => {
  it('a hash verifies against its own plaintext and nothing else', async () => {
    const hash = await hashPassword('correct-horse-battery');
    expect(await verifyPassword('correct-horse-battery', hash)).toBe(true);
    expect(await verifyPassword('Correct-horse-battery', hash)).toBe(false);
    expect(await verifyPassword('', hash)).toBe(false);
  });

  it('re-hashing the same password yields a different hash (salted)', async () => {
    const a = await hashPassword('same-password');
    const b = await hashPassword('same-password');
    expect(a).not.toBe(b);
    expect(await verifyPassword('same-password', b)).toBe(true);
  });

  it('exposes one shared minimum length for admin-set and self-set passwords', () => {
    // A user must not be able to weaken their password below the rule the
    // admin dialog enforces, so both read this constant.
    expect(MIN_PASSWORD_LENGTH).toBeGreaterThanOrEqual(8);
  });
});
