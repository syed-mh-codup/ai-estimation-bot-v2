import { revalidatePath } from 'next/cache';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  corpusSection,
  partitionCorpusSections,
  prisma,
  saveArtifactTypeVersion,
} from '@repo/db';
import type { ChangeMotivation } from '@repo/db';
import { requireAdmin } from '@/lib/rbac';
import { Button } from '@/components/ui/button';
import { Card, CardBody, Eyebrow, Heading } from '@/components/ui/card';
import { Pill } from '@/components/ui/pill';
import { Input, Textarea, FieldLabel, Select } from '@/components/ui/input';
import { Combobox } from '@/components/ui/combobox';
import { fetchModelOptions } from '@/lib/openrouter-models';
import { CorpusPicker, readCorpusSections } from '../CorpusPicker';

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

async function saveType(formData: FormData) {
  'use server';
  const admin = await requireAdmin();

  const key = formData.get('key');
  const promptBody = (formData.get('promptBody') as string | null)?.trim();
  const modelString = (formData.get('modelString') as string | null)?.trim();
  const changeReason = (formData.get('changeReason') as string | null)?.trim();
  const motivationRaw = formData.get('changeMotivation');
  const changeMotivation =
    typeof motivationRaw === 'string' && isMotivation(motivationRaw) ? motivationRaw : 'OTHER';
  const corpusSections = readCorpusSections(formData);

  if (typeof key !== 'string' || !promptBody || !modelString || !changeReason) return;
  if (corpusSections.length === 0) return;

  const type = await prisma.artifactType.findUnique({ where: { key }, select: { id: true } });
  if (!type) return;

  const author = await prisma.user.findUnique({
    where: { id: admin.id },
    select: { email: true },
  });

  await saveArtifactTypeVersion(prisma, type.id, {
    promptBody,
    modelString,
    corpusSections,
    changeReason,
    changeMotivation,
    createdBy: author?.email ?? null,
  });

  revalidatePath(`/admin/artifact-types/${key}`);
  revalidatePath('/admin/artifact-types');
}

/**
 * Toggle a type between live and archived.
 *
 * Archiving, never deleting. A generated artifact is a client deliverable and
 * points at its type forever, so the row has to stay resolvable; `enabled` only
 * decides whether the type appears in the picker on an estimate.
 */
async function toggleEnabled(formData: FormData) {
  'use server';
  await requireAdmin();

  const key = formData.get('key');
  if (typeof key !== 'string') return;

  const type = await prisma.artifactType.findUnique({
    where: { key },
    select: { id: true, enabled: true },
  });
  if (!type) return;

  await prisma.artifactType.update({
    where: { id: type.id },
    data: { enabled: !type.enabled },
  });

  revalidatePath(`/admin/artifact-types/${key}`);
  revalidatePath('/admin/artifact-types');
}

