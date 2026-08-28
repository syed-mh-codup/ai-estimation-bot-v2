'use server';

import { prisma } from '@repo/db';
import { deriveThreadTitle } from '@repo/agents';
import { requireUser } from '@/lib/rbac';
import { requireThreadAuthor } from '@/lib/oracle-access';
import { toThreadDTO, type OracleThreadDTO } from './oracle-dto';

/**
 * Thread housekeeping for Oracle.
 *
 * EVERY export here must be an async function — this module carries the
 * `'use server'` directive, and a single synchronous export breaks the build of
 * every route that imports from it while typecheck, lint and the unit suite all
 * stay green (AEH-253). Shapes and mappers live in oracle-dto.ts.
 *
 * Note what is absent: nothing here writes a message. Turns are appended by the
 * streaming route, which is the only place that can, and nothing in the Oracle
 * feature mutates an estimate at all.
 */

/** Every thread the caller owns on this estimate, most recently used first. */
export async function listOracleThreads(estimateId: string): Promise<OracleThreadDTO[]> {
  const user = await requireUser();
  const rows = await prisma.oracleThread.findMany({
    where: { estimateId, userId: user.id },
    orderBy: { updatedAt: 'desc' },
    select: { id: true, title: true, updatedAt: true, _count: { select: { messages: true } } },
  });
  return rows.map(toThreadDTO);
}

/**
 * Start a new line of enquiry.
 *
 * Titled from the opening question rather than by a model call: a thread list
 * that takes a second to populate, or costs money to name, is a worse list.
 * Threads are created empty and titled on the first question when the caller
 * has one, so the "New thread" button stays instant.
 */
export async function createOracleThread(
  estimateId: string,
  firstQuestion?: string,
): Promise<OracleThreadDTO> {
  const user = await requireUser();

  // Confirms the estimate exists before minting a thread against it. Every
  // signed-in user may ask about any estimate — the workspace is shared; it is
  // the CONVERSATION that is private.
  const estimate = await prisma.estimate.findUnique({
    where: { id: estimateId },
    select: { id: true },
  });
  if (!estimate) throw new Error('Estimate not found');

  const row = await prisma.oracleThread.create({
    data: {
      estimateId,
      userId: user.id,
      title: firstQuestion ? deriveThreadTitle(firstQuestion) : 'New thread',
    },
    select: { id: true, title: true, updatedAt: true, _count: { select: { messages: true } } },
  });
  return toThreadDTO(row);
}

/** Rename a thread. Author only. */
export async function renameOracleThread(threadId: string, title: string): Promise<void> {
  await requireThreadAuthor(threadId);
  const clean = title.replace(/\s+/g, ' ').trim().slice(0, 120);
  if (!clean) throw new Error('A thread needs a title');
  await prisma.oracleThread.update({ where: { id: threadId }, data: { title: clean } });
}

/**
 * Delete a thread and its messages.
 *
 * Author only, admins included — an admin may read someone's investigation but
 * not erase it. Deleting your own notes is not destructive in the way deleting
 * an estimate is; there is nothing downstream of a thread.
 */
export async function deleteOracleThread(threadId: string): Promise<void> {
  await requireThreadAuthor(threadId);
  await prisma.oracleThread.delete({ where: { id: threadId } });
}
