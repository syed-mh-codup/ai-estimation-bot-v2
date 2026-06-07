import { describe, it, expect } from 'vitest';
import { hashPassword, verifyPassword } from './password.js';
import { AuthError } from './errors.js';

// ─── WS2-01: Password hashing + credential verification ───────────────────────

describe('WS2-01: password hashing', () => {
  it('hashes a password and verifies it', async () => {
    const hash = await hashPassword('s3cr3t!');
    expect(hash).not.toBe('s3cr3t!');
    expect(await verifyPassword('s3cr3t!', hash)).toBe(true);
  });

  it('rejects wrong password', async () => {
    const hash = await hashPassword('correct');
    expect(await verifyPassword('wrong', hash)).toBe(false);
  });

  it('rejects empty password', async () => {
    const hash = await hashPassword('real');
    expect(await verifyPassword('', hash)).toBe(false);
  });
});

// ─── WS2-02: AuthError shape ──────────────────────────────────────────────────

describe('WS2-02: AuthError', () => {
  it('carries status 403 for role mismatch', () => {
    const err = new AuthError(403, 'Requires role ADMIN; got ESTIMATOR');
    expect(err.status).toBe(403);
    expect(err.message).toContain('ADMIN');
  });

  it('carries status 401 for missing session', () => {
    const err = new AuthError(401, 'Not authenticated');
    expect(err.status).toBe(401);
  });
});
