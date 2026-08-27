import { revalidatePath } from 'next/cache';
import Link from 'next/link';
import { prisma } from '@repo/db';
import type { TaxonomyStatus } from '@repo/db';
import { requireAdmin } from '@/lib/rbac';
import { Button } from '@/components/ui/button';
import { Card, CardBody, Eyebrow, Heading } from '@/components/ui/card';
import { Pill, type PillTone } from '@/components/ui/pill';
import { Select } from '@/components/ui/input';

/**
 * The governance lifecycle of a taxonomy node, in the palette's own terms:
 * bronze is in flight (awaiting review), green settles (accepted and live),
 * neutral is inert (folded into another node and no longer classified against).
 */
const STATUS_TONE: Record<TaxonomyStatus, PillTone> = {
  PROPOSED: 'bronze',
  ACTIVE: 'green',
  COLLAPSED: 'neutral',
};

async function acceptProposal(formData: FormData) {
  'use server';
  await requireAdmin();
  const key = formData.get('key');
  if (typeof key !== 'string') return;

  // Only a proposal can be accepted. Guarding on the current status keeps a
  // stale form submission from resurrecting a node an admin already collapsed.
  await prisma.taxonomyNode.updateMany({
    where: { key, status: 'PROPOSED' },
    data: { status: 'ACTIVE', collapsedIntoKey: null },
  });
  revalidatePath('/admin/taxonomy');
}

async function collapseProposal(formData: FormData) {
  'use server';
  await requireAdmin();
  const key = formData.get('key');
  const into = formData.get('collapsedIntoKey');
  if (typeof key !== 'string' || typeof into !== 'string' || !into) return;
  if (into === key) return;

  // collapsedIntoKey is a bare key like parentKey, so nothing at the database
  // level stops it pointing at a node that does not exist. Check here, since
  // this action is the only thing that ever writes it.
  const target = await prisma.taxonomyNode.findUnique({ where: { key: into }, select: { key: true } });
  if (!target) return;

  await prisma.taxonomyNode.updateMany({
    where: { key, status: 'PROPOSED' },
    data: { status: 'COLLAPSED', collapsedIntoKey: into },
  });
  revalidatePath('/admin/taxonomy');
}

