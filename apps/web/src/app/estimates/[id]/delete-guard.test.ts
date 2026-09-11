import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Who may delete an estimate, who may recover one, and what deleting now does.
 *
 * `deleteEstimate` used to require only a session, which meant any signed-in
 * user could destroy any estimate (cascading its sections, menu items and line
 * items). Editing stays open — the dashboard shows every estimate to everyone
 * and that shared ledger is the point — but deletion needs the owner or an
 * admin. These tests pin that distinction.
 *
 * AEH-375 changed what deletion IS without changing who may do it: the row is
 * stamped, not removed. The assertions below moved from "called delete" to
 * "stamped `deletedAt` and recorded who", which is the whole substance of the
 * change — a guard that still passes while the estimate is being hard-deleted
 * would be the worst possible outcome of this ticket.
 */

vi.mock('@/lib/auth', () => ({ auth: vi.fn() }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const findUnique = vi.fn();
const updateMany = vi.fn();
const update = vi.fn();
const del = vi.fn();
vi.mock('@repo/db', () => ({
  prisma: {
    estimate: {
      findUnique: (...a: unknown[]) => findUnique(...a),
      updateMany: (...a: unknown[]) => updateMany(...a),
      update: (...a: unknown[]) => update(...a),
      delete: (...a: unknown[]) => del(...a),
    },
  },
}));

import { auth } from '@/lib/auth';
import { deleteEstimate, recoverEstimate } from './delete-actions';

const mockAuth = auth as unknown as ReturnType<typeof vi.fn>;

const OWNER = 'user-owner';
const OTHER = 'user-other';
const ESTIMATE = 'est-1';
const DELETED_AT = new Date('2026-09-01T10:00:00Z');

beforeEach(() => {
  vi.clearAllMocks();
  findUnique.mockResolvedValue({ ownerId: OWNER });
  updateMany.mockResolvedValue({ count: 1 });
  update.mockResolvedValue({});
});

describe('deleteEstimate authorization', () => {
  it('lets the owner delete their own estimate', async () => {
    mockAuth.mockResolvedValue({ user: { id: OWNER, role: 'ESTIMATOR' } });
    await deleteEstimate(ESTIMATE);
    expect(updateMany).toHaveBeenCalledTimes(1);
  });

  it('lets an admin delete anyone’s estimate', async () => {
    mockAuth.mockResolvedValue({ user: { id: OTHER, role: 'ADMIN' } });
    await deleteEstimate(ESTIMATE);
    expect(updateMany).toHaveBeenCalledTimes(1);
  });

  it('refuses a signed-in non-owner, and deletes nothing', async () => {
    mockAuth.mockResolvedValue({ user: { id: OTHER, role: 'ESTIMATOR' } });
    await expect(deleteEstimate(ESTIMATE)).rejects.toThrow(/owner or an admin/);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('refuses an unauthenticated caller, and deletes nothing', async () => {
    mockAuth.mockResolvedValue(null);
    await expect(deleteEstimate(ESTIMATE)).rejects.toThrow(/Not authenticated/);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('refuses a missing estimate rather than falling through to delete', async () => {
    mockAuth.mockResolvedValue({ user: { id: OWNER, role: 'ESTIMATOR' } });
    findUnique.mockResolvedValue(null);
    await expect(deleteEstimate(ESTIMATE)).rejects.toThrow(/not found/i);
    expect(updateMany).not.toHaveBeenCalled();
  });
});

describe('deleteEstimate destroys nothing — AEH-375', () => {
  beforeEach(() => mockAuth.mockResolvedValue({ user: { id: OWNER, role: 'ESTIMATOR' } }));

  it('never calls prisma delete', async () => {
    await deleteEstimate(ESTIMATE);
    // The point of the whole ticket. A cascade here takes sections, cards,
    // line items, statements, locks, artifacts and exports with it.
    expect(del).not.toHaveBeenCalled();
  });

  it('stamps deletedAt and records who did it', async () => {
    await deleteEstimate(ESTIMATE);
    const [args] = updateMany.mock.calls[0] as [
      { where: Record<string, unknown>; data: Record<string, unknown> },
    ];
    expect(args.where).toMatchObject({ id: ESTIMATE });
    expect(args.data['deletedAt']).toBeInstanceOf(Date);
    expect(args.data['deletedById']).toBe(OWNER);
  });

  it('an admin deleting somebody else’s estimate is recorded as the admin', async () => {
    mockAuth.mockResolvedValue({ user: { id: OTHER, role: 'ADMIN' } });
    await deleteEstimate(ESTIMATE);
    const [args] = updateMany.mock.calls[0] as [{ data: Record<string, unknown> }];
    // Not the owner: the trash list has to name whoever actually did it.
    expect(args.data['deletedById']).toBe(OTHER);
  });

  it('will not overwrite an existing stamp', async () => {
    await deleteEstimate(ESTIMATE);
    const [args] = updateMany.mock.calls[0] as [{ where: Record<string, unknown> }];
    // Two people pressing Delete at once must not leave the row attributed to
    // whoever lost the race.
    expect(args.where['deletedAt']).toBeNull();
  });
});

describe('recoverEstimate', () => {
  beforeEach(() => findUnique.mockResolvedValue({ ownerId: OWNER, deletedAt: DELETED_AT }));

  it('lets the owner recover their own estimate', async () => {
    mockAuth.mockResolvedValue({ user: { id: OWNER, role: 'ESTIMATOR' } });
    await expect(recoverEstimate(ESTIMATE)).resolves.toEqual({ kind: 'ok' });
    expect(update).toHaveBeenCalledWith({
      where: { id: ESTIMATE },
      data: { deletedAt: null, deletedById: null },
    });
  });

  it('lets an admin recover anyone’s estimate', async () => {
    mockAuth.mockResolvedValue({ user: { id: OTHER, role: 'ADMIN' } });
    await expect(recoverEstimate(ESTIMATE)).resolves.toEqual({ kind: 'ok' });
  });

  it('refuses a signed-in non-owner, and recovers nothing', async () => {
    mockAuth.mockResolvedValue({ user: { id: OTHER, role: 'ESTIMATOR' } });
    const out = await recoverEstimate(ESTIMATE);
    expect(out).toEqual({ kind: 'refused', error: expect.stringMatching(/owner or an admin/) });
    expect(update).not.toHaveBeenCalled();
  });

  it('refuses rather than throwing, so the message survives production', async () => {
    // A thrown message reads fine under `next dev` and becomes React
    // boilerplate once deployed, which is why every refusal here is a value.
    mockAuth.mockResolvedValue({ user: { id: OTHER, role: 'ESTIMATOR' } });
    await expect(recoverEstimate(ESTIMATE)).resolves.toMatchObject({ kind: 'refused' });
  });

  it('says so when the estimate was never deleted', async () => {
    mockAuth.mockResolvedValue({ user: { id: OWNER, role: 'ESTIMATOR' } });
    findUnique.mockResolvedValue({ ownerId: OWNER, deletedAt: null });
    const out = await recoverEstimate(ESTIMATE);
    expect(out).toEqual({ kind: 'refused', error: expect.stringMatching(/already live/) });
    expect(update).not.toHaveBeenCalled();
  });

  it('says so when the row is gone for good', async () => {
    mockAuth.mockResolvedValue({ user: { id: OWNER, role: 'ESTIMATOR' } });
    findUnique.mockResolvedValue(null);
    const out = await recoverEstimate(ESTIMATE);
    expect(out).toMatchObject({ kind: 'refused' });
    expect(update).not.toHaveBeenCalled();
  });

  it('checks permission before reporting whether it is deleted', async () => {
    // Ordering matters: a stranger should not learn an estimate's state from
    // which refusal they get back.
    mockAuth.mockResolvedValue({ user: { id: OTHER, role: 'ESTIMATOR' } });
    findUnique.mockResolvedValue({ ownerId: OWNER, deletedAt: null });
    const out = await recoverEstimate(ESTIMATE);
    expect(out).toEqual({ kind: 'refused', error: expect.stringMatching(/owner or an admin/) });
  });

  it('refuses an unauthenticated caller', async () => {
    mockAuth.mockResolvedValue(null);
    await expect(recoverEstimate(ESTIMATE)).rejects.toThrow(/Not authenticated/);
    expect(update).not.toHaveBeenCalled();
  });
});
