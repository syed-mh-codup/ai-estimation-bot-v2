import Link from 'next/link';
import { revalidatePath } from 'next/cache';
import { notFound } from 'next/navigation';
import { prisma } from '@repo/db';
import { requireAdmin } from '@/lib/rbac';

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
  // forward from the current active version. (embedding is intentionally left
  // null — it's regenerated when embeddings are backfilled.)
  await prisma.$transaction([
    prisma.presetVersion.updateMany({ where: { presetId, active: true }, data: { active: false } }),
    prisma.presetVersion.create({
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
    }),
  ]);

  revalidatePath(`/admin/presets/${presetId}`);
  revalidatePath('/admin/presets');
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
      <Link href="/admin/presets" className="text-sm text-gray-500 hover:underline">
        &larr; Back to presets
      </Link>
      <div className="mt-2 flex items-center gap-3">
        <h1 className="text-2xl font-semibold text-gray-900">
          {id} · {active.name}
        </h1>
        <span
          className="rounded-full bg-indigo-100 px-2 py-0.5 text-xs font-medium text-indigo-800"
          data-testid="preset-active-version"
        >
          v{active.version}
        </span>
      </div>

      <form action={savePreset} className="mt-6 max-w-3xl space-y-4">
        <input type="hidden" name="presetId" value={id} />
        <div className="grid grid-cols-2 gap-4">
          <Field label="Name" name="name" defaultValue={active.name} />
          <Field label="Category" name="category" defaultValue={active.category} />
          <Field label="Req. type" name="reqType" defaultValue={active.reqType} />
          <NumField label="Integration count" name="integrationCount" defaultValue={active.integrationCount} />
          <NumField label="BE hours" name="beHours" defaultValue={active.beHours} />
          <NumField label="FE hours" name="feHours" defaultValue={active.feHours} />
          <SelectField label="Risk" name="risk" options={LEVELS} defaultValue={active.risk} />
          <SelectField label="AI assist" name="aiAssist" options={LEVELS} defaultValue={active.aiAssist} />
          <SelectField label="Data volume" name="dataVolume" options={DATA_VOLUMES} defaultValue={active.dataVolume} />
          <SelectField label="Phase" name="phase" options={PHASES} defaultValue={active.phase} />
        </div>
        <Field label="Platforms (comma-separated)" name="platforms" defaultValue={active.platforms.join(', ')} />
        <Field label="Keywords (comma-separated)" name="keywords" defaultValue={active.keywords.join(', ')} />
        <div>
          <label className="block text-sm font-medium text-gray-700" htmlFor="description">
            Description
          </label>
          <textarea
            id="description"
            name="description"
            rows={3}
            defaultValue={active.description}
            className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-gray-500 focus:outline-none"
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700" htmlFor="notes">
            Notes / assumptions
          </label>
          <textarea
            id="notes"
            name="notes"
            rows={2}
            defaultValue={active.notes}
            className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-gray-500 focus:outline-none"
          />
        </div>
        <div className="flex gap-6">
          <label className="flex items-center gap-2 text-sm text-gray-700">
            <input type="checkbox" name="canParallel" defaultChecked={active.canParallel} /> Can parallel
          </label>
          <label className="flex items-center gap-2 text-sm text-gray-700">
            <input type="checkbox" name="spikeNeeded" defaultChecked={active.spikeNeeded} /> Spike needed
          </label>
        </div>
        <Field label="Change reason" name="changeReason" defaultValue="" />
        <button
          type="submit"
          className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700"
          data-testid="save-preset"
        >
          Save new version
        </button>
      </form>

      {diff.length > 0 && (
        <section className="mt-8">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500">
            Changes vs v{previous!.version}
          </h2>
          <ul className="mt-2 space-y-1 text-sm" data-testid="preset-diff">
            {diff.map((d) => (
              <li key={d.field}>
                <span className="font-medium text-gray-700">{d.field}:</span>{' '}
                <span className="text-red-600 line-through">{d.from || '∅'}</span>{' '}
                <span className="text-gray-400">→</span>{' '}
                <span className="text-green-700">{d.to || '∅'}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="mt-8">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500">
          Version history
        </h2>
        <table className="mt-2 w-full border-collapse text-sm" data-testid="preset-history">
          <thead>
            <tr className="border-b border-gray-200 text-left text-gray-500">
              <th className="py-2 font-medium">Version</th>
              <th className="py-2 text-right font-medium">BE/FE</th>
              <th className="py-2 font-medium">Status</th>
              <th className="py-2 font-medium">Reason</th>
              <th className="py-2 font-medium">Created</th>
            </tr>
          </thead>
          <tbody>
            {versions.map((v) => (
              <tr key={v.id} className="border-b border-gray-100" data-testid={`preset-version-${v.version}`}>
                <td className="py-2 text-gray-900">v{v.version}</td>
                <td className="py-2 text-right text-gray-600">
                  {v.beHours}/{v.feHours}h
                </td>
                <td className="py-2">
                  {v.active ? (
                    <span className="text-green-700">active</span>
                  ) : (
                    <span className="text-gray-400">inactive</span>
                  )}
                </td>
                <td className="py-2 text-gray-500">{v.changeReason ?? '—'}</td>
                <td className="py-2 text-gray-500">{new Date(v.createdAt).toLocaleDateString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}

function Field({ label, name, defaultValue }: { label: string; name: string; defaultValue: string }) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700" htmlFor={name}>
        {label}
      </label>
      <input
        id={name}
        name={name}
        defaultValue={defaultValue}
        className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-gray-500 focus:outline-none"
      />
    </div>
  );
}

function NumField({ label, name, defaultValue }: { label: string; name: string; defaultValue: number }) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700" htmlFor={name}>
        {label}
      </label>
      <input
        id={name}
        name={name}
        type="number"
        defaultValue={defaultValue}
        className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-gray-500 focus:outline-none"
      />
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
      <label className="block text-sm font-medium text-gray-700" htmlFor={name}>
        {label}
      </label>
      <select
        id={name}
        name={name}
        defaultValue={defaultValue}
        className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-gray-500 focus:outline-none"
      >
        {options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    </div>
  );
}
