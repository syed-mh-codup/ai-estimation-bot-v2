import Link from 'next/link';
import { prisma } from '@repo/db';
import { Eyebrow } from '@/components/ui/card';
import { requireAdmin } from '@/lib/rbac';

/**
 * Every Oracle thread on this estimate, for an admin looking at this estimate.
 *
 * The companion to /admin/oracle, and it exists because the two answer
 * different questions. That page asks "what is Oracle being used for?"; this
 * asks "what has anyone asked about THIS estimate?" — which is the useful
 * question when the context you need is the one already on screen.
 *
 * Read-only, and only ever a link out. There is no compose box here and no
 * action that would accept one: an admin may read an investigation and may
 * never write into it. See lib/oracle-access.ts.
 *
 * The page gates on role before rendering this; the requireAdmin below is the
 * gate that actually holds, since a server component is reachable independently
 * of the branch that chose to render it.
 */
export async function OracleAdminPanel({ estimateId }: { estimateId: string }) {
  await requireAdmin();

  const threads = await prisma.oracleThread.findMany({
    where: { estimateId },
    orderBy: { updatedAt: 'desc' },
    take: 8,
    select: {
      id: true,
      title: true,
      updatedAt: true,
      user: { select: { email: true, name: true } },
      _count: { select: { messages: true } },
    },
  });

  return (
    <div className="rounded-[10px] border border-line bg-surface px-4 py-3.5" data-testid="oracle-admin-panel">
      <Eyebrow>Oracle threads</Eyebrow>

      {threads.length === 0 ? (
        <p className="mt-2 text-[12px] text-ink-3">
          Nobody has asked Oracle about this estimate yet.
        </p>
      ) : (
        <ul className="mt-2 space-y-2">
          {threads.map((t) => (
            <li key={t.id}>
              <Link
                href={`/admin/oracle/${t.id}`}
                className="block hover:text-green"
                data-testid={`oracle-admin-thread-${t.id}`}
              >
                <span className="block truncate text-[12.5px] text-ink">{t.title}</span>
                <span className="block text-[11px] text-ink-3">
                  {t.user.name ?? t.user.email} · <span className="num">{t._count.messages}</span>{' '}
                  {t._count.messages === 1 ? 'message' : 'messages'}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}

      <Link
        href={`/admin/oracle?estimateId=${estimateId}`}
        className="mt-2.5 inline-block text-[11.5px] text-ink-3 underline decoration-dotted underline-offset-2 hover:text-ink"
      >
        All Oracle threads →
      </Link>
    </div>
  );
}
