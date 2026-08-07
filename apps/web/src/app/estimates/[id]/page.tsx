import Link from 'next/link';
import { revalidatePath } from 'next/cache';
import { notFound, redirect } from 'next/navigation';
import { prisma } from '@repo/db';
import { createSheetsProvider } from '@repo/providers';
import { exportToSheets } from '@repo/agents';
import type { MenuItem as MenuItemDTO } from '@repo/shared';
import { auth } from '@/lib/auth';
import { CollapsibleSection } from '@/components/ui/collapsible-section';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Button } from '@/components/ui/button';
import { Eyebrow } from '@/components/ui/card';
import { RunControls } from './RunControls';
import { MenuCardEditor } from './MenuCardEditor';
import { EstimateHeader, ComplexityField } from './EstimateHeader';
import { EditableList } from './EditableList';
import { CollapseAllButton } from './CollapseAllButton';
import { LedgerProvider } from './ledger-context';
import { RollupCard } from './RollupCard';
import { ContentsCard } from './ContentsCard';
import { updateNarrative, updateAssumptions, deleteEstimate } from './actions';
import type { ItemDTO, SectionDTO } from './actions';

type Role = 'DEV' | 'QA' | 'PM' | 'BA';

async function requireSession() {
  const session = await auth();
  if (!session?.user) redirect('/login');
  return session.user;
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
      touchesFrontend: li.touchesFrontend,
      touchesBackend: li.touchesBackend,
    })),
  }));

  const result = await exportToSheets(id, estimate.title, items, createSheetsProvider());
  await prisma.estimate.update({ where: { id }, data: { sheetUrl: result.url } });
  revalidatePath(`/estimates/${id}`);
}

async function finaliseAction(formData: FormData) {
  'use server';
  await requireSession();
  const id = formData.get('id');
  if (typeof id !== 'string') return;
  await prisma.estimate.update({ where: { id }, data: { status: 'FINALISED' } });
  revalidatePath(`/estimates/${id}`);
}

async function deleteEstimateAction(formData: FormData) {
  'use server';
  await requireSession();
  const id = formData.get('id');
  if (typeof id !== 'string') return;
  await deleteEstimate(id);
  redirect('/dashboard');
}

