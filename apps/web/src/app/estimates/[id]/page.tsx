import Link from 'next/link';
import { revalidatePath } from 'next/cache';
import { notFound, redirect } from 'next/navigation';
import { prisma } from '@repo/db';
import { createSheetsProvider } from '@repo/providers';
import { exportToSheets } from '@repo/agents';
import type { MenuItem as MenuItemDTO } from '@repo/shared';
import { auth } from '@/lib/auth';
import { CollapsibleSection } from '@/components/ui/collapsible-section';
import { RunControls } from './RunControls';
import { MenuCardEditor } from './MenuCardEditor';
import type { ItemDTO, SectionDTO } from './actions';

type Role = 'DEV' | 'QA' | 'PM' | 'BA';

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
    requirementIds: [],
    toggleable: true,
    notSafelyRemovable: false,
    thinSlice: false,
    lineItems: m.lineItems.map((li) => ({
      role: li.role,
      title: li.title ?? undefined,
      baseHours: li.baseHours,
      taxedHours: li.taxedHours,
      notes: li.notes ?? undefined,
      edited: li.edited,
      aiAssistApplied: false,
      dependsOn: [],
      anchorPresetIds: [],
    })),
  }));

  // Falls back to a synthetic-URL stub when GOOGLE_SERVICE_ACCOUNT_JSON /
  // GOOGLE_DRIVE_FOLDER_ID aren't configured for this environment.
  const result = await exportToSheets(id, estimate.title, items, createSheetsProvider());
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
      sections: { orderBy: { order: 'asc' } },
      menuItems: {
        include: { lineItems: true },
        orderBy: [{ order: 'asc' }, { id: 'asc' }],
      },
    },
  });
  if (!estimate) notFound();

  const isFinalised = estimate.status === 'FINALISED';
  const pct = await taxPercents();

  const sectionDTOs: SectionDTO[] = estimate.sections.map((s) => ({
    id: s.id,
    title: s.title,
    order: s.order,
  }));
  const itemDTOs: ItemDTO[] = estimate.menuItems.map((m) => ({
    id: m.id,
    title: m.title,
    enabled: m.enabled,
    taxonomyKey: m.taxonomyKey,
    sectionId: m.sectionId,
    order: m.order,
    lineItems: m.lineItems.map((li) => ({
      id: li.id,
      role: li.role,
      title: li.title,
      baseHours: li.baseHours,
      taxedHours: li.taxedHours,
      edited: li.edited,
    })),
  }));

  // Re-mount the editor when the *structure* changes server-side (a run
  // completing populates the menu card via router.refresh); stays stable during
  // in-session editing so optimistic state isn't blown away.
  const editorKey = `${sectionDTOs.map((s) => s.id).join(',')}|${itemDTOs.map((i) => i.id).join(',')}`;

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

      <CollapsibleSection
        className="mt-6"
        storageKey={`est:${estimate.id}:sow`}
        title="Statement of Work"
        data-testid="section-sow"
      >
        <p className="whitespace-pre-wrap rounded-md border border-gray-200 bg-white p-4 text-sm text-gray-800">
          {estimate.sowText}
        </p>
      </CollapsibleSection>

      {estimate.narrative.length > 0 && (
        <CollapsibleSection
          className="mt-6"
          storageKey={`est:${estimate.id}:narrative`}
          title="Narrative"
          data-testid="section-narrative"
        >
          <List items={estimate.narrative} />
        </CollapsibleSection>
      )}
      {estimate.assumptions.length > 0 && (
        <CollapsibleSection
          className="mt-6"
          storageKey={`est:${estimate.id}:assumptions`}
          title="Assumptions"
          data-testid="section-assumptions"
        >
          <List items={estimate.assumptions} />
        </CollapsibleSection>
      )}

      {estimate.menuItems.length === 0 && estimate.sections.length === 0 && (
        <p className="mt-6 text-sm text-gray-500" data-testid="estimate-not-run">
          This estimate has not been run yet — click “Run estimate” to generate a Menu Card, or build
          one manually below.
        </p>
      )}

      <MenuCardEditor
        key={editorKey}
        estimateId={estimate.id}
        initialSections={sectionDTOs}
        initialItems={itemDTOs}
        taxPercents={pct}
        isFinalised={isFinalised}
      />
    </div>
  );
}

function List({ items }: { items: string[] }) {
  return (
    <ul className="list-disc space-y-1 pl-5 text-sm text-gray-800">
      {items.map((t, i) => (
        <li key={i}>{t}</li>
      ))}
    </ul>
  );
}
