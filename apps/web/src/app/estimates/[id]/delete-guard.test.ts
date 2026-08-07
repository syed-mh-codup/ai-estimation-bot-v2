import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * `deleteEstimate` used to require only a session, which meant any signed-in
 * user could destroy any estimate (cascading its sections, menu items and line
 * items). Editing stays open — the dashboard shows every estimate to everyone
 * and that shared ledger is the point — but deletion needs the owner or an
 * admin. These tests pin that distinction.
 */

vi.mock('@/lib/auth', () => ({ auth: vi.fn() }));

const findUnique = vi.fn();
const del = vi.fn();
vi.mock('@repo/db', () => ({
  prisma: { estimate: { findUnique: (...a: unknown[]) => findUnique(...a), delete: (...a: unknown[]) => del(...a) } },
}));

import { auth } from '@/lib/auth';
import { deleteEstimate } from './actions';

const mockAuth = auth as unknown as ReturnType<typeof vi.fn>;

const OWNER = 'user-owner';
const OTHER = 'user-other';
const ESTIMATE = 'est-1';

beforeEach(() => {
  vi.clearAllMocks();
  findUnique.mockResolvedValue({ ownerId: OWNER });
  del.mockResolvedValue({});
});

describe('deleteEstimate authorization', () => {
  it('lets the owner delete their own estimate', async () => {
    mockAuth.mockResolvedValue({ user: { id: OWNER, role: 'ESTIMATOR' } });
    await deleteEstimate(ESTIMATE);
    expect(del).toHaveBeenCalledWith({ where: { id: ESTIMATE } });
  });

  it('lets an admin delete anyone’s estimate', async () => {
    mockAuth.mockResolvedValue({ user: { id: OTHER, role: 'ADMIN' } });
    await deleteEstimate(ESTIMATE);
    expect(del).toHaveBeenCalledWith({ where: { id: ESTIMATE } });
  });

  it('refuses a signed-in non-owner, and deletes nothing', async () => {
    mockAuth.mockResolvedValue({ user: { id: OTHER, role: 'ESTIMATOR' } });
    await expect(deleteEstimate(ESTIMATE)).rejects.toThrow(/owner or an admin/);
    expect(del).not.toHaveBeenCalled();
  });

  it('refuses an unauthenticated caller, and deletes nothing', async () => {
    mockAuth.mockResolvedValue(null);
    await expect(deleteEstimate(ESTIMATE)).rejects.toThrow(/Not authenticated/);
    expect(del).not.toHaveBeenCalled();
  });

  it('refuses a missing estimate rather than falling through to delete', async () => {
    mockAuth.mockResolvedValue({ user: { id: OWNER, role: 'ESTIMATOR' } });
    findUnique.mockResolvedValue(null);
    await expect(deleteEstimate(ESTIMATE)).rejects.toThrow(/not found/i);
    expect(del).not.toHaveBeenCalled();
  });
});
