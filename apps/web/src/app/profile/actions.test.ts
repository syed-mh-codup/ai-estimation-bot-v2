import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Self-service account actions. The load-bearing rule is that changing a
 * password requires proving you know the current one — an admin-set temporary
 * password is exactly the case where that matters, since without it anyone at
 * an unlocked screen could lock the real owner out.
 */

vi.mock('@/lib/auth', () => ({ auth: vi.fn() }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const findUnique = vi.fn();
const update = vi.fn();
vi.mock('@repo/db', () => ({
  prisma: {
    user: {
      findUnique: (...a: unknown[]) => findUnique(...a),
      update: (...a: unknown[]) => update(...a),
    },
  },
}));

import { auth } from '@/lib/auth';
import { hashPassword } from '@/lib/password';
import { updateName, changePassword } from './actions';

const mockAuth = auth as unknown as ReturnType<typeof vi.fn>;
const ME = 'user-me';

const form = (fields: Record<string, string>): FormData => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
};

let currentHash = '';

beforeEach(async () => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({ user: { id: ME, role: 'ESTIMATOR' } });
  currentHash = await hashPassword('temp-password-from-admin');
  findUnique.mockResolvedValue({ hash: currentHash });
  update.mockResolvedValue({});
});

describe('updateName', () => {
  it('saves a trimmed name against the caller’s own id', async () => {
    const result = await updateName({}, form({ name: '  Alex Whitfield  ' }));
    expect(result).toEqual({ ok: true });
    expect(update).toHaveBeenCalledWith({
      where: { id: ME },
      data: { name: 'Alex Whitfield' },
    });
  });

  it('stores null rather than an empty string when cleared', async () => {
    await updateName({}, form({ name: '   ' }));
    expect(update).toHaveBeenCalledWith({ where: { id: ME }, data: { name: null } });
  });

  it('rejects an over-long name without writing', async () => {
    const result = await updateName({}, form({ name: 'x'.repeat(121) }));
    expect(result.error).toMatch(/120 characters/);
    expect(update).not.toHaveBeenCalled();
  });

  it('refuses an unauthenticated caller', async () => {
    mockAuth.mockResolvedValue(null);
    await expect(updateName({}, form({ name: 'Nobody' }))).rejects.toThrow(/Not authenticated/);
    expect(update).not.toHaveBeenCalled();
  });
});

describe('changePassword', () => {
  const good = {
    currentPassword: 'temp-password-from-admin',
    newPassword: 'a-much-better-one',
    confirmPassword: 'a-much-better-one',
  };

  it('re-hashes the caller’s password when the current one checks out', async () => {
    const result = await changePassword({}, form(good));
    expect(result).toEqual({ ok: true });

    expect(update).toHaveBeenCalledTimes(1);
    const arg = update.mock.calls[0]![0] as { where: { id: string }; data: { hash: string } };
    expect(arg.where).toEqual({ id: ME });
    // A real bcrypt hash of the new password, not the old one and not plaintext.
    expect(arg.data.hash).not.toBe(currentHash);
    expect(arg.data.hash).not.toContain('a-much-better-one');
    expect(arg.data.hash.startsWith('$2')).toBe(true);
  });

  it('refuses a wrong current password and writes nothing', async () => {
    const result = await changePassword(
      {},
      form({ ...good, currentPassword: 'not-the-password' }),
    );
    expect(result.error).toMatch(/current password/i);
    expect(update).not.toHaveBeenCalled();
  });

  it('refuses when the confirmation does not match', async () => {
    const result = await changePassword({}, form({ ...good, confirmPassword: 'different' }));
    expect(result.error).toMatch(/match/i);
    expect(update).not.toHaveBeenCalled();
  });

  it('enforces the same minimum length the admin dialog does', async () => {
    const result = await changePassword(
      {},
      form({ ...good, newPassword: 'short', confirmPassword: 'short' }),
    );
    expect(result.error).toMatch(/at least 8/);
    expect(update).not.toHaveBeenCalled();
  });

  it('refuses a no-op change', async () => {
    const same = 'temp-password-from-admin';
    const result = await changePassword(
      {},
      form({ currentPassword: same, newPassword: same, confirmPassword: same }),
    );
    expect(result.error).toMatch(/different/i);
    expect(update).not.toHaveBeenCalled();
  });

  it('refuses an unauthenticated caller', async () => {
    mockAuth.mockResolvedValue(null);
    await expect(changePassword({}, form(good))).rejects.toThrow(/Not authenticated/);
    expect(update).not.toHaveBeenCalled();
  });

  it('only ever touches the caller’s own row — no id comes from the form', async () => {
    await changePassword({}, form({ ...good, userId: 'someone-else' }));
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: ME } }),
    );
  });
});