export default async function TaxonomyAdminPage() {
  const nodes = await prisma.taxonomyNode.findMany({
    orderBy: { key: 'asc' },
    select: {
      key: true,
      label: true,
      parentKey: true,
      status: true,
      classifiable: true,
      collapsedIntoKey: true,
      versions: {
        where: { active: true },
        select: { version: true, reqType: true, keywords: true },
        take: 1,
      },
    },
  });

  const proposals = nodes.filter((n) => n.status === 'PROPOSED');
  const settled = nodes.filter((n) => n.status !== 'PROPOSED');
  const acceptTargets = nodes.filter((n) => n.status === 'ACTIVE');
  const classifiableCount = nodes.filter((n) => n.status === 'ACTIVE' && n.classifiable).length;

  const parents = settled.filter((n) => !n.parentKey);
  const childrenOf = (parentKey: string) => settled.filter((n) => n.parentKey === parentKey);
  const orphaned = settled.filter((n) => n.parentKey && !nodes.some((p) => p.key === n.parentKey));

  return (
    <div data-testid="admin-taxonomy">
      <div className="flex flex-wrap items-center gap-3">
        <Heading level={1} className="text-[28px]">
          Taxonomy
        </Heading>
        <Pill tone="green" dot={false} data-testid="taxonomy-count">
          <span className="num">{classifiableCount}</span>&nbsp;classified against
        </Pill>
        {proposals.length > 0 && (
          <Pill tone="bronze" data-testid="taxonomy-proposal-count">
            <span className="num">{proposals.length}</span>&nbsp;awaiting review
          </Pill>
        )}
        <Button asChild size="lg" className="ml-auto">
          <Link href="/admin/taxonomy/new" data-testid="new-node">
            New node
          </Link>
        </Button>
      </div>
      <p className="mt-1 max-w-[640px] text-[13px] leading-relaxed text-ink-3">
        Two separate questions per node. <span className="text-ink-2">Status</span> is whether the
        node is real — only accepted nodes are offered to the Librarian, so a proposal changes no
        estimate while it sits here. <span className="text-ink-2">Classified against</span> is
        whether a client could ask for it: process overhead is real work, but nobody writes it in a
        statement of work.
      </p>

      {proposals.length > 0 && (
        <Card className="mt-5 border-bronze-line" data-testid="taxonomy-proposals">
          <CardBody>
            <Eyebrow>Awaiting review</Eyebrow>
            <p className="mt-1 text-[12.5px] text-ink-3">
              Proposed by a run. Accept it as its own node, or fold it into one that already means
              the same thing.
            </p>
            <ul className="mt-3.5 divide-y divide-line">
              {proposals.map((n) => (
                <li key={n.key} className="flex flex-wrap items-center gap-x-3 gap-y-2 py-3">
                  <div className="min-w-0 flex-1">
                    <div className="num text-[13px] font-semibold text-ink">{n.key}</div>
                    <div className="text-[12.5px] text-ink-3">{n.label}</div>
                  </div>
                  <form action={acceptProposal} className="flex items-center">
                    <input type="hidden" name="key" value={n.key} />
                    <Button type="submit" data-testid={`accept-${n.key}`}>
                      Accept
                    </Button>
                  </form>
                  <form action={collapseProposal} className="flex items-center gap-2">
                    <input type="hidden" name="key" value={n.key} />
                    <Select name="collapsedIntoKey" defaultValue="" aria-label={`Collapse ${n.key} into`}>
                      <option value="">Collapse into…</option>
                      {acceptTargets.map((t) => (
                        <option key={t.key} value={t.key}>
                          {t.key}
                        </option>
                      ))}
                    </Select>
                    <Button type="submit" variant="ghost" data-testid={`collapse-${n.key}`}>
                      Collapse
                    </Button>
                  </form>
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>
      )}



      <div className="mt-5 space-y-3.5">
        {parents.map((parent) => (
          <Card key={parent.key}>
            <CardBody>
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <Link
                  href={`/admin/taxonomy/${encodeURIComponent(parent.key)}`}
                  className="font-serif text-[18px] text-ink hover:text-green"
                >
                  {parent.label}
                </Link>
                <span className="num text-[12px] text-ink-4">{parent.key}</span>
                {!parent.classifiable && (
                  <span className="rounded border border-line bg-surface px-1 text-[9.5px] font-bold tracking-[0.07em] uppercase text-ink-3">
                    not classified against
                  </span>
                )}
              </div>
              <ul className="mt-3 divide-y divide-line">
                {childrenOf(parent.key).map((child) => (
                  <TaxonomyRow key={child.key} node={child} />
                ))}
              </ul>
            </CardBody>
          </Card>
        ))}

        {orphaned.length > 0 && (
          <Card>
            <CardBody>
              <Eyebrow>Unparented</Eyebrow>
              <p className="mt-1 text-[12.5px] text-ink-3">
                These name a parent that no longer exists. They still classify normally — this is
                here so a broken link is visible rather than silent.
              </p>
              <ul className="mt-3 divide-y divide-line">
                {orphaned.map((n) => (
                  <TaxonomyRow key={n.key} node={n} />
                ))}
              </ul>
            </CardBody>
          </Card>
        )}
      </div>
    </div>
  );
}

type RowNode = {
  key: string;
  label: string;
  status: TaxonomyStatus;
  classifiable: boolean;
  collapsedIntoKey: string | null;
  versions: Array<{ version: number; reqType: string | null; keywords: string[] }>;
};

function TaxonomyRow({ node }: { node: RowNode }) {
  const v = node.versions[0];
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1.5 py-2.5">
      <div className="min-w-0 flex-1">
        <Link
          href={`/admin/taxonomy/${encodeURIComponent(node.key)}`}
          className="num text-[13px] text-ink hover:text-green"
        >
          {node.key}
        </Link>
        {v?.reqType && <span className="ml-2 text-[12.5px] text-ink-3">{v.reqType}</span>}
        {node.collapsedIntoKey && (
          <span className="ml-2 text-[12.5px] text-ink-3">
            folded into <span className="num text-ink-2">{node.collapsedIntoKey}</span>
          </span>
        )}
      </div>
      {!node.classifiable && (
        <span className="rounded border border-line bg-surface px-1 text-[9.5px] font-bold tracking-[0.07em] uppercase text-ink-3">
          not classified against
        </span>
      )}
      {v && <span className="num text-[11px] text-ink-4">v{v.version}</span>}
      <Pill tone={STATUS_TONE[node.status]} dot={false}>
        {node.status.toLowerCase()}
      </Pill>
    </li>
  );
}
