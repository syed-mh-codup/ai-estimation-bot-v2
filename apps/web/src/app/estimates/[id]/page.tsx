import Link from 'next/link';
import { revalidatePath } from 'next/cache';
import { notFound, redirect } from 'next/navigation';
import { prisma } from '@repo/db';
import { StubSheetsProvider } from '@repo/providers';
import { exportToSheets } from '@repo/agents';
import type { MenuItem as MenuItemDTO } from '@repo/shared';
import { auth } from '@/lib/auth';
import { RunControls } from './RunControls';

const ROLES = ['DEV', 'QA', 'PM', 'BA'] as const;
type Role = (typeof ROLES)[number];

async function requireSession() {
  const session = await auth();
  if (!session?.user) redirect('/login');
}

/** Tax % per role from the active config (DEV is untaxed). */
async function taxPercents(): Promise<Record<Role, number>> {
  const cfg = await prisma.estimationConfig.findFirst({
    where: { active: true },
    orderBy: { version: 'desc' },
  });
  return {
    DEV: 0,
    QA: cfg?.qaRegressionBufferPct ?? 0,
    PM: cfg?.pmCommunicationTaxPct ?? 0,
    BA: cfg?.baCommunicationTaxPct ?? 0,
  };
}

async function toggleItem(formData: FormData) {
  'use server';
  await requireSession();
  const estimateId = formData.get('estimateId');
  const menuItemId = formData.get('menuItemId');
  const enabled = formData.get('enabled') === 'true';
  if (typeof estimateId !== 'string' || typeof menuItemId !== 'string') return;
  await prisma.menuItem.update({ where: { id: menuItemId }, data: { enabled } });
  revalidatePath(`/estimates/${estimateId}`);
}

async function saveItemHours(formData: FormData) {
  'use server';
  await requireSession();
  const estimateId = formData.get('estimateId');
  const menuItemId = formData.get('menuItemId');
  if (typeof estimateId !== 'string' || typeof menuItemId !== 'string') return;

  const pct = await taxPercents();
  for (const role of ROLES) {
    const raw = formData.get(`base-${role}`);
    if (raw == null) continue;
    const baseHours = Math.max(0, Math.round(Number(raw)) || 0);
    const taxedHours = Math.round(baseHours * (1 + pct[role] / 100));
    await prisma.roleLineItem.updateMany({
      where: { menuItemId, role },
      data: { baseHours, taxedHours, edited: true },
    });
  }
  revalidatePath(`/estimates/${estimateId}`);
}

async function exportSheetsAction(formData: FormData) {
  'use server';
  await requireSession();
  const id = formData.get('id');
  if (typeof id !== 'string') return;
  const estimate = await prisma.estimate.findUnique({
    where: { id },
    include: { menuItems: { include: { lineItems: true } } },
  });
  if (!estimate) return;

  const items: MenuItemDTO[] = estimate.menuItems.map((m) => ({
    id: m.id,
    taxonomyKey: m.taxonomyKey,
    title: m.title,
    enabled: m.enabled,
    sourcePresetId: m.sourcePresetId ?? undefined,
    matchScore: m.matchScore ?? undefined,
    parentItemId: m.parentItemId ?? undefined,
    lineItems: m.lineItems.map((li) => ({
      role: li.role,
      baseHours: li.baseHours,
      taxedHours: li.taxedHours,
      notes: li.notes ?? undefined,
      edited: li.edited,
    })),
  }));

  // Sheets provider is a BLOCKED-CREDENTIAL stub: returns a synthetic URL until
  // GOOGLE_SERVICE_ACCOUNT_JSON is configured.
  const result = await exportToSheets(id, estimate.title, items, new StubSheetsProvider());
  await prisma.estimate.update({ where: { id }, data: { sheetUrl: result.url } });
  revalidatePath(`/estimates/${id}`);
}

async function finaliseAction(formData: FormData) {
  'use server';
  await requireSession();
  const id = formData.get('id');
  if (typeof id !== 'string') return;
  // Status -> FINALISED. (Promoting menu items into the preset corpus needs
  // embeddings, which are credit-gated; see writeback.ts for that path.)
  await prisma.estimate.update({ where: { id }, data: { status: 'FINALISED' } });
  revalidatePath(`/estimates/${id}`);
}

