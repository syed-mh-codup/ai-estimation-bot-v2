import { revalidatePath } from 'next/cache';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { prisma } from '@repo/db';
import type { ChangeMotivation, TaxonomyStatus } from '@repo/db';
import { requireAdmin } from '@/lib/rbac';
import { Button } from '@/components/ui/button';
import { Card, CardBody, Eyebrow, Heading } from '@/components/ui/card';
import { Pill, type PillTone } from '@/components/ui/pill';
import { Input, Select, FieldLabel } from '@/components/ui/input';

const STATUS_TONE: Record<TaxonomyStatus, PillTone> = {
  PROPOSED: 'bronze',
  ACTIVE: 'green',
  COLLAPSED: 'neutral',
};

const MOTIVATIONS: ChangeMotivation[] = [
  'CORRECTION',
  'NEW_PROCESS',
  'POST_DELIVERY_VALIDATION',
  'TECH_ADVANCEMENT',
  'UPSKILL',
  'OTHER',
];

function isMotivation(v: string): v is ChangeMotivation {
  return (MOTIVATIONS as string[]).includes(v);
}

/**
 * Editing a node writes a new VERSION rather than mutating the current one, the
 * same way prompts and config work. `classifiable` is the exception: it lives on
 * the node, not the version, because it gates a query rather than describing a
 * revision — so it is set directly and its history is the version's change
 * reason, not a column.
 */
async function saveNode(formData: FormData) {
  'use server';
  const admin = await requireAdmin();

  const key = formData.get('key');
  const label = (formData.get('label') as string | null)?.trim();
  const reqTypeRaw = (formData.get('reqType') as string | null)?.trim();
  const keywordsRaw = (formData.get('keywords') as string | null) ?? '';
  const changeReason = (formData.get('changeReason') as string | null)?.trim();
  const motivationRaw = formData.get('changeMotivation');

  if (typeof key !== 'string' || !label || !changeReason) return;
  if (typeof motivationRaw !== 'string' || !isMotivation(motivationRaw)) return;

  const node = await prisma.taxonomyNode.findUnique({ where: { key }, select: { key: true } });
  if (!node) return;

  const keywords = keywordsRaw
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean);

  const last = await prisma.taxonomyNodeVersion.findFirst({
    where: { nodeKey: key },
    orderBy: { version: 'desc' },
    select: { version: true },
  });
  const nextVersion = (last?.version ?? 0) + 1;

  // Record who by email rather than id: this column exists to be read by a human
  // scanning the history months later, and a cuid tells them nothing.
  const author = await prisma.user.findUnique({
    where: { id: admin.id },
    select: { email: true },
  });

  await prisma.$transaction([
    prisma.taxonomyNode.update({
      where: { key },
      data: { label, classifiable: formData.get('classifiable') === 'on' },
    }),
    // Single-active invariant per node, same shape as prompts and config.
    prisma.taxonomyNodeVersion.updateMany({ where: { nodeKey: key }, data: { active: false } }),
    prisma.taxonomyNodeVersion.create({
      data: {
        nodeKey: key,
        version: nextVersion,
        label,
        reqType: reqTypeRaw || null,
        keywords,
        active: true,
        changeReason,
        changeMotivation: motivationRaw,
        createdBy: author?.email ?? null,
      },
    }),
  ]);

  revalidatePath(`/admin/taxonomy/${key}`);
  revalidatePath('/admin/taxonomy');
}

