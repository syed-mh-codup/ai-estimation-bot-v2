import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Oracle's access rules, which are unlike anything else in this app. AEH-259.
 *
 * Everywhere else is a shared workspace: any signed-in user can open and edit
 * any estimate. A thread is private to the person who wrote it, because it is
 * one person working out what a document says and people stop asking awkward
 * questions when colleagues can read them.
 *
 * The rule that most needs pinning is the asymmetric one: an admin may READ any
 * thread and may never WRITE into one. If that ever quietly becomes symmetric,
 * a thread stops being a faithful record of one person's investigation, and the
 * notice shown to users about who can see this becomes a lie.
 */

vi.mock('@/lib/auth', () => ({ auth: vi.fn() }));

const threadFindUnique = vi.fn();
const threadDelete = vi.fn();
vi.mock('@repo/db', () => ({
  prisma: {
    oracleThread: {
      findUnique: (...a: unknown[]) => threadFindUnique(...a),
      delete: (...a: unknown[]) => threadDelete(...a),
    },
  },
}));

import { auth } from '@/lib/auth';
import { requireThreadAuthor, requireThreadReader } from '@/lib/oracle-access';
import { AuthError } from '@/lib/errors';
import { deleteOracleThread } from './oracle-actions';

const mockAuth = auth as unknown as ReturnType<typeof vi.fn>;

const AUTHOR = 'user-author';
const STRANGER = 'user-stranger';
const ADMIN = 'user-admin';
const THREAD = 'thread-1';
const ESTIMATE = 'est-1';

const signedInAs = (id: string, role: 'ESTIMATOR' | 'ADMIN' = 'ESTIMATOR') =>
  mockAuth.mockResolvedValue({ user: { id, role } });

beforeEach(() => {
  vi.clearAllMocks();
  threadFindUnique.mockResolvedValue({ id: THREAD, estimateId: ESTIMATE, userId: AUTHOR });
  threadDelete.mockResolvedValue({});
});

describe('reading a thread', () => {
  it('lets the author read their own thread', async () => {
    signedInAs(AUTHOR);
    await expect(requireThreadReader(THREAD)).resolves.toMatchObject({
      threadId: THREAD,
      estimateId: ESTIMATE,
    });
  });

  it('lets an admin read someone else’s thread', async () => {
    signedInAs(ADMIN, 'ADMIN');
    await expect(requireThreadReader(THREAD)).resolves.toMatchObject({ threadId: THREAD });
  });

  it('hides another user’s thread from a stranger', async () => {
    signedInAs(STRANGER);
    await expect(requireThreadReader(THREAD)).rejects.toThrow(AuthError);
  });

  it('reports someone else’s thread as missing, not as forbidden', async () => {
    // 403 would confirm the thread exists, which is itself a leak of what a
    // colleague is investigating.
    signedInAs(STRANGER);
    await expect(requireThreadReader(THREAD)).rejects.toMatchObject({ status: 404 });
  });

  it('refuses an unauthenticated caller', async () => {
    mockAuth.mockResolvedValue(null);
    await expect(requireThreadReader(THREAD)).rejects.toMatchObject({ status: 401 });
  });

  it('returns the thread’s own estimate id rather than trusting the caller', async () => {
    // The route compares this against the estimate in the URL, so a thread id
    // pasted into another estimate's path cannot be answered against it.
    signedInAs(AUTHOR);
    await expect(requireThreadReader(THREAD)).resolves.toMatchObject({ estimateId: ESTIMATE });
  });
});

describe('writing to a thread', () => {
  it('lets the author post', async () => {
    signedInAs(AUTHOR);
    await expect(requireThreadAuthor(THREAD)).resolves.toMatchObject({ threadId: THREAD });
  });

  it('refuses an admin — reading is not posting', async () => {
    signedInAs(ADMIN, 'ADMIN');
    await expect(requireThreadAuthor(THREAD)).rejects.toMatchObject({ status: 403 });
  });

  it('refuses a stranger', async () => {
    signedInAs(STRANGER);
    await expect(requireThreadAuthor(THREAD)).rejects.toThrow(AuthError);
  });
});

describe('thread housekeeping actions enforce the same rules', () => {
  it('lets the author delete their thread', async () => {
    signedInAs(AUTHOR);
    await deleteOracleThread(THREAD);
    expect(threadDelete).toHaveBeenCalledWith({ where: { id: THREAD } });
  });

  it('does not let an admin delete someone else’s thread', async () => {
    // An admin may read an investigation. Erasing it is a different thing.
    signedInAs(ADMIN, 'ADMIN');
    await expect(deleteOracleThread(THREAD)).rejects.toThrow(AuthError);
    expect(threadDelete).not.toHaveBeenCalled();
  });

  it('does not let a stranger delete a thread', async () => {
    signedInAs(STRANGER);
    await expect(deleteOracleThread(THREAD)).rejects.toThrow(AuthError);
    expect(threadDelete).not.toHaveBeenCalled();
  });
});
