import Link from 'next/link';
import { revalidatePath } from 'next/cache';
import { after } from 'next/server';
import { notFound } from 'next/navigation';
import { prisma } from '@repo/db';
import { requireAdmin } from '@/lib/rbac';
import { inngest, EVENT_EMBED_PRESETS } from '@/lib/inngest';
import { Button } from '@/components/ui/button';
import { Card, CardBody, Eyebrow, Heading } from '@/components/ui/card';
import { Pill } from '@/components/ui/pill';
import { Input, Textarea, Select, FieldLabel } from '@/components/ui/input';

const LEVELS = ['LOW', 'MEDIUM', 'HIGH'] as const;
const DATA_VOLUMES = ['NONE', 'LOW', 'HIGH'] as const;
const PHASES = ['FOUNDATION', 'CORE', 'ENHANCEMENT'] as const;

const csv = (v: FormDataEntryValue | null): string[] =>
  typeof v === 'string'
    ? v.split(',').map((s) => s.trim()).filter(Boolean)
    : [];
const num = (v: FormDataEntryValue | null): number => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : 0;
};
const oneOf = <T extends readonly string[]>(v: FormDataEntryValue | null, opts: T, fallback: T[number]): T[number] =>
  typeof v === 'string' && (opts as readonly string[]).includes(v) ? (v as T[number]) : fallback;

async function savePreset(formData: FormData) {
  'use server';
  await requireAdmin();

  const presetId = formData.get('presetId');
  if (typeof presetId !== 'string') return;

  const active = await prisma.presetVersion.findFirst({
    where: { presetId, active: true },
    orderBy: { version: 'desc' },
  });
  const last = await prisma.presetVersion.findFirst({
    where: { presetId },
    orderBy: { version: 'desc' },
    select: { version: true },
  });
  if (!active || !last) return;
  const nextVersion = last.version + 1;

  // Editable fields from the form; fields not exposed in the form are carried
  // forward from the current active version.
  //
  // The embedding is carried forward too, inside the same transaction. It used
  // to be left null, which meant every admin edit silently dropped the preset
  // out of Archivist retrieval — `queryPresetsByVector` filters on
  // `embedding IS NOT NULL`, so the preset simply stopped ever matching, with
  // no error and no way back. An interactive transaction (not the array form)
  // is what closes the window: the new version is never visible without a
  // vector. The old `embeddingText` rides along unchanged, which is what marks
  // the vector as stale so the refresh below — or the backfill script — knows
  // to regenerate it.
  await prisma.$transaction(async (tx) => {
    await tx.presetVersion.updateMany({
      where: { presetId, active: true },
      data: { active: false },
    });
    const created = await tx.presetVersion.create({
      data: {
        presetId,
        version: nextVersion,
        active: true,
        name: (formData.get('name') as string) ?? active.name,
        category: (formData.get('category') as string) ?? active.category,
        description: (formData.get('description') as string) ?? active.description,
        beHours: num(formData.get('beHours')),
        feHours: num(formData.get('feHours')),
        reqType: (formData.get('reqType') as string) ?? active.reqType,
        platforms: csv(formData.get('platforms')),
        keywords: csv(formData.get('keywords')),
        integrationCount: num(formData.get('integrationCount')),
        dataVolume: oneOf(formData.get('dataVolume'), DATA_VOLUMES, active.dataVolume),
        phase: oneOf(formData.get('phase'), PHASES, active.phase),
        aiAssist: oneOf(formData.get('aiAssist'), LEVELS, active.aiAssist),
        risk: oneOf(formData.get('risk'), LEVELS, active.risk),
        canParallel: formData.get('canParallel') === 'on',
        spikeNeeded: formData.get('spikeNeeded') === 'on',
        notes: (formData.get('notes') as string) ?? active.notes,
        // Carried forward unchanged:
        userStoryTags: active.userStoryTags,
        projectSizeFit: active.projectSizeFit,
        requires: active.requires,
        blocks: active.blocks,
        taxonomyKey: active.taxonomyKey,
        changeReason: (formData.get('changeReason') as string) || 'edited via admin',
      },
      select: { id: true },
    });

    // Raw SQL because Prisma's typed client cannot read or write an
    // Unsupported("vector") column.
    await tx.$executeRawUnsafe(
      `UPDATE "PresetVersion" AS target
          SET embedding = source.embedding, "embeddingText" = source."embeddingText"
         FROM "PresetVersion" AS source
        WHERE target.id = $1 AND source.id = $2`,
      created.id,
      active.id,
    );
  });

  revalidatePath(`/admin/presets/${presetId}`);
  revalidatePath('/admin/presets');

  // Refresh the (now stale) vector out of band, *after* the response — the
  // Inngest SDK retries a failed send with backoff, which held the whole save
  // for ~20s whenever the event bus was unreachable (no `pnpm dev:inngest`
  // locally, for one). `after()` keeps the invocation alive for it on
  // serverless without making the admin wait.
  //
  // Best-effort by design: the save has already committed and the preset is
  // still indexed on its previous vector, so a dead event bus costs freshness,
  // not availability. `pnpm db:embed:presets` finds exactly these rows.
  after(async () => {
    try {
      await inngest.send({ name: EVENT_EMBED_PRESETS, data: { presetIds: [presetId] } });
    } catch (err) {
      console.error(`[presets] could not queue re-embed for ${presetId}:`, err);
    }
  });
}

