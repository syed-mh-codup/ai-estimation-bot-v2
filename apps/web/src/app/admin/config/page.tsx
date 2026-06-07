import { revalidatePath } from 'next/cache';
import { prisma } from '@repo/db';
import { requireAdmin } from '@/lib/rbac';

function parseJsonField(value: FormDataEntryValue | null): object | null {
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === 'object' && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

async function saveConfig(formData: FormData) {
  'use server';
  await requireAdmin();

  const pm = Number(formData.get('pmCommunicationTaxPct'));
  const ba = Number(formData.get('baCommunicationTaxPct'));
  const qa = Number(formData.get('qaRegressionBufferPct'));
  const complexityRules = parseJsonField(formData.get('complexityRules'));
  const infraBaseline = parseJsonField(formData.get('infraBaseline'));

  // Reject invalid input rather than persisting a broken config version.
  if (
    [pm, ba, qa].some((n) => Number.isNaN(n)) ||
    complexityRules === null ||
    infraBaseline === null
  ) {
    return;
  }

  const last = await prisma.estimationConfig.findFirst({
    orderBy: { version: 'desc' },
    select: { version: true },
  });
  const nextVersion = (last?.version ?? 0) + 1;

  // Transaction preserves the single-active invariant: deactivate all, then
  // create the new active version atomically.
  await prisma.$transaction([
    prisma.estimationConfig.updateMany({ where: { active: true }, data: { active: false } }),
    prisma.estimationConfig.create({
      data: {
        version: nextVersion,
        active: true,
        pmCommunicationTaxPct: pm,
        baCommunicationTaxPct: ba,
        qaRegressionBufferPct: qa,
        complexityRules,
        infraBaseline,
        changeReason: 'edited via admin',
      },
    }),
  ]);

  revalidatePath('/admin/config');
}

export default async function ConfigAdminPage() {
  const config = await prisma.estimationConfig.findFirst({
    where: { active: true },
    orderBy: { version: 'desc' },
  });

  if (!config) {
    return (
      <div data-testid="admin-config">
        <h1 className="text-2xl font-semibold text-gray-900">Config</h1>
        <p className="mt-2 text-gray-600">No active configuration. Run the seed first.</p>
      </div>
    );
  }

  return (
    <div data-testid="admin-config">
      <div className="flex items-center gap-3">
        <h1 className="text-2xl font-semibold text-gray-900">Estimation Config</h1>
        <span
          className="rounded-full bg-indigo-100 px-2 py-0.5 text-xs font-medium text-indigo-800"
          data-testid="config-version"
        >
          v{config.version}
        </span>
      </div>
      <p className="mt-1 text-sm text-gray-500">
        Saving creates a new active version (the previous one is retained, deactivated).
      </p>

      <form action={saveConfig} className="mt-6 max-w-2xl space-y-4">
        <div className="grid grid-cols-3 gap-4">
          <div>
            <label
              htmlFor="pmCommunicationTaxPct"
              className="block text-sm font-medium text-gray-700"
            >
              PM comms tax %
            </label>
            <input
              id="pmCommunicationTaxPct"
              name="pmCommunicationTaxPct"
              type="number"
              step="0.1"
              defaultValue={config.pmCommunicationTaxPct}
              className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-gray-500 focus:outline-none"
            />
          </div>
          <div>
            <label
              htmlFor="baCommunicationTaxPct"
              className="block text-sm font-medium text-gray-700"
            >
              BA comms tax %
            </label>
            <input
              id="baCommunicationTaxPct"
              name="baCommunicationTaxPct"
              type="number"
              step="0.1"
              defaultValue={config.baCommunicationTaxPct}
              className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-gray-500 focus:outline-none"
            />
          </div>
          <div>
            <label
              htmlFor="qaRegressionBufferPct"
              className="block text-sm font-medium text-gray-700"
            >
              QA regression buffer %
            </label>
            <input
              id="qaRegressionBufferPct"
              name="qaRegressionBufferPct"
              type="number"
              step="0.1"
              defaultValue={config.qaRegressionBufferPct}
              className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-gray-500 focus:outline-none"
            />
          </div>
        </div>

        <div>
          <label htmlFor="complexityRules" className="block text-sm font-medium text-gray-700">
            Complexity rules (JSON)
          </label>
          <textarea
            id="complexityRules"
            name="complexityRules"
            rows={5}
            defaultValue={JSON.stringify(config.complexityRules, null, 2)}
            className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 font-mono text-xs focus:border-gray-500 focus:outline-none"
          />
        </div>
        <div>
          <label htmlFor="infraBaseline" className="block text-sm font-medium text-gray-700">
            Infra baseline (JSON)
          </label>
          <textarea
            id="infraBaseline"
            name="infraBaseline"
            rows={4}
            defaultValue={JSON.stringify(config.infraBaseline, null, 2)}
            className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 font-mono text-xs focus:border-gray-500 focus:outline-none"
          />
        </div>

        <button
          type="submit"
          className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700"
          data-testid="save-config"
        >
          Save new version
        </button>
      </form>
    </div>
  );
}
