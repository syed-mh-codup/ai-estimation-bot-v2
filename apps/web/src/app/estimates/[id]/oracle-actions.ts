'use server';

import { prisma } from '@repo/db';
import { buildOracleCorpus, deriveThreadTitle, renderCorpus } from '@repo/agents';
import { requireUser } from '@/lib/rbac';
import { requireThreadAuthor, requireThreadReader } from '@/lib/oracle-access';
import {
  estimateThreadTokens,
  toMessageDTO,
  toThreadDTO,
  type OracleMessageDTO,
  type OracleThreadDTO,
} from './oracle-dto';

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

export type LoadedThread = {
  thread: OracleThreadDTO;
  messages: OracleMessageDTO[];
  /** Rough size of what gets replayed next turn, for the "start a new one" nudge. */
  approxTokens: number;
  /** True when the caller is reading someone else's thread as an admin. */
  readOnly: boolean;
};

/**
 * One thread, with every quotation re-checked against the estimate as it stands.
 *
 * The verification happens HERE rather than at write time, and rebuilding the
 * corpus on each load is the cost of that. It buys the distinction the whole
 * feature turns on: a quotation missing while the source hash is unchanged was
 * fabricated, and one missing after the source moved is merely stale. A verdict
 * frozen at write time could not tell the reader either thing later.
 */
export async function loadOracleThread(threadId: string): Promise<LoadedThread> {
  const access = await requireThreadReader(threadId);

  const [row, corpus] = await Promise.all([
    prisma.oracleThread.findUniqueOrThrow({
      where: { id: threadId },
      select: {
        id: true,
        title: true,
        updatedAt: true,
        userId: true,
        _count: { select: { messages: true } },
        messages: { orderBy: { createdAt: 'asc' } },
      },
    }),
    buildOracleCorpus(prisma, access.estimateId),
  ]);
  if (!corpus) throw new Error('Estimate not found');

  const now = {
    sowHash: corpus.sowHash,
    runFinishedAt: corpus.runFinishedAt,
    sowText: corpus.sowText,
    corpusText: renderCorpus(corpus),
  };

  return {
    thread: toThreadDTO(row),
    messages: row.messages.map((m) => toMessageDTO(m, now)),
    approxTokens: estimateThreadTokens(row.messages) + Math.round(now.corpusText.length / 4),
    readOnly: row.userId !== access.user.id,
  };
}