type VersionRow = {
  version: number;
  name: string;
  category: string;
  reqType: string;
  beHours: number;
  feHours: number;
  risk: string;
  aiAssist: string;
  dataVolume: string;
  phase: string;
  platforms: string[];
  keywords: string[];
};

function diffVersions(curr: VersionRow, prev: VersionRow): Array<{ field: string; from: string; to: string }> {
  const fields: Array<keyof VersionRow> = [
    'name', 'category', 'reqType', 'beHours', 'feHours', 'risk', 'aiAssist',
    'dataVolume', 'phase', 'platforms', 'keywords',
  ];
  const out: Array<{ field: string; from: string; to: string }> = [];
  for (const f of fields) {
    const a = Array.isArray(prev[f]) ? (prev[f] as string[]).join(', ') : String(prev[f]);
    const b = Array.isArray(curr[f]) ? (curr[f] as string[]).join(', ') : String(curr[f]);
    if (a !== b) out.push({ field: f, from: a, to: b });
  }
  return out;
}

export default async function PresetEditorPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const versions = await prisma.presetVersion.findMany({
    where: { presetId: id },
    orderBy: { version: 'desc' },
  });
  const active = versions.find((v) => v.active) ?? versions[0];
  if (!active) {
    notFound();
  }
  const previous = versions.find((v) => v.version < active.version);
  const diff = previous ? diffVersions(active as VersionRow, previous as VersionRow) : [];

  return (
    <div data-testid="admin-preset-editor">
      <Link
        href="/admin/presets"
        className="text-[12.5px] text-ink-3 hover:text-ink hover:underline"
      >
        ← Presets
      </Link>

      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="num text-[12.5px] text-ink-3">{id}</span>
        <Heading level={1} className="min-w-0 break-words">
          {active.name}
        </Heading>
        <div className="flex items-center gap-2">
          <Pill tone="green" dot={false} data-testid="preset-active-version" className="num">
            v{active.version}
          </Pill>
          <span className="eyebrow">active version</span>
        </div>
      </div>
      <p className="mt-1.5 text-[13px] text-ink-3">
        Saving creates a new active version. Nothing is overwritten — v
        <span className="num">{active.version}</span> stays in the history below.
      </p>

      <form action={savePreset} className="mt-5 max-w-3xl">
        <input type="hidden" name="presetId" value={id} />

        <Card>
          <CardBody className="space-y-4 p-4 sm:p-5">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Name" name="name" defaultValue={active.name} />
              <Field label="Category" name="category" defaultValue={active.category} />
              <Field label="Req. type" name="reqType" defaultValue={active.reqType} />
              <NumField
                label="Integration count"
                name="integrationCount"
                defaultValue={active.integrationCount}
              />
              <NumField label="BE hours" name="beHours" defaultValue={active.beHours} />
              <NumField label="FE hours" name="feHours" defaultValue={active.feHours} />
              <SelectField label="Risk" name="risk" options={LEVELS} defaultValue={active.risk} />
              <SelectField
                label="AI assist"
                name="aiAssist"
                options={LEVELS}
                defaultValue={active.aiAssist}
              />
              <SelectField
                label="Data volume"
                name="dataVolume"
                options={DATA_VOLUMES}
                defaultValue={active.dataVolume}
              />
              <SelectField
                label="Phase"
                name="phase"
                options={PHASES}
                defaultValue={active.phase}
              />
            </div>

            <Field
              label="Platforms (comma-separated)"
              name="platforms"
              defaultValue={active.platforms.join(', ')}
            />
            <Field
              label="Keywords (comma-separated)"
              name="keywords"
              defaultValue={active.keywords.join(', ')}
            />

            <div>
              <FieldLabel htmlFor="description">Description</FieldLabel>
              <Textarea
                id="description"
                name="description"
                rows={3}
                defaultValue={active.description}
                className="font-mono text-[12.5px] leading-relaxed"
              />
            </div>

            <div>
              <FieldLabel htmlFor="notes">Notes / assumptions</FieldLabel>
              <Textarea
                id="notes"
                name="notes"
                rows={2}
                defaultValue={active.notes}
                className="font-mono text-[12.5px] leading-relaxed"
              />
            </div>

            <div className="flex flex-wrap gap-x-6 gap-y-2 border-t border-line-soft pt-4">
              <label className="flex items-center gap-2 text-[13px] text-ink-2">
                <input
                  type="checkbox"
                  name="canParallel"
                  defaultChecked={active.canParallel}
                  className="h-3.5 w-3.5 accent-[var(--color-green)]"
                />
                Can parallel
              </label>
              <label className="flex items-center gap-2 text-[13px] text-ink-2">
                <input
                  type="checkbox"
                  name="spikeNeeded"
                  defaultChecked={active.spikeNeeded}
                  className="h-3.5 w-3.5 accent-[var(--color-green)]"
                />
                Spike needed
              </label>
            </div>
          </CardBody>
        </Card>

        <div className="mt-4 flex flex-wrap items-end gap-3">
          <div className="min-w-[220px] flex-1">
            <Field
              label="Change reason"
              name="changeReason"
              defaultValue=""
              placeholder="What changed, and why?"
            />
          </div>
          <Button type="submit" data-testid="save-preset">
            Save new version
          </Button>
        </div>
      </form>

      {diff.length > 0 && (
        <section className="mt-8 max-w-3xl">
          <Eyebrow>
            Changes vs v<span className="num">{previous!.version}</span>
          </Eyebrow>
          <Card className="mt-2 overflow-hidden">
            <ul className="divide-y divide-line-soft" data-testid="preset-diff">
              {diff.map((d) => (
                <li key={d.field} className="px-4 py-2.5">
                  <div className="num text-[11.5px] text-ink-3">{d.field}</div>
                  <div className="mt-1 flex flex-col gap-1 overflow-x-auto">
                    <div className="flex min-w-0 items-start gap-2 rounded border border-brick-line bg-brick-tint px-2 py-1">
                      <span className="num shrink-0 text-[12px] font-bold text-brick">−</span>
                      <span className="font-mono text-[12.5px] break-words text-ink-2">
                        {d.from || '∅'}
                      </span>
                    </div>
                    <div className="flex min-w-0 items-start gap-2 rounded border border-green-line bg-green-tint px-2 py-1">
                      <span className="num shrink-0 text-[12px] font-bold text-green">+</span>
                      <span className="font-mono text-[12.5px] break-words text-ink">
                        {d.to || '∅'}
                      </span>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </Card>
        </section>
      )}

      <section className="mt-8">
        <Eyebrow>Version history</Eyebrow>
        <Card className="mt-2 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[13px]" data-testid="preset-history">
              <thead>
                <tr className="border-b border-line bg-surface-2 text-left">
                  <th className="eyebrow px-4 py-2.5 font-bold">Version</th>
                  <th className="eyebrow px-4 py-2.5 text-right font-bold">BE/FE</th>
                  <th className="eyebrow px-4 py-2.5 font-bold">Status</th>
                  <th className="eyebrow px-4 py-2.5 font-bold">Reason</th>
                  <th className="eyebrow px-4 py-2.5 font-bold">Created</th>
                </tr>
              </thead>
              <tbody>
                {versions.map((v) => (
                  <tr
                    key={v.id}
                    className="border-b border-line-soft last:border-0"
                    data-testid={`preset-version-${v.version}`}
                  >
                    <td className="num px-4 py-2.5 whitespace-nowrap text-ink">v{v.version}</td>
                    <td className="num px-4 py-2.5 text-right whitespace-nowrap text-ink-2">
                      {v.beHours}/{v.feHours}h
                    </td>
                    <td className="px-4 py-2.5">
                      {v.active ? (
                        <Pill tone="green">active</Pill>
                      ) : (
                        <Pill tone="neutral" dot={false}>
                          inactive
                        </Pill>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-ink-2">{v.changeReason ?? '—'}</td>
                    <td className="num px-4 py-2.5 whitespace-nowrap text-ink-3">
                      {new Date(v.createdAt).toLocaleDateString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </section>
    </div>
  );
}

function Field({
  label,
  name,
  defaultValue,
  placeholder,
}: {
  label: string;
  name: string;
  defaultValue: string;
  placeholder?: string;
}) {
  return (
    <div>
      <FieldLabel htmlFor={name}>{label}</FieldLabel>
      <Input id={name} name={name} defaultValue={defaultValue} placeholder={placeholder} />
    </div>
  );
}

function NumField({ label, name, defaultValue }: { label: string; name: string; defaultValue: number }) {
  return (
    <div>
      <FieldLabel htmlFor={name}>{label}</FieldLabel>
      <Input id={name} name={name} type="number" defaultValue={defaultValue} className="num" />
    </div>
  );
}

function SelectField({
  label,
  name,
  options,
  defaultValue,
}: {
  label: string;
  name: string;
  options: readonly string[];
  defaultValue: string;
}) {
  return (
    <div>
      <FieldLabel htmlFor={name}>{label}</FieldLabel>
      <Select id={name} name={name} defaultValue={defaultValue} className="w-full py-2">
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </Select>
    </div>
  );
}
