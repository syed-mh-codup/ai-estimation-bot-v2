import Link from 'next/link';
import { revalidatePath } from 'next/cache';
import { after } from 'next/server';
import { notFound } from 'next/navigation';
import { prisma, carryPresetVector, carryPresetEdges, loadPresetGraph } from '@repo/db';
import { requireAdmin } from '@/lib/rbac';
import { inngest, EVENT_EMBED_PRESETS } from '@/lib/inngest';
import { Button } from '@/components/ui/button';
import { Card, CardBody, Eyebrow, Heading } from '@/components/ui/card';
import { Pill } from '@/components/ui/pill';
import { DependencyEditor } from './dependency-editor';
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
    include: { anchor: true, retrieval: true, composition: true },
  });
  const last = await prisma.presetVersion.findFirst({
    where: { presetId },
    orderBy: { version: 'desc' },
    select: { version: true },
  });
  if (!active?.anchor || !active.retrieval || !active.composition || !last) return;
  const prevAnchor = active.anchor;
  const prevRetrieval = active.retrieval;
  const nextVersion = last.version + 1;

  // Editable fields from the form; fields not exposed in the form are carried
  // forward from the current active version.
  //
  // All three concern rows are per-version (AEH-244), so a save writes a fresh
  // anchor, retrieval and composition rather than mutating the old ones — that
  // is what gives a rename or a keyword edit real history instead of an in-place
  // overwrite.
  //
  // The embedding is carried forward too, inside the same transaction. Left
  // null, every admin edit would silently drop the preset out of Archivist
  // retrieval — `findNearestPresets` filters on `embedding IS NOT NULL` for the
  // *active* version, so the preset simply stops ever matching, with no error.
  // An interactive transaction (not the array form) is what closes the window:
  // the new version is never visible without a vector. The old `embeddingText`
  // rides along unchanged, which is what marks the vector as stale so the
  // refresh below — or the backfill script — knows to regenerate it.
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
        changeReason: (formData.get('changeReason') as string) || 'edited via admin',
      },
      select: { id: true },
    });

    await tx.presetAnchor.create({
      data: {
        presetVersionId: created.id,
        category: (formData.get('category') as string) ?? prevAnchor.category,
        devHours: num(formData.get('devHours')),
        touchesFrontend: formData.get('touchesFrontend') === 'on',
        touchesBackend: formData.get('touchesBackend') === 'on',
        beHours: null,
        feHours: null,
        reqType: (formData.get('reqType') as string) ?? prevAnchor.reqType,
        platforms: csv(formData.get('platforms')),
        integrationCount: num(formData.get('integrationCount')),
        dataVolume: oneOf(formData.get('dataVolume'), DATA_VOLUMES, prevAnchor.dataVolume),
        phase: oneOf(formData.get('phase'), PHASES, prevAnchor.phase),
        aiAssist: oneOf(formData.get('aiAssist'), LEVELS, prevAnchor.aiAssist),
        risk: oneOf(formData.get('risk'), LEVELS, prevAnchor.risk),
        spikeNeeded: formData.get('spikeNeeded') === 'on',
        projectSizeFit: prevAnchor.projectSizeFit,
        taxonomyKey: prevAnchor.taxonomyKey,
      },
    });

    await tx.presetRetrieval.create({
      data: {
        presetVersionId: created.id,
        name: (formData.get('name') as string) ?? prevRetrieval.name,
        description: (formData.get('description') as string) ?? prevRetrieval.description,
        keywords: csv(formData.get('keywords')).length
          ? csv(formData.get('keywords'))
          : prevRetrieval.keywords,
        notes: (formData.get('notes') as string) ?? prevRetrieval.notes,
        userStoryTags: prevRetrieval.userStoryTags,
      },
    });

    await carryPresetVector(tx, prevRetrieval.id, created.id);

    await tx.presetComposition.create({
      data: {
        presetVersionId: created.id,
        canParallel: formData.get('canParallel') === 'on',
      },
    });

    // Edges are per-version, so a save that did not carry them would silently
    // strip every prerequisite the moment an admin edited an unrelated field.
    // Same failure mode as the vector carry above: no error, nothing on screen,
    // and the configurator quietly stops pulling in the work this preset needs.
    // AEH-242.
    await carryPresetEdges(tx, active.id, created.id);
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
  // still indexed on the vector carried above, so a dead event bus costs
  // freshness, not availability. `pnpm db:embed:presets` finds exactly these rows.
  after(async () => {
    try {
      await inngest.send({ name: EVENT_EMBED_PRESETS, data: { presetIds: [presetId] } });
    } catch (err) {
      console.error(`[presets] could not queue re-embed for ${presetId}:`, err);
    }
  });
}

