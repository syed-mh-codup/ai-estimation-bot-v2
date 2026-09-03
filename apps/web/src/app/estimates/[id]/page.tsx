import Link from 'next/link';
import { revalidatePath } from 'next/cache';
import { after } from 'next/server';
import { notFound, redirect } from 'next/navigation';
import { prisma, toMenuItem } from '@repo/db';
import { createSheetsProvider } from '@repo/providers';
import { exportToSheets } from '@repo/agents';
import type { MenuItem as MenuItemDTO } from '@repo/shared';
import { auth } from '@/lib/auth';
import { inngest, EVENT_PROMOTE } from '@/lib/inngest';
import { CollapsibleSection } from '@/components/ui/collapsible-section';
import { SowText } from './SowText';
import { Oracle } from './Oracle';
import { OracleAdminPanel } from './OracleAdminPanel';
import { ModelUsagePanel } from './ModelUsagePanel';
import { listOracleThreads } from './oracle-actions';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Button } from '@/components/ui/button';
import { Eyebrow } from '@/components/ui/card';
import { RunControls } from './RunControls';
import { MenuCardEditor } from './MenuCardEditor';
import { EstimateHeader, ComplexityField } from './EstimateHeader';
import { CustodianField, DueDateField } from './CustodyFields';
import type { CustodianOption } from './CustodyFields';
import { dueLabel, toDateInputValue } from '@/lib/due-date';
import { EditableList } from './EditableList';
import { CollapseAllButton } from './CollapseAllButton';
import { LedgerProvider } from './ledger-context';
import { RollupCard } from './RollupCard';
import { HiddenWorkPanel } from './HiddenWorkPanel';
import { RunDiagnosticsPanel } from './RunDiagnosticsPanel';
import { ContentsCard } from './ContentsCard';
import { ArtifactsPanel } from './ArtifactsPanel';
import { updateNarrative, updateAssumptions, deleteEstimate } from './actions';
import { ExportSheets } from './ExportSheets';
import type { ExportOutcome } from './export-interaction';
import { cardFlags, lineEnvelope } from './dto';
import type { ItemDTO, SectionDTO } from './dto';

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

/**
 * AEH-316: returns its outcome instead of throwing. A throw from a server
 * action surfaces as a bare "Application error: a server-side exception has
 * occurred" page, which is how the AEH-232 quota failure managed to look like
 * a site outage rather than a failed button.
 */
async function exportSheetsAction(id: string): Promise<ExportOutcome> {
  'use server';
  await requireSession();
  const estimate = await prisma.estimate.findUnique({
    where: { id },
    include: { menuItems: { include: { lineItems: true } } },
  });
  if (!estimate) return { ok: false, error: 'That estimate no longer exists.' };

  try {
    // toMenuItem parses strictly (AEH-227), so a bad row throws here rather
    // than inside Google's API — and that is worth telling the user apart.
    const items: MenuItemDTO[] = estimate.menuItems.map(toMenuItem);

    const result = await exportToSheets(id, estimate.title, items, createSheetsProvider());
    await prisma.estimate.update({ where: { id }, data: { sheetUrl: result.url } });
    revalidatePath(`/estimates/${id}`);
    return { ok: true, url: result.url };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'The export failed for an unknown reason.',
    };
  }
}

