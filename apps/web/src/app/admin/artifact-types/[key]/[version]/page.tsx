import { revalidatePath } from 'next/cache';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import {
  activateArtifactTypeVersion,
  corpusSection,
  partitionCorpusSections,
  prisma,
} from '@repo/db';
import { requireAdmin } from '@/lib/rbac';
import { Button } from '@/components/ui/button';
import { Card, CardBody, Eyebrow, Heading } from '@/components/ui/card';
import { Pill } from '@/components/ui/pill';
import { FieldLabel } from '@/components/ui/input';

/**
 * One version of an artifact type, and the button that puts it back in service.
 *
 * Mirrors `/admin/prompts/[kind]/[version]` including the distinction that page
 * draws: activating flips `active` on a version that already exists rather than
 * appending a copy, so rolling back to v3 leaves the history reading 1, 2, 3, 4
 * with 3 active.
 */
async function activateVersion(formData: FormData) {
  'use server';
  await requireAdmin();

  const key = formData.get('key');
  const versionRaw = formData.get('version');
  if (typeof key !== 'string' || typeof versionRaw !== 'string') return;
  const version = Number(versionRaw);
  if (!Number.isInteger(version)) return;

  const type = await prisma.artifactType.findUnique({ where: { key }, select: { id: true } });
  if (!type) return;

  await activateArtifactTypeVersion(prisma, type.id, version);

  revalidatePath(`/admin/artifact-types/${key}`);
  revalidatePath(`/admin/artifact-types/${key}/${version}`);
  revalidatePath('/admin/artifact-types');
  redirect(`/admin/artifact-types/${key}`);
}

export default async function ArtifactTypeVersionDetailPage({
  params,
}: {
  params: Promise<{ key: string; version: string }>;
}) {
  const { key, version: versionRaw } = await params;
  const version = Number(versionRaw);
  if (!Number.isInteger(version)) notFound();

  const type = await prisma.artifactType.findUnique({
    where: { key },
    select: { id: true, name: true, key: true },
  });
  if (!type) notFound();

  const row = await prisma.artifactTypeVersion.findUnique({
    where: { artifactTypeId_version: { artifactTypeId: type.id, version } },
  });
  if (!row) notFound();

  const { known, unknown } = partitionCorpusSections(row.corpusSections);

  return (
    <div data-testid="admin-artifact-version-detail">
      <Link
        href={`/admin/artifact-types/${type.key}`}
        className="text-[12.5px] text-ink-3 hover:text-ink hover:underline"
      >
        ← {type.name}
      </Link>

      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
        <Heading level={1} className="min-w-0 break-words">
          {type.name} <span className="num text-ink-3">v{row.version}</span>
        </Heading>
        {row.active ? (
          <Pill tone="green" data-testid="artifact-version-status">
            active
          </Pill>
        ) : (
          <Pill tone="neutral" dot={false} data-testid="artifact-version-status">
            inactive
          </Pill>
        )}
      </div>
      <p className="mt-1.5 text-[13px] text-ink-3">
        {row.active
          ? 'This is the version the next generation will use.'
          : 'A superseded version, kept for the record. Activate it to put it back in service.'}
      </p>

      <div className="mt-5 max-w-3xl">
        <Card>
          <CardBody className="p-4 sm:p-5">
            <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-[auto_minmax(0,1fr)]">
              <dt className="eyebrow self-center">Model</dt>
              <dd
                className="num text-[12.5px] break-all text-ink"
                data-testid="artifact-version-model"
              >
                {row.modelString}
              </dd>
              <dt className="eyebrow self-center">Reads</dt>
              <dd className="flex flex-wrap gap-1">
                {known.length === 0 && unknown.length === 0 ? (
                  <span className="text-[12.5px] text-ink-4">nothing</span>
                ) : (
                  <>
                    {known.map((k) => (
                      <Pill key={k} tone="neutral" dot={false}>
                        {corpusSection(k).label}
                      </Pill>
                    ))}
                    {unknown.map((k) => (
                      <Pill key={k} tone="bronze" dot={false}>
                        {k} (retired)
                      </Pill>
                    ))}
                  </>
                )}
              </dd>
              <dt className="eyebrow self-center">Created</dt>
              <dd className="num text-[12.5px] text-ink">
                {new Date(row.createdAt).toLocaleString()}
              </dd>
              <dt className="eyebrow self-center">Author</dt>
              <dd className="text-[12.5px] text-ink" data-testid="artifact-version-author">
                {row.createdBy ?? 'unattributed'}
              </dd>
              <dt className="eyebrow self-center">Motivation</dt>
              <dd className="text-[12.5px] text-ink">
                {row.changeMotivation.toLowerCase().replace(/_/g, ' ')}
              </dd>
              <dt className="eyebrow self-center">Change reason</dt>
              <dd className="text-[13px] text-ink">{row.changeReason ?? '—'}</dd>
            </dl>
          </CardBody>
        </Card>

        <div className="mt-5">
          <FieldLabel htmlFor="artifact-version-brief" className="eyebrow mb-2">
            The brief
          </FieldLabel>
          <Card>
            <CardBody className="p-4">
              <pre
                id="artifact-version-brief"
                className="overflow-x-auto font-mono text-[12.5px] leading-relaxed whitespace-pre-wrap text-ink-2"
                data-testid="artifact-version-brief"
              >
                {row.promptBody}
              </pre>
            </CardBody>
          </Card>
        </div>

        {!row.active && (
          <section className="mt-7">
            <Eyebrow>Reactivate</Eyebrow>
            <p className="mt-1 text-[12.5px] leading-relaxed text-ink-3">
              Puts this version back in service for the next generation. The version numbering is
              untouched — no copy is appended — so the history keeps reading in the order things
              actually happened.
            </p>
            <form action={activateVersion} className="mt-3">
              <input type="hidden" name="key" value={type.key} />
              <input type="hidden" name="version" value={row.version} />
              <Button type="submit" variant="outline" data-testid="activate-artifact-version">
                Make v{row.version} active
              </Button>
            </form>
          </section>
        )}
      </div>
    </div>
  );
}