export default async function EstimateDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requireSession();
  const { id } = await params;
  const estimate = await prisma.estimate.findUnique({
    where: { id },
    include: {
      owner: { select: { email: true } },
      menuItems: { include: { lineItems: true }, orderBy: { id: 'asc' } },
    },
  });
  if (!estimate) notFound();

  const hours = (itemId: string, role: Role) =>
    estimate.menuItems.find((m) => m.id === itemId)?.lineItems.find((l) => l.role === role);

  // Roll-up (enabled items only).
  const roleTotals: Record<Role, number> = { DEV: 0, QA: 0, PM: 0, BA: 0 };
  let grandTotal = 0;
  for (const item of estimate.menuItems) {
    if (!item.enabled) continue;
    for (const li of item.lineItems) {
      if ((ROLES as readonly string[]).includes(li.role)) {
        roleTotals[li.role as Role] += li.taxedHours;
        grandTotal += li.taxedHours;
      }
    }
  }

  const editedItems = estimate.menuItems.filter((m) => m.lineItems.some((li) => li.edited));
  const isFinalised = estimate.status === 'FINALISED';

  return (
    <div data-testid="estimate-detail">
      <Link href="/dashboard" className="text-sm text-gray-500 hover:underline">
        &larr; Back to estimates
      </Link>

      <div className="mt-2 flex items-center gap-3">
        <h1 className="text-2xl font-semibold text-gray-900">{estimate.title}</h1>
        <span
          className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-700"
          data-testid="estimate-status"
        >
          {estimate.status}
        </span>
        {estimate.complexityScore != null && (
          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">
            complexity {estimate.complexityScore}/5
          </span>
        )}
      </div>
      <p className="mt-1 text-sm text-gray-500">
        Owner: {estimate.owner.email} · Created {new Date(estimate.createdAt).toLocaleString()} ·
        Config v{estimate.configVersion}
      </p>

      <div className="mt-4 flex flex-wrap items-start gap-2">
        <RunControls
          estimateId={estimate.id}
          hasMenu={estimate.menuItems.length > 0}
          initial={{
            status: estimate.runStatus,
            stage: estimate.runStage,
            pct: estimate.runPct,
            error: estimate.runError,
          }}
        />
        {estimate.menuItems.length > 0 && (
          <>
            <form action={exportSheetsAction}>
              <input type="hidden" name="id" value={estimate.id} />
              <button
                type="submit"
                className="rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
                data-testid="export-sheets"
              >
                Export to Sheets
              </button>
            </form>
            {!isFinalised && (
              <form action={finaliseAction}>
                <input type="hidden" name="id" value={estimate.id} />
                <button
                  type="submit"
                  className="rounded-md bg-green-700 px-4 py-2 text-sm font-medium text-white hover:bg-green-800"
                  data-testid="finalise-estimate"
                >
                  Finalise
                </button>
              </form>
            )}
          </>
        )}
      </div>

      {estimate.sheetUrl && (
        <p className="mt-3 text-sm">
          <a
            href={estimate.sheetUrl}
            target="_blank"
            rel="noreferrer"
            className="text-indigo-700 hover:underline"
            data-testid="sheet-link"
          >
            Open exported spreadsheet ↗
          </a>
        </p>
      )}

      <section className="mt-6">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500">
          Statement of Work
        </h2>
        <p className="mt-2 whitespace-pre-wrap rounded-md border border-gray-200 bg-white p-4 text-sm text-gray-800">
          {estimate.sowText}
        </p>
      </section>

      {estimate.narrative.length > 0 && (
        <Panel title="Narrative" items={estimate.narrative} />
      )}
      {estimate.assumptions.length > 0 && (
        <Panel title="Assumptions" items={estimate.assumptions} />
      )}

      {estimate.menuItems.length === 0 ? (
        <p className="mt-6 text-sm text-gray-500" data-testid="estimate-not-run">
          This estimate has not been run yet — click “Run estimate” to generate a Menu Card.
        </p>
      ) : (
        <section className="mt-6">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500">
              Menu Card
            </h2>
            <div className="text-sm text-gray-600" data-testid="rollup-totals">
              {ROLES.map((r) => (
                <span key={r} className="ml-3" data-testid={`total-${r}`}>
                  {r} {roleTotals[r]}
                </span>
              ))}
              <span className="ml-3 font-semibold text-gray-900" data-testid="total-all">
                Total {grandTotal}h
              </span>
            </div>
          </div>

          <div className="mt-3 space-y-3">
            {estimate.menuItems.map((item) => {
              const itemTaxed = item.lineItems.reduce((s, li) => s + li.taxedHours, 0);
              return (
                <div
                  key={item.id}
                  data-testid={`menu-item-${item.id}`}
                  className={`rounded-md border p-3 ${
                    item.enabled ? 'border-gray-200 bg-white' : 'border-gray-200 bg-gray-50 opacity-60'
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <div className={item.parentItemId ? 'pl-4' : ''}>
                      {item.parentItemId && <span className="text-gray-400">└ </span>}
                      <span className="font-medium text-gray-900">{item.title}</span>
                      <span className="ml-2 text-xs text-gray-400">{item.taxonomyKey}</span>
                      <span className="ml-2 text-xs text-gray-500" data-testid={`item-total-${item.id}`}>
                        {itemTaxed}h
                      </span>
                    </div>
                    <form action={toggleItem}>
                      <input type="hidden" name="estimateId" value={estimate.id} />
                      <input type="hidden" name="menuItemId" value={item.id} />
                      <input type="hidden" name="enabled" value={(!item.enabled).toString()} />
                      <button
                        type="submit"
                        disabled={isFinalised}
                        className="rounded-md border border-gray-300 px-3 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-40"
                        data-testid={`toggle-item-${item.id}`}
                      >
                        {item.enabled ? 'Disable' : 'Enable'}
                      </button>
                    </form>
                  </div>

                  <form action={saveItemHours} className="mt-3 flex flex-wrap items-end gap-3">
                    <input type="hidden" name="estimateId" value={estimate.id} />
                    <input type="hidden" name="menuItemId" value={item.id} />
                    {ROLES.map((r) => {
                      const li = hours(item.id, r);
                      return (
                        <label key={r} className="text-xs text-gray-600">
                          <span className="mr-1">
                            {r}
                            {li?.edited ? ' *' : ''}
                          </span>
                          <input
                            name={`base-${r}`}
                            type="number"
                            defaultValue={li?.baseHours ?? 0}
                            disabled={isFinalised}
                            data-testid={`base-${r}-${item.id}`}
                            className="w-16 rounded-md border border-gray-300 px-2 py-1 text-sm disabled:opacity-40"
                          />
                          <span className="ml-1 text-gray-400" data-testid={`taxed-${r}-${item.id}`}>
                            → {li?.taxedHours ?? 0}h
                          </span>
                        </label>
                      );
                    })}
                    <button
                      type="submit"
                      disabled={isFinalised}
                      className="rounded-md border border-gray-300 px-3 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-40"
                      data-testid={`save-item-${item.id}`}
                    >
                      Save hours
                    </button>
                  </form>
                </div>
              );
            })}
          </div>

          {editedItems.length > 0 && (
            <div className="mt-6" data-testid="change-log">
              <h3 className="text-sm font-semibold uppercase tracking-wide text-gray-500">
                Change log
              </h3>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-gray-700">
                {editedItems.map((m) => (
                  <li key={m.id}>Manually adjusted hours: {m.title}</li>
                ))}
              </ul>
            </div>
          )}
        </section>
      )}
    </div>
  );
}

function Panel({ title, items }: { title: string; items: string[] }) {
  return (
    <section className="mt-6">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500">{title}</h2>
      <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-gray-800">
        {items.map((t, i) => (
          <li key={i}>{t}</li>
        ))}
      </ul>
    </section>
  );
}