export default async function ArtifactTypeEditorPage({
  params,
}: {
  params: Promise<{ key: string }>;
}) {
  const { key } = await params;

  const type = await prisma.artifactType.findUnique({
    where: { key },
    include: { versions: { orderBy: { version: 'desc' } } },
  });
  if (!type) notFound();

  const active = type.versions.find((v) => v.active);
  // A type always has an active version — `createArtifactType` makes both in one
  // transaction. Reaching here without one means something wrote rows directly.
  if (!active) notFound();

  const { known, unknown } = partitionCorpusSections(active.corpusSections);

  const models = await fetchModelOptions();
  const modelOptions = models.map((m) => ({
    value: m.id,
    label: m.name,
    hint: [
      m.contextLength ? `${Math.round(m.contextLength / 1000)}k context` : null,
      m.promptPrice !== null ? `$${(m.promptPrice * 1_000_000).toFixed(2)}/M in` : null,
      m.completionPrice !== null ? `$${(m.completionPrice * 1_000_000).toFixed(2)}/M out` : null,
    ]
      .filter(Boolean)
      .join(' · '),
  }));

  return (
    <div data-testid="admin-artifact-type-editor">
      <Link
        href="/admin/artifact-types"
        className="text-[12.5px] text-ink-3 hover:text-ink hover:underline"
      >
        ← Artifacts
      </Link>

      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
        <Heading level={1} className="min-w-0 break-words">
          {type.name}
        </Heading>
        <div className="flex items-center gap-2">
          <Pill tone="green" dot={false} data-testid="artifact-active-version" className="num">
            v{active.version}
          </Pill>
          <span className="eyebrow">active version</span>
        </div>
        {!type.enabled && (
          <Pill tone="bronze" data-testid="artifact-type-archived">
            archived
          </Pill>
        )}
      </div>
      <p className="mt-1.5 text-[13px] text-ink-3">
        Saving creates a new active version; v<span className="num">{active.version}</span> is kept
        in the history below and can be reactivated from its detail page.
      </p>

      <Card className="mt-4 max-w-3xl">
        <CardBody>
          <div className="flex flex-wrap items-center gap-2">
            <Eyebrow>Artifact type</Eyebrow>
            <span className="num text-[10.5px] text-ink-4">{type.key}</span>
          </div>
          {type.description && (
            <p className="mt-2 text-[13px] leading-relaxed text-ink-2">{type.description}</p>
          )}

          <div className="mt-3.5">
            <dt className="eyebrow text-ink-4">Currently reads</dt>
            <dd className="mt-1.5 flex flex-wrap gap-1">
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
            </dd>
          </div>

          {unknown.length > 0 && (
            <p
              className="mt-3 border-t border-line-soft pt-3 text-[12.5px] text-ink-3"
              data-testid="artifact-retired-sections"
            >
              This type asks for {unknown.length === 1 ? 'a section' : 'sections'} this build no
              longer has. Generation drops {unknown.length === 1 ? 'it' : 'them'} rather than
              failing, so the artifact still works — but it is seeing less than the brief assumes.
              Re-tick below and save to settle it.
            </p>
          )}

          <p
            className="mt-3 border-t border-line-soft pt-3 text-[12.5px] text-ink-3"
            data-testid="artifact-impact"
          >
            Editing changes what the NEXT generation produces. Documents already generated are
            untouched and keep a record of the version that made them — nothing regenerates on its
            own.
          </p>
        </CardBody>
      </Card>

      <form action={saveType} className="mt-5 max-w-3xl">
        <input type="hidden" name="key" value={type.key} />

        <Card>
          <CardBody className="space-y-4 p-4 sm:p-5">
            <div className="max-w-md">
              <FieldLabel htmlFor="modelString">Model</FieldLabel>
              <Combobox
                id="modelString"
                name="modelString"
                value={active.modelString}
                options={modelOptions}
                placeholder="Choose a model"
                emptyHint="Could not reach OpenRouter, so this is a plain text field. The value you type is saved as-is."
                data-testid="artifact-model-combobox"
              />
            </div>
          </CardBody>
        </Card>

        <Card className="mt-3.5">
          <CardBody className="p-4 sm:p-5">
            <CorpusPicker selected={active.corpusSections} />
          </CardBody>
        </Card>

        <Card className="mt-3.5">
          <CardBody className="p-4 sm:p-5">
            <FieldLabel htmlFor="promptBody">The brief</FieldLabel>
            <p className="mt-1 text-[12.5px] leading-relaxed text-ink-3">
              What this document is and what it must show. The page, its navigation and its styling
              are supplied around whatever you ask for — describe the content, not the container.
            </p>
            {/* The contract an author is writing against, stated where they are
                writing. Nothing is seeded here, so this is not a nicety: a
                brief is written cold, and the constraints below are the ones
                that decide whether it can be produced at all. */}
            <details className="group mt-2 mb-2.5">
              <summary className="cursor-pointer list-none text-[12px] text-ink-3 hover:text-green">
                <span className="group-open:hidden">What the brief is joined to →</span>
                <span className="hidden group-open:inline">Hide ↑</span>
              </summary>
              <div className="mt-2 space-y-2 border-l-2 border-line-soft pl-3 text-[12px] leading-relaxed text-ink-3">
                <p>
                  Your brief is wrapped in a supplied envelope carrying the output contract, the
                  CSS vocabulary and the size budget. You cannot break it, and you do not need to
                  restate any of it.
                </p>
                <p>
                  Generation plans an outline first, then writes one section per call. Each section
                  must fit about <span className="num">1200</span> words — a brief that names
                  distinct areas of concern plans well; one that demands a single enormous section
                  fights the constraint.
                </p>
                <p>
                  Sections never see each other&rsquo;s output, only the plan and the shared
                  vocabulary it fixes. Images cannot be fetched: diagrams are HTML, CSS and inline
                  SVG.
                </p>
                <p>
                  Use <strong>Preview the plan first</strong> on any estimate to see the section
                  plan for one call before generating the whole document.
                </p>
              </div>
            </details>
            <Textarea
              id="promptBody"
              name="promptBody"
              rows={18}
              defaultValue={active.promptBody}
              className="font-mono text-[12.5px] leading-relaxed"
              data-testid="artifact-brief"
            />
          </CardBody>
        </Card>

        <Card className="mt-3.5">
          <CardBody>
            <Eyebrow>Why</Eyebrow>
            <p className="mt-1 text-[12.5px] text-ink-3">
              The body diff shows what moved; this is the only place the reason survives.
            </p>
            <div className="mt-3.5 grid gap-3.5 sm:grid-cols-[1fr_auto]">
              <div>
                <FieldLabel htmlFor="changeReason">Change reason</FieldLabel>
                <Input
                  id="changeReason"
                  name="changeReason"
                  required
                  placeholder="Asked for cardinality on every relationship — the first pass left it implied"
                  data-testid="artifact-change-reason"
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

        <div className="mt-4">
          <Button type="submit" data-testid="save-artifact-type">
            Save new version
          </Button>
        </div>
      </form>

      <section className="mt-8 max-w-3xl">
        <Eyebrow>Version history</Eyebrow>
        <Card className="mt-2 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[13px]" data-testid="artifact-history">
              <thead>
                <tr className="border-b border-line bg-surface-2 text-left">
                  <th className="eyebrow px-4 py-2.5 font-bold">Version</th>
                  <th className="eyebrow px-4 py-2.5 font-bold">Model</th>
                  <th className="eyebrow px-4 py-2.5 font-bold">Status</th>
                  <th className="eyebrow px-4 py-2.5 font-bold">Created</th>
                </tr>
              </thead>
              <tbody>
                {type.versions.map((v) => (
                  <tr
                    key={v.id}
                    className="border-b border-line-soft last:border-0 hover:bg-surface-2"
                    data-testid={`artifact-version-${v.version}`}
                  >
                    <td className="num px-4 py-3 whitespace-nowrap">
                      <Link
                        href={`/admin/artifact-types/${type.key}/${v.version}`}
                        className="font-semibold text-ink hover:text-green hover:underline"
                        data-testid={`artifact-version-link-${v.version}`}
                      >
                        v{v.version}
                      </Link>
                    </td>
                    <td className="num px-4 py-3 text-[12px] break-all text-ink-2">
                      {v.modelString}
                    </td>
                    <td className="px-4 py-3">
                      {v.active ? (
                        <Pill tone="green">active</Pill>
                      ) : (
                        <Pill tone="neutral" dot={false}>
                          inactive
                        </Pill>
                      )}
                    </td>
                    <td className="num px-4 py-3 whitespace-nowrap text-ink-3">
                      {new Date(v.createdAt).toLocaleDateString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </section>

      <section className="mt-8 max-w-3xl">
        <Eyebrow>{type.enabled ? 'Archive' : 'Restore'}</Eyebrow>
        <p className="mt-1 text-[12.5px] leading-relaxed text-ink-3">
          {type.enabled
            ? 'Archiving removes this from the list of artifacts an estimate can generate. Documents already generated from it are untouched and stay readable — which is why archiving exists and deleting does not.'
            : 'Restoring puts this back in the list of artifacts an estimate can generate.'}
        </p>
        <form action={toggleEnabled} className="mt-3">
          <input type="hidden" name="key" value={type.key} />
          <Button type="submit" variant="outline" data-testid="toggle-artifact-type-enabled">
            {type.enabled ? 'Archive this type' : 'Restore this type'}
          </Button>
        </form>
      </section>
    </div>
  );
}
