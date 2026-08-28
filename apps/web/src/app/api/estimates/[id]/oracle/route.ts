import { NextResponse } from 'next/server';
import { prisma } from '@repo/db';
import {
  buildOracleCorpus,
  buildOracleMessages,
  deriveThreadTitle,
  type OracleTurn,
} from '@repo/agents';
import { extractCitations } from '@repo/shared';
import type { TokenUsage } from '@repo/providers';
import { AuthError } from '@/lib/errors';
import { requireThreadAuthor } from '@/lib/oracle-access';
import { oracleModelProvider } from '@/lib/oracle-provider';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/**
 * Vercel Hobby's hard per-step ceiling, and the reason to say out loud that ONE
 * Oracle turn is ONE model call. A multi-call agentic loop would fit today and
 * stop fitting the first time somebody asks about a long document.
 */
export const maxDuration = 300;

/**
 * One Oracle turn, streamed.
 *
 * Server-sent events over POST, so the client reads it with fetch and a stream
 * reader rather than EventSource (which cannot POST a body). This is the first
 * streaming endpoint in the app; everything else that takes time is an Inngest
 * job the client polls. A conversation is the wrong shape for that — there is
 * nothing durable to resume, and the value is in seeing words appear.
 *
 * Ordering is deliberate and the durability rests on it:
 *   authorise -> persist the QUESTION -> stream -> persist the ANSWER -> done
 *
 * The question is written before a single token is requested, so a dropped
 * connection loses the answer but never the fact that it was asked. The answer
 * is written before the `done` frame is sent, so if the client sees `done` the
 * row exists — a reload can never show fewer turns than the user just watched.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: estimateId } = await params;

  let body: { threadId?: unknown; question?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'invalid body' }, { status: 400 });
  }

  const threadId = typeof body.threadId === 'string' ? body.threadId : '';
  const question = typeof body.question === 'string' ? body.question.trim() : '';
  if (!threadId || !question) {
    return NextResponse.json({ error: 'threadId and question are required' }, { status: 400 });
  }

  let access;
  try {
    access = await requireThreadAuthor(threadId);
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    throw err;
  }
  // A thread id from another estimate's URL must not answer against this one.
  if (access.estimateId !== estimateId) {
    return NextResponse.json({ error: 'Thread not found' }, { status: 404 });
  }

  const corpus = await buildOracleCorpus(prisma, estimateId);
  if (!corpus) return NextResponse.json({ error: 'not found' }, { status: 404 });

  const prompt = await prisma.promptVersion.findFirst({
    where: { kind: 'ORACLE', active: true },
    orderBy: { version: 'desc' },
    select: { body: true, modelString: true },
  });
  if (!prompt) {
    // Not seeded. Worth its own message: the fix is `pnpm db:seed:oracle`, and
    // never the bootstrap seed, which would revert every other live prompt.
    return NextResponse.json(
      { error: 'Oracle has no active prompt. Run pnpm db:seed:oracle.' },
      { status: 503 },
    );
  }

  const history: OracleTurn[] = (
    await prisma.oracleMessage.findMany({
      where: { threadId },
      orderBy: { createdAt: 'asc' },
      select: { role: true, content: true },
    })
  ).map((m) => ({ role: m.role, content: m.content }));

  // The question lands first, and the thread's title with it when this is the
  // opening turn — a thread created empty from the "new thread" button would
  // otherwise be called "New thread" for ever, which makes the list useless.
  await prisma.$transaction([
    prisma.oracleMessage.create({
      data: {
        threadId,
        role: 'USER',
        content: question,
        citations: [],
        sowHash: corpus.sowHash,
        estimateRunAt: corpus.runFinishedAt,
      },
    }),
    prisma.oracleThread.update({
      where: { id: threadId },
      data: {
        updatedAt: new Date(),
        ...(history.length === 0 ? { title: deriveThreadTitle(question) } : {}),
      },
    }),
  ]);

  const messages = buildOracleMessages({
    corpus,
    instructions: prompt.body,
    history,
    question,
  });

  const encoder = new TextEncoder();
  const send = (controller: ReadableStreamDefaultController, payload: unknown) =>
    controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));

  const stream = new ReadableStream({
    async start(controller) {
      let answer = '';
      let usage: TokenUsage | null = null;
      let served = prompt.modelString;

      try {
        for await (const ev of oracleModelProvider().chatStream({
          model: prompt.modelString,
          messages,
          temperature: 0,
        })) {
          if (ev.type === 'delta') {
            answer += ev.text;
            send(controller, { type: 'delta', text: ev.text });
          } else {
            usage = ev.usage;
            served = ev.model;
          }
        }

        const saved = await prisma.oracleMessage.create({
          data: {
            threadId,
            role: 'ASSISTANT',
            content: answer,
            citations: extractCitations(answer),
            sowHash: corpus.sowHash,
            estimateRunAt: corpus.runFinishedAt,
            modelString: served,
            promptTokens: usage?.promptTokens ?? null,
            completionTokens: usage?.completionTokens ?? null,
            costUsd: usage?.costUsd ?? null,
          },
          select: { id: true },
        });

        send(controller, { type: 'done', messageId: saved.id });
      } catch (err) {
        // The question is already persisted, and the user has already read
        // whatever arrived before this. Say so rather than leaving the panel
        // spinning; the partial answer is deliberately NOT saved, because a
        // truncated answer that looks complete on reload is worse than none.
        const message = err instanceof Error ? err.message : 'Oracle could not answer';
        console.error(`[oracle] ${estimateId} thread ${threadId} failed:`, err);
        send(controller, { type: 'error', message });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // Proxies that buffer would defeat the entire point of streaming.
      'X-Accel-Buffering': 'no',
    },
  });
}
