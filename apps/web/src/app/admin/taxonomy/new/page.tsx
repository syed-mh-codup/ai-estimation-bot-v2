import Link from 'next/link';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { prisma } from '@repo/db';
import { requireAdmin } from '@/lib/rbac';
import { Button } from '@/components/ui/button';
import { Card, CardBody, Eyebrow, Heading } from '@/components/ui/card';
import { Input, Select, FieldLabel } from '@/components/ui/input';

/**
 * Add a taxonomy node by hand.
 *
 * Until now the taxonomy was seed-only, and derived at that: every node was
 * minted from the preset library as `${slug(category)}.${slug(reqType)}`, so a
 * kind of work with no preset behind it simply could not be named. That is why
 * the `infra.*` keys the hidden-work audit referenced pointed at nothing.
 *
 * Created ACTIVE, because an admin filling this in IS the review — PROPOSED
 * exists for nodes a run invented, not for one a person deliberately typed. A v1
 * version is written alongside it so the node joins the audit trail the same way
 * every later edit will.
 */
async function createNode(formData: FormData) {
  'use server';
  const admin = await requireAdmin();

  const key = (formData.get('key') as string | null)?.trim().toLowerCase();
  const label = (formData.get('label') as string | null)?.trim();
  const parentRaw = (formData.get('parentKey') as string | null)?.trim();
  const reqType = (formData.get('reqType') as string | null)?.trim();
  const keywordsRaw = (formData.get('keywords') as string | null) ?? '';
  if (!key || !label) return;

  // Same shape the derived keys use (`category` or `category.req-type`), so a
  // hand-added node is indistinguishable from a seeded one downstream.
  if (!/^[a-z0-9]+(-[a-z0-9]+)*(\.[a-z0-9]+(-[a-z0-9]+)*)?$/.test(key)) return;

  const existing = await prisma.taxonomyNode.findUnique({ where: { key }, select: { key: true } });
  if (existing) return;

  if (parentRaw) {
    const parent = await prisma.taxonomyNode.findUnique({
      where: { key: parentRaw },
      select: { key: true },
    });
    if (!parent) return;
  }

  const author = await prisma.user.findUnique({
    where: { id: admin.id },
    select: { email: true },
  });

  await prisma.taxonomyNode.create({
    data: {
      key,
      label,
      parentKey: parentRaw || null,
      status: 'ACTIVE',
      classifiable: formData.get('classifiable') === 'on',
      versions: {
        create: {
          version: 1,
          label,
          reqType: reqType || null,
          keywords: keywordsRaw
            .split(',')
            .map((k) => k.trim())
            .filter(Boolean),
          active: true,
          changeReason: 'added by admin',
          createdBy: author?.email ?? null,
        },
      },
    },
  });

  revalidatePath('/admin/taxonomy');
  redirect(`/admin/taxonomy/${encodeURIComponent(key)}`);
}

export default async function NewTaxonomyNodePage() {
  const parents = await prisma.taxonomyNode.findMany({
    where: { parentKey: null, status: 'ACTIVE' },
    orderBy: { key: 'asc' },
    select: { key: true, label: true },
  });

  return (
    <div data-testid="admin-taxonomy-new">
      <Link href="/admin/taxonomy" className="text-[12.5px] text-ink-3 hover:text-green">
        ← Taxonomy
      </Link>

      <Heading level={1} className="mt-2 text-[28px]">
        New node
      </Heading>
      <p className="mt-1 max-w-[560px] text-[13px] leading-relaxed text-ink-3">
        Goes in accepted — you filling this in is the review. Use{' '}
        <span className="num text-ink-2">category.req-type</span> for a child, or a single segment
        to start a new branch.
      </p>

      <form action={createNode} className="mt-5 max-w-2xl space-y-3.5">
        <Card>
          <CardBody>
            <Eyebrow>Identity</Eyebrow>
            <div className="mt-3.5 grid gap-3.5 sm:grid-cols-2">
              <div>
                <FieldLabel htmlFor="key">Key</FieldLabel>
                <Input
                  id="key"
                  name="key"
                  required
                  placeholder="infra.observability"
                  className="num"
                />
                <p className="mt-1 text-[12px] text-ink-3">
                  Lower case, hyphens between words, one optional dot.
                </p>
              </div>
              <div>
                <FieldLabel htmlFor="parentKey">Parent</FieldLabel>
                <Select id="parentKey" name="parentKey" defaultValue="" className="w-full">
                  <option value="">None — start a new branch</option>
                  {parents.map((p) => (
                    <option key={p.key} value={p.key}>
                      {p.key}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="sm:col-span-2">
                <FieldLabel htmlFor="label">Label</FieldLabel>
                <Input
                  id="label"
                  name="label"
                  required
                  placeholder="Infrastructure &amp; Resilience — Observability"
                />
              </div>
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardBody>
            <Eyebrow>How it gets matched</Eyebrow>
            <div className="mt-3.5">
              <FieldLabel htmlFor="reqType">Requirement type</FieldLabel>
              <Input id="reqType" name="reqType" placeholder="Infrastructure" />
            </div>
            <div className="mt-3.5">
              <FieldLabel htmlFor="keywords">Keywords</FieldLabel>
              <Input id="keywords" name="keywords" placeholder="tracing, metrics, alerting" />
              <p className="mt-1 text-[12px] text-ink-3">
                Comma separated. What the retriever matches a requirement against.
              </p>
            </div>
            <label className="mt-3.5 flex items-start gap-2.5">
              <input
                type="checkbox"
                name="classifiable"
                defaultChecked
                className="mt-0.5"
                data-testid="new-classifiable"
              />
              <span className="text-[13px] text-ink-2">
                Classified against
                <span className="block text-[12px] text-ink-3">
                  Leave on for work a client can ask for by name. Turn it off for delivery overhead
                  — it still gets costed, but a requirement should never land on it.
                </span>
              </span>
            </label>
          </CardBody>
        </Card>

        <div className="flex items-center gap-3">
          <Button type="submit" data-testid="create-node">
            Add node
          </Button>
          <Button asChild variant="quiet">
            <Link href="/admin/taxonomy">Cancel</Link>
          </Button>
        </div>
      </form>
    </div>
  );
}