function sidesLabel(be: boolean, fe: boolean): string {
  if (be && fe) return 'be · fe';
  if (be) return 'be';
  if (fe) return 'fe';
  return '—';
}

type VersionRow = {
  version: number;
  name: string;
  category: string;
  reqType: string;
  devHours: number;
  touchesFrontend: boolean;
  touchesBackend: boolean;
  risk: string;
  aiAssist: string;
  dataVolume: string;
  phase: string;
  platforms: string[];
  keywords: string[];
};

function diffVersions(curr: VersionRow, prev: VersionRow): Array<{ field: string; from: string; to: string }> {
  const fields: Array<keyof VersionRow> = [
    'name', 'category', 'reqType', 'devHours', 'touchesFrontend', 'touchesBackend', 'risk', 'aiAssist',
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
  const [preset, versions, graph] = await Promise.all([
    prisma.preset.findUnique({ where: { id }, select: { code: true, origin: true } }),
    prisma.presetVersion.findMany({
      where: { presetId: id },
      orderBy: { version: 'desc' },
      include: { anchor: true, retrieval: true, composition: true },
    }),
    // The whole graph, serialised to the client once. The picker answers
    // "what does this drag in?" per keystroke and per hover, and a round trip
    // for each would make the one interaction this ticket exists to get right
    // feel worse than the dropdowns it replaces.
    loadPresetGraph(prisma),
  ]);
  const active = versions.find((v) => v.active) ?? versions[0];
  if (!active?.anchor || !active.retrieval || !active.composition) {
    notFound();
  }

  const anchor = active.anchor;
  const retrieval = active.retrieval;
  const composition = active.composition;

  const activeView = {
    version: active.version,
    name: retrieval.name,
    category: anchor.category,
    reqType: anchor.reqType,
    description: retrieval.description,
    devHours: anchor.devHours,
    touchesFrontend: anchor.touchesFrontend,
    touchesBackend: anchor.touchesBackend,
    risk: anchor.risk,
    aiAssist: anchor.aiAssist,
    dataVolume: anchor.dataVolume,
    phase: anchor.phase,
    platforms: anchor.platforms,
    keywords: retrieval.keywords,
    integrationCount: anchor.integrationCount,
    spikeNeeded: anchor.spikeNeeded,
    notes: retrieval.notes,
    canParallel: composition.canParallel,
  };

  const previous = versions.find((v) => v.version < active.version);
  const diff =
    previous?.anchor && previous.retrieval
      ? diffVersions(
          { ...activeView, version: active.version },
          {
            version: previous.version,
            name: previous.retrieval.name,
            category: previous.anchor.category,
            reqType: previous.anchor.reqType,
            devHours: previous.anchor.devHours,
            touchesFrontend: previous.anchor.touchesFrontend,
            touchesBackend: previous.anchor.touchesBackend,
            risk: previous.anchor.risk,
            aiAssist: previous.anchor.aiAssist,
            dataVolume: previous.anchor.dataVolume,
            phase: previous.anchor.phase,
            platforms: previous.anchor.platforms,
            keywords: previous.retrieval.keywords,
          },
        )
      : [];

  return (
    <div data-testid="admin-preset-editor">
      <Link
        href="/admin/presets"
        className="text-[12.5px] text-ink-3 hover:text-ink hover:underline"
      >
        ← Presets
      </Link>

      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="num text-[12.5px] text-ink-3" data-testid="preset-code">
          {preset?.code ?? id}
        </span>
        {preset && preset.origin !== 'SEEDED' && (
          <span className="text-[10.5px] tracking-[0.04em] text-ink-4 uppercase">
            {preset.origin === 'FINALISED' ? 'from delivered work' : 'entered by hand'}
          </span>
        )}
        <Heading level={1} className="min-w-0 break-words">
          {activeView.name}
        </Heading>
        <div className="flex items-center gap-2">
          <Pill tone="green" dot={false} data-testid="preset-active-version" className="num">
            v{activeView.version}
          </Pill>
          <span className="eyebrow">active version</span>
        </div>
      </div>
      <p className="mt-1.5 text-[13px] text-ink-3">
        Saving creates a new active version. Nothing is overwritten — v
        <span className="num">{activeView.version}</span> stays in the history below.
      </p>

      <form action={savePreset} className="mt-5 max-w-3xl">
        <input type="hidden" name="presetId" value={id} />

        <Card>
          <CardBody className="space-y-4 p-4 sm:p-5">
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Name" name="name" defaultValue={activeView.name} />
              <Field label="Category" name="category" defaultValue={activeView.category} />
              <Field label="Req. type" name="reqType" defaultValue={activeView.reqType} />
              <NumField
                label="Integration count"
                name="integrationCount"
                defaultValue={activeView.integrationCount}
              />
              <NumField label="Dev hours" name="devHours" defaultValue={activeView.devHours} />
              <SelectField label="Risk" name="risk" options={LEVELS} defaultValue={activeView.risk} />
              <SelectField
                label="AI assist"
                name="aiAssist"
                options={LEVELS}
                defaultValue={activeView.aiAssist}
              />
              <SelectField
                label="Data volume"
                name="dataVolume"
                options={DATA_VOLUMES}
                defaultValue={activeView.dataVolume}
              />
              <SelectField
                label="Phase"
                name="phase"
                options={PHASES}
                defaultValue={activeView.phase}
              />
            </div>

            <Field
              label="Platforms (comma-separated)"
              name="platforms"
              defaultValue={activeView.platforms.join(', ')}
            />
            <Field
              label="Keywords (comma-separated)"
              name="keywords"
              defaultValue={activeView.keywords.join(', ')}
            />

            <div>
              <FieldLabel htmlFor="description">Description</FieldLabel>
              <Textarea
                id="description"
                name="description"
                rows={3}
                defaultValue={activeView.description}
                className="font-mono text-[12.5px] leading-relaxed"
              />
            </div>

            <div>
              <FieldLabel htmlFor="notes">Notes / assumptions</FieldLabel>
              <Textarea
                id="notes"
                name="notes"
                rows={2}
                defaultValue={activeView.notes}
                className="font-mono text-[12.5px] leading-relaxed"
              />
            </div>

            <div className="border-t border-line-soft pt-4">
              <Eyebrow>Stack coverage</Eyebrow>
              <p className="mt-1 text-[11.5px] text-ink-4">
                For reference only — dev hours are estimated as one figure.
              </p>
              <div className="mt-2 flex flex-wrap gap-x-6 gap-y-2">
                <label className="flex items-center gap-2 text-[13px] text-ink-2">
                  <input
                    type="checkbox"
                    name="touchesBackend"
                    defaultChecked={activeView.touchesBackend}
                    className="h-3.5 w-3.5 accent-[var(--color-green)]"
                    data-testid="preset-touches-backend"
                  />
                  Backend
                </label>
                <label className="flex items-center gap-2 text-[13px] text-ink-2">
                  <input
                    type="checkbox"
                    name="touchesFrontend"
                    defaultChecked={activeView.touchesFrontend}
                    className="h-3.5 w-3.5 accent-[var(--color-green)]"
                    data-testid="preset-touches-frontend"
                  />
                  Frontend
                </label>
              </div>
            </div>

            <div className="flex flex-wrap gap-x-6 gap-y-2 border-t border-line-soft pt-4">
              <label className="flex items-center gap-2 text-[13px] text-ink-2">
                <input
                  type="checkbox"
                  name="canParallel"
                  defaultChecked={activeView.canParallel}
                  className="h-3.5 w-3.5 accent-[var(--color-green)]"
                />
                Can parallel
              </label>
              <label className="flex items-center gap-2 text-[13px] text-ink-2">
                <input
                  type="checkbox"
                  name="spikeNeeded"
                  defaultChecked={activeView.spikeNeeded}
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

      <section className="mt-8 max-w-3xl">
        <Heading>Dependencies</Heading>
        <Card className="mt-2">
          <CardBody className="p-4 sm:p-5">
            <DependencyEditor
              presetId={id}
              adjacency={Object.fromEntries(graph.edges)}
              nodes={[...graph.nodes.values()].map((n) => ({
                presetId: n.presetId,
                code: n.code,
                name: n.name,
                devHours: n.devHours,
              }))}
              notes={Object.fromEntries(graph.notes)}
            />
          </CardBody>
        </Card>
      </section>

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
                  <th className="eyebrow px-4 py-2.5 text-right font-bold">Dev</th>
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
                      {v.anchor?.devHours ?? 0}h
                      <span className="ml-1.5 text-[10.5px] text-ink-4">
                        {sidesLabel(v.anchor?.touchesBackend ?? false, v.anchor?.touchesFrontend ?? false)}
                      </span>
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
