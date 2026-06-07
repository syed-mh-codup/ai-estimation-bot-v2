import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AuthError } from './errors.js';

// ─── WS2-02: requireRole guard ────────────────────────────────────────────────
// We test the guard logic by mocking the `auth()` function dependency.

vi.mock('./auth.js', () => ({
  auth: vi.fn(),
}));

import { auth } from './auth.js';
import { requireRole } from './rbac.js';

const mockAuth = auth as ReturnType<typeof vi.fn>;

beforeEach(() => vi.clearAllMocks());

describe('WS2-02: requireRole server-side guard', () => {
  it('allows ADMIN to access admin route', async () => {
    mockAuth.mockResolvedValue({ user: { id: 'u1', role: 'ADMIN' } });
    const result = await requireRole('ADMIN');
    expect(result.role).toBe('ADMIN');
  });

  it('throws 403 when ESTIMATOR accesses admin-only route', async () => {
    mockAuth.mockResolvedValue({ user: { id: 'u2', role: 'ESTIMATOR' } });
    await expect(requireRole('ADMIN')).rejects.toThrow(AuthError);
    try {
      await requireRole('ADMIN');
    } catch (err) {
      expect((err as AuthError).status).toBe(403);
    }
  });

  it('throws 401 when unauthenticated', async () => {
    mockAuth.mockResolvedValue(null);
    await expect(requireRole('ESTIMATOR')).rejects.toThrow(AuthError);
    try {
      await requireRole('ESTIMATOR');
    } catch (err) {
      expect((err as AuthError).status).toBe(401);
    }
  });

  it('allows ESTIMATOR to access estimator route', async () => {
    mockAuth.mockResolvedValue({ user: { id: 'u3', role: 'ESTIMATOR' } });
    const result = await requireRole('ESTIMATOR');
    expect(result.role).toBe('ESTIMATOR');
  });
});
