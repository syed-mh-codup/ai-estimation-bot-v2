import Link from 'next/link';
import { notFound } from 'next/navigation';
import { prisma } from '@repo/db';
import { buildOracleCorpus, renderCorpus } from '@repo/agents';
import { Card, CardBody, Eyebrow, Heading } from '@/components/ui/card';
import { Pill } from '@/components/ui/pill';
import { requireAdmin } from '@/lib/rbac';
import { renderSegments, toMessageDTO } from '@/app/estimates/[id]/oracle-dto';

/**
 * One Oracle conversation, read by an admin.
 *
 * Note what this page does NOT have: any way to reply. That is the rule the
 * whole feature rests on — a thread is a faithful record of one person working
 * something out, and an admin appending to it would make it a conversation
 * between two people neither of whom knows the other is there. There is no
 * compose box, and no server action exists that would accept one.
 *
 * Quotations are re-checked against the estimate as it stands now, exactly as
 * they are for the person who wrote them, so an admin reading this months later
 * sees the same three states: verified, invented, or stranded by an edit.
 */
export default async function AdminOracleThreadPage({
  params,
}: {
  params: Promise<{ threadId: string }>;
}) {
  await requireAdmin();
  const { threadId } = await params;

  const thread = await prisma.oracleThread.findUnique({
    where: { id: threadId },
    select: {
      id: true,
      title: true,
      createdAt: true,
      estimate: { select: { id: true, title: true } },
      user: { select: { email: true, name: true } },
      messages: { orderBy: { createdAt: 'asc' } },
    },
  });
  if (!thread) notFound();

  const corpus = await buildOracleCorpus(prisma, thread.estimate.id);
  const now = corpus && {
    sowHash: corpus.sowHash,
    runFinishedAt: corpus.runFinishedAt,
    sowText: corpus.sowText,
    corpusText: renderCorpus(corpus),
  };
  const messages = now ? thread.messages.map((m) => toMessageDTO(m, now)) : [];

  return (
    <div data-testid="admin-oracle-thread">
      <Link href="/admin/oracle" className="text-[12.5px] text-ink-3 hover:text-ink hover:underline">
        ← Oracle
      </Link>

      <div className="mt-3">
        <Heading level={1}>{thread.title}</Heading>
        <p className="mt-1.5 text-[13px] text-ink-3">
          Asked by {thread.user.name ?? thread.user.email} about{' '}
          <Link href={`/estimates/${thread.estimate.id}`} className="text-green hover:underline">
            {thread.estimate.title}
          </Link>
          . Read-only.
        </p>
      </div>

      {!now && (
        <p className="mt-4 text-[13px] text-bronze-ink">
          The estimate this thread belongs to no longer resolves, so quotations cannot be checked.
        </p>
      )}

      <div className="mt-5 space-y-3">
        {messages.map((m) => (
          <Card key={m.id}>
            <CardBody>
              <div className="flex items-center gap-2">
                <Eyebrow>{m.role === 'USER' ? (thread.user.name ?? 'Estimator') : 'Oracle'}</Eyebrow>
                {m.stale && (
                  <Pill tone="bronze" dot={false} className="text-[10.5px]">
                    predates the current estimate
                  </Pill>
                )}
              </div>

              <div className="mt-2 text-[13.5px] leading-relaxed text-ink-2">
                {renderSegments(m.content).map((seg, i) => {
                  if (seg.type === 'text') {
                    return (
                      <span key={i} className="whitespace-pre-wrap">
                        {seg.value}
                      </span>
                    );
                  }
                  const status =
                    m.citations.find((c) => c.quote === seg.value.trim())?.status ?? 'verified';
                  return (
                    <span
                      key={i}
                      title={CITATION_TITLE[status]}
                      className={`mx-0.5 rounded-[3px] border px-1 py-0.5 text-[13px] ${CITATION_STYLE[status]}`}
                    >
                      {seg.value}
                    </span>
                  );
                })}
              </div>

              {m.role === 'ASSISTANT' && (
                <p className="mt-2.5 flex flex-wrap gap-x-3 text-[11px] text-ink-4">
                  <span className="num">{m.modelString ?? 'unknown model'}</span>
                  {m.promptTokens !== null && (
                    <span className="num">
                      {m.promptTokens.toLocaleString()} in / {(m.completionTokens ?? 0).toLocaleString()} out
                    </span>
                  )}
                  {m.costUsd !== null && <span className="num">${m.costUsd.toFixed(5)}</span>}
                  <span className="num">{new Date(m.createdAt).toLocaleString()}</span>
                </p>
              )}
            </CardBody>
          </Card>
        ))}
      </div>
    </div>
  );
}

const CITATION_STYLE: Record<string, string> = {
  verified: 'border-green-line bg-green-tint text-green-deep',
  fabricated: 'border-brick-line bg-brick-tint text-ink line-through',
  'source-moved': 'border-bronze-line bg-bronze-tint text-ink',
};

const CITATION_TITLE: Record<string, string> = {
  verified: 'Found in the estimate.',
  fabricated:
    'Not found anywhere in the estimate, and the source has not changed since this answer — the model invented this wording.',
  'source-moved': 'The source has been edited since this answer, and this wording is no longer in it.',
};