async function finaliseAction(formData: FormData) {
  'use server';
  await requireSession();
  const id = formData.get('id');
  if (typeof id !== 'string') return;

  // The disabled button is a courtesy; this is the gate. A server action is
  // reachable without the page that rendered it, and finalising is irreversible
  // here — it locks every edit and feeds the estimate to the preset library.
  const gate = await prisma.estimationConfig.findFirst({
    where: { active: true },
    orderBy: { version: 'desc' },
    select: { hiddenWorkBlocksFinalise: true },
  });
  if (gate?.hiddenWorkBlocksFinalise) {
    const open = await prisma.hiddenWorkFinding.count({
      where: { estimateId: id, outcome: 'OPEN' },
    });
    if (open > 0) return;
  }

  await prisma.estimate.update({ where: { id }, data: { status: 'FINALISED' } });
  revalidatePath(`/estimates/${id}`);

  // Feed the finalised estimate back into the preset library. Out of band and
  // after the response: promotion writes many rows and then spends money
  // embedding them, and the Inngest SDK retries a failed send with backoff —
  // neither belongs in the click that finalises an estimate.
  //
  // Best-effort by design. Finalising has already committed; if the event bus
  // is down the estimate is still finalised and the library just doesn't learn
  // from it yet. Promotion is idempotent (keyed on sourceEstimateId), so
  // re-finalising or replaying the event is safe.
  after(async () => {
    try {
      await inngest.send({ name: EVENT_PROMOTE, data: { estimateId: id } });
    } catch (err) {
      console.error(`[presets] could not queue promotion for estimate ${id}:`, err);
    }
  });
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
      custodian: { select: { id: true, email: true, name: true, disabledAt: true } },
      // Newest first: the rail shows the last nudge that went out, which is the
      // one that answers "did anybody actually get told".
      reminders: { orderBy: { sentAt: 'desc' }, take: 1 },
      sections: { orderBy: { order: 'asc' } },
      menuItems: {
        include: { lineItems: true },
        orderBy: [{ order: 'asc' }, { id: 'asc' }],
      },
    },
  });
  if (!estimate) notFound();

  const isFinalised = estimate.status === 'FINALISED';
  // The gate. Warn or block is an admin switch, not a hardcoded stance: a
  // blocking gate is only as good as the Detective's precision, and nobody has
  // watched this stage run against real SOWs yet.
  const [openHiddenWork, gateConfig] = await Promise.all([
    prisma.hiddenWorkFinding.count({ where: { estimateId: id, outcome: 'OPEN' } }),
    prisma.estimationConfig.findFirst({
      where: { active: true },
      orderBy: { version: 'desc' },
      select: { hiddenWorkBlocksFinalise: true },
    }),
  ]);
  const finaliseBlocked = (gateConfig?.hiddenWorkBlocksFinalise ?? false) && openHiddenWork > 0;
  const pct = await taxPercents();
  const hasMenu = estimate.menuItems.length > 0;
  // Anyone may open and edit; only the owner or an admin may destroy.
  const canDelete = viewer.role === 'ADMIN' || viewer.id === estimate.ownerId;
  // The viewer's own threads on this estimate. Nobody else's — a thread is
  // private to whoever wrote it (lib/oracle-access.ts).
  const oracleThreads = await listOracleThreads(estimate.id);

  // Disabled accounts are left out: custody handed to somebody who cannot sign
  // in is custody nobody holds. `setCustodian` re-checks server-side, and the
  // sweep falls back to the owner for anyone disabled after being named.
  const custodianOptions: CustodianOption[] = (
    await prisma.user.findMany({
      where: { disabledAt: null },
      orderBy: { email: 'asc' },
      select: { id: true, email: true, name: true },
    })
  ).map((u) => ({ id: u.id, label: userLabel(u) }));

  // A custodian who has since been disabled still has to appear, or the field
  // would quietly read "Unassigned" for an estimate that plainly has somebody
  // on it — and the first save would make that lie true. Same principle as the
  // Combobox's: the stored value is always selectable.
  if (estimate.custodian?.disabledAt) {
    custodianOptions.unshift({
      id: estimate.custodian.id,
      label: `${userLabel(estimate.custodian)} — disabled`,
    });
  }

  // One clock for the whole render, so the rail and its relative label cannot
  // disagree about what day it is.
  const now = new Date();
  const lastReminder = estimate.reminders[0];

  const sectionDTOs: SectionDTO[] = estimate.sections.map((s) => ({
    id: s.id,
    title: s.title,
    order: s.order,
  }));
  const itemDTOs: ItemDTO[] = estimate.menuItems.map((m) => ({
    id: m.id,
    title: m.title,
    enabled: m.enabled,
    injected: m.injected,
    taxonomyKey: m.taxonomyKey,
    sectionId: m.sectionId,
    order: m.order,
    category: m.category,
    phase: m.phase,
    sourcePresetId: m.sourcePresetId,
    matchScore: m.matchScore,
    flags: cardFlags(m.meta),
    lineItems: m.lineItems.map((li) => ({
      id: li.id,
      role: li.role,
      title: li.title,
      baseHours: li.baseHours,
      taxedHours: li.taxedHours,
      edited: li.edited,
      touchesFrontend: li.touchesFrontend,
      touchesBackend: li.touchesBackend,
      envelope: lineEnvelope(li.meta),
    })),
  }));

  // Remount the client ledger when the server's set of rows changes underneath
  // it (e.g. a run just produced a whole new menu card).
  const editorKey = `${sectionDTOs.map((s) => s.id).join(',')}|${itemDTOs.map((i) => i.id).join(',')}`;

  // Artifacts. Archived types are excluded — `enabled` is what takes a type out
  // of circulation without breaking the documents already generated from it.
  const artifactTypes = (
    await prisma.artifactType.findMany({
      where: { enabled: true },
      orderBy: [{ order: 'asc' }, { createdAt: 'asc' }],
      select: { key: true, name: true },
    })
  ).map((t) => ({ key: t.key, name: t.name }));

  // Never `content`: an assembled document is ~100KB and this is the estimate
  // screen, which already loads a great deal.
  const artifactRows = (
    await prisma.estimateArtifact.findMany({
      where: { estimateId: estimate.id },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        title: true,
        status: true,
        stage: true,
        pct: true,
        error: true,
        artifactType: { select: { name: true } },
        _count: { select: { sections: true } },
      },
    })
  ).map((a) => ({
    id: a.id,
    title: a.title,
    typeName: a.artifactType.name,
    status: a.status,
    stage: a.stage,
    pct: a.pct,
    error: a.error,
    sectionsWritten: a._count.sections,
  }));

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
              id="sow"
              className="mt-3.5 scroll-mt-4"
              storageKey={`est:${estimate.id}:sow`}
              title="Statement of work"
              data-testid="section-sow"
            >
              <SowText sowText={estimate.sowText} />
            </CollapsibleSection>

            <CollapsibleSection
              id="narrative"
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
                askSubject="narrative line"
              />
            </CollapsibleSection>

            <CollapsibleSection
              id="assumptions"
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
                askSubject="assumption"
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
            {/* A planning view, not an edit of this estimate — see
                scope/page.tsx. Offered whenever there is a menu card, because
                "there is no graph yet" is a better answer on that screen than a
                missing link here. */}
            {hasMenu && (
              <div className="rounded-[10px] border border-line bg-surface px-4 py-3.5">
                <Eyebrow>Configure scope</Eyebrow>
                <p className="mt-1.5 text-[11.5px] leading-snug text-ink-4">
                  Shape what is in scope with dependencies resolved automatically. Does not change
                  this estimate.
                </p>
                <Link
                  href={`/estimates/${estimate.id}/scope`}
                  data-testid="open-scope-configurator"
                  className="mt-2 inline-block text-[12.5px] text-green hover:underline"
                >
                  Open configurator →
                </Link>
              </div>
            )}
            <HiddenWorkPanel estimateId={estimate.id} isFinalised={isFinalised} />
            <ArtifactsPanel
              estimateId={estimate.id}
              types={artifactTypes}
              initial={artifactRows}
            />
            <RunDiagnosticsPanel estimateId={estimate.id} />
            {viewer.role === 'ADMIN' && <OracleAdminPanel estimateId={estimate.id} />}
            {viewer.role === 'ADMIN' && <ModelUsagePanel estimateId={estimate.id} />}

            <div className="rounded-[10px] border border-line bg-surface px-4 py-3.5">
              <Eyebrow>Actions</Eyebrow>
              <div className="mt-2.5 flex flex-col gap-2">
                {/* Nothing to finalise or export until a menu card exists. */}
                {hasMenu && !isFinalised && (
                  <form action={finaliseAction}>
                    <input type="hidden" name="id" value={estimate.id} />
                    <Button
                      type="submit"
                      full
                      disabled={finaliseBlocked}
                      data-testid="finalise-estimate"
                    >
                      Finalise estimate
                    </Button>
                    {openHiddenWork > 0 && (
                      // Says the same thing either way; only the button changes.
                      // Naming the count beats a generic warning — the estimator
                      // can see whether it is one loose end or ten.
                      <p
                        className="mt-1.5 text-[11.5px] leading-snug text-bronze-ink"
                        data-testid="finalise-hidden-work-note"
                      >
                        {finaliseBlocked ? 'Resolve ' : 'Still open: '}
                        <span className="num">{openHiddenWork}</span> flagged risk
                        {openHiddenWork === 1 ? '' : 's'}
                        {finaliseBlocked ? ' first.' : '.'}
                      </p>
                    )}
                  </form>
                )}
                {hasMenu && (
                  <ExportSheets
                    estimateId={estimate.id}
                    initialSheetUrl={estimate.sheetUrl}
                    action={exportSheetsAction}
                  />
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
                <MetaRow
                  k="Custodian"
                  v={
                    <CustodianField
                      estimateId={estimate.id}
                      initialCustodianId={estimate.custodianId}
                      options={custodianOptions}
                      isFinalised={isFinalised}
                    />
                  }
                />
                <MetaRow
                  k="Due"
                  v={
                    <DueDateField
                      estimateId={estimate.id}
                      initialDueAt={toDateInputValue(estimate.dueAt)}
                      relativeLabel={estimate.dueAt ? dueLabel(estimate.dueAt, now) : null}
                      isFinalised={isFinalised}
                    />
                  }
                />
                {/* Only once something has actually gone out. Silence about a
                    reminder nobody sent is worse than no row at all — this is
                    the line that answers "why did nobody hear about this". */}
                {lastReminder && (
                  <MetaRow
                    k="Nudged"
                    v={
                      <span data-testid="last-reminder">
                        {REMINDER_LABEL[lastReminder.kind]} — {lastReminder.sentTo}
                        <span className="text-ink-4">
                          {' '}
                          on {lastReminder.sentAt.toLocaleDateString()}
                          {lastReminder.delivered ? '' : ' (not delivered — email is off)'}
                        </span>
                      </span>
                    }
                  />
                )}
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

      {/* Outside LedgerProvider on purpose: that provider is keyed on the row
          set and remounts its whole subtree on router.refresh(), which fires
          the moment a run finishes. A conversation inside it would be wiped at
          exactly the point somebody is asking about the results. Entry points
          within the ledger reach Oracle through the window-event bus. */}
      <Oracle estimateId={estimate.id} initialThreads={oracleThreads} />
    </div>
  );
}

/** Name plus address when we have a name, address alone when we don't. */
function userLabel(u: { email: string; name: string | null }): string {
  return u.name ? `${u.name} (${u.email})` : u.email;
}

/** How each reminder beat reads in the rail. */
const REMINDER_LABEL: Record<string, string> = {
  DUE_SOON: 'Heads-up',
  DUE_TODAY: 'Due today',
  OVERDUE: 'Overdue',
};

function MetaRow({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[62px_1fr] gap-2 py-1 text-[12px]">
      <dt className="text-ink-4">{k}</dt>
      <dd className="break-words text-ink-2">{v}</dd>
    </div>
  );
}