export default async function TaxonomyNodePage({
  params,
}: {
  params: Promise<{ key: string }>;
}) {
  const { key: rawKey } = await params;
  const key = decodeURIComponent(rawKey);

  const node = await prisma.taxonomyNode.findUnique({
    where: { key },
    select: {
      key: true,
      label: true,
      parentKey: true,
      status: true,
      classifiable: true,
      collapsedIntoKey: true,
      versions: {
        orderBy: { version: 'desc' },
        select: {
          version: true,
          label: true,
          reqType: true,
          keywords: true,
          active: true,
          changeReason: true,
          changeMotivation: true,
          createdBy: true,
          createdAt: true,
        },
      },
    },
  });
  if (!node) notFound();

  const current = node.versions.find((v) => v.active) ?? node.versions[0];

  return (
    <div data-testid="admin-taxonomy-node">
      <Link href="/admin/taxonomy" className="text-[12.5px] text-ink-3 hover:text-green">
        ← Taxonomy
      </Link>

      <div className="mt-2 flex flex-wrap items-center gap-3">
        <Heading level={1} className="text-[28px]">
          {node.label}
        </Heading>
        <Pill tone={STATUS_TONE[node.status]} dot={false} data-testid="node-status">
          {node.status.toLowerCase()}
        </Pill>
      </div>
      <p className="mt-1 text-[13px] text-ink-3">
        <span className="num text-ink-2">{node.key}</span>
        {node.parentKey && (
          <>
            {' · under '}
            <Link
              href={`/admin/taxonomy/${encodeURIComponent(node.parentKey)}`}
              className="num hover:text-green"
            >
              {node.parentKey}
            </Link>
          </>
        )}
        {node.collapsedIntoKey && (
          <>
            {' · folded into '}
            <Link
              href={`/admin/taxonomy/${encodeURIComponent(node.collapsedIntoKey)}`}
              className="num hover:text-green"
            >
              {node.collapsedIntoKey}
            </Link>
          </>
        )}
      </p>

      <form action={saveNode} className="mt-5 max-w-2xl space-y-3.5">
        <input type="hidden" name="key" value={node.key} />
        <Card>
          <CardBody>
            <Eyebrow>Current definition</Eyebrow>
            <p className="mt-1 text-[12.5px] text-ink-3">
              Saving writes a new version. The previous one is kept, deactivated — the history
              below is the audit trail.
            </p>

            <div className="mt-3.5">
              <FieldLabel htmlFor="label">Label</FieldLabel>
              <Input id="label" name="label" defaultValue={node.label} />
            </div>

            <div className="mt-3.5">
              <FieldLabel htmlFor="reqType">Requirement type</FieldLabel>
              <Input
                id="reqType"
                name="reqType"
                defaultValue={current?.reqType ?? ''}
                placeholder="Infrastructure"
              />
            </div>

            <div className="mt-3.5">
              <FieldLabel htmlFor="keywords">Keywords</FieldLabel>
              <Input
                id="keywords"
                name="keywords"
                defaultValue={(current?.keywords ?? []).join(', ')}
                placeholder="rate limit, throttling, quota"
              />
              <p className="mt-1 text-[12px] text-ink-3">
                Comma separated. These are what the retriever matches a requirement against.
              </p>
            </div>

            <label className="mt-3.5 flex items-start gap-2.5">
              <input
                type="checkbox"
                name="classifiable"
                defaultChecked={node.classifiable}
                className="mt-0.5"
                data-testid="node-classifiable"
              />
              <span className="text-[13px] text-ink-2">
                Classified against
                <span className="block text-[12px] text-ink-3">
                  Offer this key to the Librarian when it reads a statement of work. Turn it off
                  for work a client never asks for by name — delivery overhead exists and gets
                  costed, but a requirement should never land on it.
                </span>
              </span>
            </label>
          </CardBody>
        </Card>

        <Card>
          <CardBody>
            <Eyebrow>Why</Eyebrow>
            <div className="mt-3.5 grid gap-3.5 sm:grid-cols-[1fr_auto]">
              <div>
                <FieldLabel htmlFor="changeReason">Change reason</FieldLabel>
                <Input
                  id="changeReason"
                  name="changeReason"
                  required
                  placeholder="Narrowed the keywords — it was matching every integration"
                />
              </div>
              <div>
                <FieldLabel htmlFor="changeMotivation">Motivation</FieldLabel>
                <Select id="changeMotivation" name="changeMotivation" defaultValue="CORRECTION">
                  {MOTIVATIONS.map((m) => (
                    <option key={m} value={m}>
                      {m.toLowerCase().replace(/_/g, ' ')}
                    </option>
                  ))}
                </Select>
              </div>
            </div>
          </CardBody>
        </Card>

        <div className="flex items-center gap-3">
          <Button type="submit" data-testid="save-node">
            Save new version
          </Button>
          <span className="text-[12.5px] text-ink-3">
            This will become <span className="num">v{(node.versions[0]?.version ?? 0) + 1}</span>.
          </span>
        </div>
      </form>

      <Card className="mt-5 max-w-2xl">
        <CardBody>
          <Eyebrow>History</Eyebrow>
          <ul className="mt-3 divide-y divide-line" data-testid="node-history">
            {node.versions.map((v) => (
              <li key={v.version} className="py-3">
                <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                  <span className="num text-[13px] font-semibold text-ink">v{v.version}</span>
                  {v.active && (
                    <Pill tone="green" dot={false}>
                      active
                    </Pill>
                  )}
                  <span className="text-[12px] text-ink-4">
                    {v.createdAt.toISOString().slice(0, 10)}
                  </span>
                  {v.createdBy && <span className="text-[12px] text-ink-4">{v.createdBy}</span>}
                  <span className="rounded border border-line bg-surface px-1 text-[9.5px] font-bold tracking-[0.07em] uppercase text-ink-3">
                    {v.changeMotivation.toLowerCase().replace(/_/g, ' ')}
                  </span>
                </div>
                {v.changeReason && (
                  <p className="mt-1 text-[12.5px] text-ink-2">{v.changeReason}</p>
                )}
                <p className="mt-0.5 text-[12px] text-ink-3">
                  {v.label}
                  {v.reqType && ` · ${v.reqType}`}
                  {v.keywords.length > 0 && ` · ${v.keywords.join(', ')}`}
                </p>
              </li>
            ))}
          </ul>
        </CardBody>
      </Card>
    </div>
  );
}
