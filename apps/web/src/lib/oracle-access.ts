import { prisma } from '@repo/db';
import { AuthError, requireUser, type SessionUser } from './rbac';

/**
 * Who may read and who may write an Oracle thread. AEH-259.
 *
 * This is the first user-scoped READ rule in the app, and it deliberately does
 * not follow the pattern next to it. Everywhere else here is a shared
 * workspace: every signed-in user can open and edit every estimate, and only
 * destruction is narrowed to the owner or an admin.
 *
 * A thread is different because of what it is. It is one person working out
 * what a document says — half-formed questions, wrong guesses, the things you
 * only ask when nobody is watching. Making that visible to colleagues by
 * default would quietly stop people asking, and an Oracle nobody asks awkward
 * questions of is worth nothing.
 *
 * So: private to its author. Admins may READ any thread, because somebody has
 * to be able to see what the pipeline keeps failing to explain, and because the
 * UI tells users plainly that this is the case. Admins may never WRITE into one
 * — not as themselves, not as anybody. A thread has to stay a faithful record
 * of one person's investigation, and there is deliberately no code path that
 * appends a turn on someone else's behalf.
 *
 * Guards live here rather than in the UI: the route handler and every action
 * call them, because a signed-in user can invoke either directly.
 */

export type ThreadAccess = { threadId: string; estimateId: string; user: SessionUser };

/**
 * For reading a thread: its author, or any admin.
 *
 * `estimateId` is returned rather than trusted from the caller — a thread id in
 * one estimate's URL must not read a thread belonging to another.
 */
export async function requireThreadReader(threadId: string): Promise<ThreadAccess> {
  const user = await requireUser();
  const thread = await prisma.oracleThread.findUnique({
    where: { id: threadId },
    select: { id: true, estimateId: true, userId: true },
  });
  // 404 rather than 403 for a thread that exists but is not theirs: telling a
  // stranger that a thread exists is itself a small leak of what a colleague is
  // looking into.
  if (!thread) throw new AuthError(404, 'Thread not found');
  if (thread.userId !== user.id && user.role !== 'ADMIN') {
    throw new AuthError(404, 'Thread not found');
  }
  return { threadId: thread.id, estimateId: thread.estimateId, user };
}

/**
 * For adding a turn: the author, and nobody else.
 *
 * Note the admin branch is absent on purpose, not by omission. See the header.
 */
export async function requireThreadAuthor(threadId: string): Promise<ThreadAccess> {
  const user = await requireUser();
  const thread = await prisma.oracleThread.findUnique({
    where: { id: threadId },
    select: { id: true, estimateId: true, userId: true },
  });
  if (!thread) throw new AuthError(404, 'Thread not found');
  if (thread.userId !== user.id) {
    throw new AuthError(403, 'Only the author can post in this thread');
  }
  return { threadId: thread.id, estimateId: thread.estimateId, user };
}