export default async function EstimateDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const viewer = await requireSession();
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
  const hasMenu = estimate.menuItems.length > 0;
  // Anyone may open and edit; only the owner or an admin may destroy.
  const canDelete = viewer.role === 'ADMIN' || viewer.id === estimate.ownerId;

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
      touchesFrontend: li.touchesFrontend,
      touchesBackend: li.touchesBackend,
    })),
  }));

  // Remount the client ledger when the server's set of rows changes underneath
  // it (e.g. a run just produced a whole new menu card).
  const editorKey = `${sectionDTOs.map((s) => s.id).join(',')}|${itemDTOs.map((i) => i.id).join(',')}`;

  return (
    <div data-testid="estimate-detail">
      <Link href="/dashboard" className="text-[12.5px] text-ink-3 hover:text-ink hover:underline">
        ← Estimates
      </Link>

      <div className="mt-3">
        <EstimateHeader
          estimateId={estimate.id}
          initialTitle={estimate.title}
          status={estimate.status}
          isFinalised={isFinalised}
        />
      </div>

      <LedgerProvider
        key={editorKey}
        estimateId={estimate.id}
        initialSections={sectionDTOs}
        initialItems={itemDTOs}
        taxPercents={pct}
        isFinalised={isFinalised}
      >
        <div className="mt-5 grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_280px]">
          {/* ── the document ─────────────────────────────────────────────── */}
          <div className="min-w-0">
            <RunControls
              estimateId={estimate.id}
              hasMenu={hasMenu}
              initial={{
                status: estimate.runStatus,
                stage: estimate.runStage,
                pct: estimate.runPct,
                error: estimate.runError,
                startedAt: estimate.runStartedAt?.toISOString() ?? null,
                finishedAt: estimate.runFinishedAt?.toISOString() ?? null,
              }}
            />

            <CollapsibleSection
              className="mt-3.5 scroll-mt-4"
              storageKey={`est:${estimate.id}:sow`}
              title="Statement of work"
              data-testid="section-sow"
            >
              <p className="rounded-md border border-line-soft bg-surface-2 p-3.5 text-[13.5px] leading-relaxed whitespace-pre-wrap text-ink-2">
                {estimate.sowText}
              </p>
            </CollapsibleSection>

            <CollapsibleSection
              className="mt-3.5 scroll-mt-4"
              storageKey={`est:${estimate.id}:narrative`}
              title="Narrative"
              meta={hasMenu ? 'written by the Architect' : undefined}
              data-testid="section-narrative"
            >
              <EditableList
                estimateId={estimate.id}
                initialItems={estimate.narrative}
                action={updateNarrative}
                isFinalised={isFinalised}
                addLabel="Add point"
                testid="narrative-list"
              />
            </CollapsibleSection>

            <CollapsibleSection
              className="mt-3.5 scroll-mt-4"
              storageKey={`est:${estimate.id}:assumptions`}
              title="Assumptions"
              data-testid="section-assumptions"
            >
              <EditableList
                estimateId={estimate.id}
                initialItems={estimate.assumptions}
                action={updateAssumptions}
                isFinalised={isFinalised}
                addLabel="Add assumption"
                testid="assumptions-list"
              />
            </CollapsibleSection>

            {/* The Menu card owns its own empty state — it is the thing that
                holds the "add a section" affordance, and an invitation that
                sits somewhere you cannot act on is just a sign. */}
            <MenuCardEditor estimateId={estimate.id} />
          </div>

          {/* ── the sticky rail: the numbers you're accountable for, and the
                 controls that act on them, never scroll away ──────────────── */}
          <aside className="flex flex-col gap-3.5 lg:sticky lg:top-4 max-lg:order-first">
            {hasMenu && <RollupCard />}

            <div className="rounded-[10px] border border-line bg-surface px-4 py-3.5">
              <Eyebrow>Actions</Eyebrow>
              <div className="mt-2.5 flex flex-col gap-2">
                {/* Nothing to finalise or export until a menu card exists. */}
                {hasMenu && !isFinalised && (
                  <form action={finaliseAction}>
                    <input type="hidden" name="id" value={estimate.id} />
                    <Button type="submit" full data-testid="finalise-estimate">
                      Finalise estimate
                    </Button>
                  </form>
                )}
                {hasMenu && (
                  <form action={exportSheetsAction}>
                    <input type="hidden" name="id" value={estimate.id} />
                    <Button type="submit" variant="outline" full data-testid="export-sheets">
                      Export to Sheets
                    </Button>
                  </form>
                )}
                <CollapseAllButton />
              </div>

              {/* Destructive and rare: it shouldn't carry Export's weight. */}
              {canDelete && (
              <ConfirmDialog
                action={deleteEstimateAction}
                hidden={{ id: estimate.id }}
                title="Delete estimate?"
                description={
                  <>
                    <span className="font-medium text-ink">{estimate.title}</span> and all its menu
                    items, sections and line items will be permanently deleted. This can&rsquo;t be
                    undone.
                  </>
                }
                confirmLabel="Delete estimate"
                trigger={
                  <button
                    type="button"
                    className="mt-3 block w-full border-t border-line-soft pt-2.5 text-center text-xs text-ink-3 hover:text-brick"
                    data-testid="delete-estimate"
                  >
                    Delete estimate
                  </button>
                }
              />
              )}
            </div>

            {hasMenu && <ContentsCard />}

            <div className="rounded-[10px] border border-line bg-surface px-4 py-3.5">
              <Eyebrow>Details</Eyebrow>
              <dl className="mt-2">
                <MetaRow k="Owner" v={estimate.owner.email} />
                <MetaRow k="Created" v={new Date(estimate.createdAt).toLocaleString()} />
                <MetaRow k="Config" v={<span className="num">v{estimate.configVersion}</span>} />
                <MetaRow
                  k="Complexity"
                  v={
                    <ComplexityField
                      estimateId={estimate.id}
                      initialComplexity={estimate.complexityScore}
                      isFinalised={isFinalised}
                    />
                  }
                />
                {estimate.sheetUrl && (
                  <MetaRow
                    k="Sheet"
                    v={
                      <a
                        href={estimate.sheetUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="text-green hover:underline"
                        data-testid="sheet-link"
                      >
                        Open ↗
                      </a>
                    }
                  />
                )}
              </dl>
            </div>
          </aside>
        </div>
      </LedgerProvider>
    </div>
  );
}

function MetaRow({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[62px_1fr] gap-2 py-1 text-[12px]">
      <dt className="text-ink-4">{k}</dt>
      <dd className="break-words text-ink-2">{v}</dd>
    </div>
  );
}
