import Link from 'next/link';
import { revalidatePath } from 'next/cache';
import { after } from 'next/server';
import { notFound, redirect } from 'next/navigation';
import { prisma, rootOf, toMenuItem } from '@repo/db';
import { createSheetsProvider } from '@repo/providers';
import { exportToSheets } from '@repo/agents';
import type { MenuItem as MenuItemDTO } from '@repo/shared';
import { auth } from '@/lib/auth';
import { latestTaxChanges, taxContextFor } from '@/lib/estimate-tax';
import { loadLockState } from '@/lib/lock-state';
import { loadStatements } from '@repo/db';
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
import { ForkDialog } from './ForkDialog';
import { ForkedFrom, ForksOfThis } from './Lineage';
import { LinkLineageDialog, UnlinkButton } from './LinkLineageDialog';
import { ReconcilePanel } from './ReconcilePanel';
import type { ProposalDTO, ReconciliationDTO } from './reconcile-dto';
import { CustodianField, DueDateField } from './CustodyFields';
import type { CustodianOption } from './CustodyFields';
import { dueLabel, toDateInputValue } from '@/lib/due-date';
import { EditableList } from './EditableList';
import { CollapseAllButton } from './CollapseAllButton';
import { LedgerProvider } from './ledger-context';
import { listLedgerEdits } from './edit-actions';
import { RollupCard } from './RollupCard';
import { HiddenWorkPanel } from './HiddenWorkPanel';
import { RunDiagnosticsPanel } from './RunDiagnosticsPanel';
import { ContentsCard } from './ContentsCard';
import { ArtifactsPanel } from './ArtifactsPanel';
import { updateNarrative, updateAssumptions, deleteEstimate } from './actions';
import { ExportSheets } from './ExportSheets';
import { lastExportLine, overwriteWarning, type ExportOutcome } from './export-interaction';
import { cardFlags, carriedMark, lineEnvelope } from './dto';
import type { ItemDTO, SectionDTO } from './dto';

async function requireSession() {
  const session = await auth();
  if (!session?.user) redirect('/login');
  return session.user;
}

/**
 * AEH-316: returns its outcome instead of throwing. A throw from a server
 * action surfaces as a bare "Application error: a server-side exception has
 * occurred" page, which is how the AEH-232 quota failure managed to look like
 * a site outage rather than a failed button.
 *
 * AEH-317 added the confirmation step. The export rewrites Summary and every
 * department tab from scratch, so an account executive's afternoon inside one
 * of them is destroyed by a button press that used to give no warning at all.
 * `confirmed` is how the second press says the user has seen what it costs.
 */
async function exportSheetsAction(id: string, confirmed = false): Promise<ExportOutcome> {
  'use server';
  const viewer = await requireSession();
  const estimate = await prisma.estimate.findUnique({
    where: { id },
    include: { menuItems: { include: { lineItems: true } } },
  });
  if (!estimate) return { kind: 'failed', error: 'That estimate no longer exists.' };

  try {
    // toMenuItem parses strictly (AEH-227), so a bad row throws here rather
    // than inside Google's API — and that is worth telling the user apart.
    const items: MenuItemDTO[] = estimate.menuItems.map(toMenuItem);
    const provider = createSheetsProvider();

    if (!confirmed) {
      const warning = await overwriteWarningFor(id, provider);
      if (warning) return { kind: 'needs-confirmation', warning };
    }

    const exportedAt = new Date();
    const result = await exportToSheets(id, estimate.title, items, provider, exportedAt);

    // One transaction: a sheetUrl with no audit row beside it would be a
    // spreadsheet nobody can account for, and the audit log is the only record
    // of the overwrite that just happened.
    await prisma.$transaction([
      prisma.estimate.update({ where: { id }, data: { sheetUrl: result.url } }),
      prisma.sheetExport.create({
        data: {
          estimateId: id,
          spreadsheetId: result.spreadsheetId,
          url: result.url,
          exportedById: viewer.id ?? null,
          exportedAt,
          sheetModifiedAt: result.modifiedAt,
        },
      }),
    ]);
    revalidatePath(`/estimates/${id}`);
    return {
      kind: 'exported',
      url: result.url,
      lastExport: lastExportLine({ at: exportedAt, by: viewer.email ?? null }),
    };
  } catch (err) {
    return {
      kind: 'failed',
      error: err instanceof Error ? err.message : 'The export failed for an unknown reason.',
    };
  }
}

/**
 * The sentence to put in front of the user, or null when there is nothing to
 * warn about.
 *
 * The comparison is against the modifiedTime recorded straight AFTER the last
 * export, never against when the export ran: writing the spreadsheet bumps
 * Drive's modifiedTime by definition, so any other baseline reports an edit
 * every single time and the warning becomes something people click through
 * without reading — which is worse than not having one.
 *
 * Silent about everything it cannot establish. No previous export, no recorded
 * modifiedTime, or Drive declining to answer all mean "unknown", and unknown
 * must not manufacture a warning nobody can act on.
 */
async function overwriteWarningFor(
  estimateId: string,
  provider: ReturnType<typeof createSheetsProvider>,
): Promise<string | null> {
  const previous = await prisma.sheetExport.findFirst({
    where: { estimateId },
    orderBy: { exportedAt: 'desc' },
    include: { exportedBy: { select: { email: true } } },
  });
  if (!previous?.sheetModifiedAt) return null;

  const modifiedAt = await provider.getModifiedTime(previous.spreadsheetId);
  if (!modifiedAt || modifiedAt <= previous.sheetModifiedAt) return null;

  return overwriteWarning({
    modifiedAt,
    lastExportAt: previous.exportedAt,
    lastExportBy: previous.exportedBy?.email ?? null,
  });
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
      // Same reading for the export: who last overwrote the spreadsheet, which
      // is the provenance somebody needs before opening it. AEH-317.
      sheetExports: {
        orderBy: { exportedAt: 'desc' },
        take: 1,
        include: { exportedBy: { select: { email: true } } },
      },
      sections: { orderBy: { order: 'asc' } },
      menuItems: {
        include: { lineItems: true },
        orderBy: [{ order: 'asc' }, { id: 'asc' }],
      },
      // Lineage, both directions. AEH-236. The parent is one line under the
      // title; the children are a rail block, and that half is what stops
      // somebody quoting a round-1 number that round 2 has already moved.
      parent: { select: { id: true, title: true } },
      children: {
        select: { id: true, title: true, status: true, lineageKind: true, createdAt: true },
        orderBy: { createdAt: 'asc' },
      },
    },
  });
  if (!estimate) notFound();

  // Candidates for relating this estimate to one that already exists. AEH-236.
  //
  // Offered only when this estimate has no parent — an estimate records ONE
  // origin, and quietly re-pointing it would rewrite a family somebody else
  // built. Descendants are excluded because linking to one would close a loop;
  // `linkToParent` refuses that too, and this is the half that stops it being
  // offered in the first place.
  const linkCandidates = estimate.parentId
    ? []
    : await (async () => {
        const all = await prisma.estimate.findMany({
          select: { id: true, parentId: true, title: true },
          orderBy: { createdAt: 'desc' },
        });
        return all
          .filter((e) => e.id !== estimate.id && rootOf(all, e.id)?.id !== estimate.id)
          .map((e) => ({ id: e.id, title: e.title }));
      })();
  const inAFamily = Boolean(estimate.parentId) || estimate.children.length > 0;

  // The newest reconciliation, server-rendered so the panel has something to
  // show before its first poll. Only a fork can have one.
  const reconciliation: ReconciliationDTO | null = !estimate.parentId
    ? null
    : await (async () => {
        const r = await prisma.estimateReconciliation.findFirst({
          where: { estimateId: estimate.id },
          orderBy: { createdAt: 'desc' },
          select: {
            id: true,
            status: true,
            stage: true,
            pct: true,
            error: true,
            prompt: true,
            posture: true,
            reasoning: true,
            triageReasoning: true,
            triagedCardIds: true,
            createdAt: true,
            appliedAt: true,
            proposals: {
              orderBy: { title: 'asc' },
              select: {
                id: true,
                menuItemId: true,
                kind: true,
                title: true,
                rationale: true,
                supersedesMenuItemIds: true,
                hoursBefore: true,
                hoursAfter: true,
                decision: true,
                payload: true,
              },
            },
          },
        });
        if (!r) return null;
        const proposals: ProposalDTO[] = r.proposals.map((p) => ({
          id: p.id,
          menuItemId: p.menuItemId,
          kind: p.kind,
          title: p.title,
          rationale: p.rationale,
          supersedes: p.supersedesMenuItemIds,
          delta: (p.hoursAfter ?? 0) - (p.hoursBefore ?? 0),
          decision: p.decision,
          rows: (
            (p.payload as { rows?: { role: string; title: string; baseHours: number; taxedHours: number }[] } | null)
              ?.rows ?? []
          ).map((row) => ({
            role: row.role,
            title: row.title,
            baseHours: row.baseHours,
            taxedHours: row.taxedHours,
          })),
        }));
        return {
          id: r.id,
          status: r.status,
          stage: r.stage,
          pct: r.pct,
          error: r.error,
          prompt: r.prompt,
          posture: r.posture,
          reasoning: r.reasoning,
          triageReasoning: r.triageReasoning,
          triagedCount: r.triagedCardIds.length,
          proposals,
          createdAt: r.createdAt.toISOString(),
          appliedAt: r.appliedAt?.toISOString() ?? null,
        };
      })();

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
  // The buffers in force for THIS estimate — its own overrides where it has
  // them, and the house defaults from the config version it is pinned to
  // otherwise. Not the active config: see lib/estimate-tax.ts. AEH-335.
  const [tax, taxChanges, lockState, statements, edits] = await Promise.all([
    taxContextFor(estimate),
    latestTaxChanges(estimate.id),
    // Read with the page rather than fetched by the editor: which rows are
    // frozen changes how every one of them renders, so it has to be in the
    // first paint or the ledger flashes editable and then locks. AEH-238.
    loadLockState(estimate.id),
    // Their own rows since AEH-238, so their own read — and the rows rather
    // than just the text, because a lock, a tick and a provenance badge all
    // need the id. The editor still submits whole lists of text; identity is
    // preserved on the way back in by `reconcileStatements`.
    loadStatements(prisma, estimate.id),
    // In the FIRST paint, like the lock state. `poll()` only ever starts from
    // inside a steer, so without this an edit that is already running is
    // invisible after a reload and nothing ever asks about it again — no
    // progress, no approve/discard on a parked conflict, no revert.
    listLedgerEdits(estimate.id),
  ]);
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
    overhead: m.overhead,
    taxonomyKey: m.taxonomyKey,
    sectionId: m.sectionId,
    order: m.order,
    category: m.category,
    phase: m.phase,
    sourcePresetId: m.sourcePresetId,
    matchScore: m.matchScore,
    carriedFromId: m.carriedFromId,
    carriedIntact: m.carriedIntact,
    flags: cardFlags(m.meta),
    lineItems: m.lineItems.map((li) => ({
      id: li.id,
      role: li.role,
      title: li.title,
      baseHours: li.baseHours,
      taxedHours: li.taxedHours,
      provenance: li.provenance,
      touchesFrontend: li.touchesFrontend,
      touchesBackend: li.touchesBackend,
      envelope: lineEnvelope(li.meta),
      carried: carriedMark(m, li),
    })),
  }));

  // Remount the client ledger when the server's set of CARDS changes underneath
  // it (e.g. a run just produced a whole new menu card).
  //
  // Line item ids are deliberately NOT in this key, though they change on every
  // steered edit. They were, briefly, and it was the wrong instrument: the
  // provider remounting mid-edit also closes the activity sheet somebody is
  // watching the edit in. The provider syncs its rows from these props instead,
  // on `renderedAt` — see the note there.
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
        {estimate.parent && estimate.lineageKind && (
          <ForkedFrom
            parent={estimate.parent}
            kind={estimate.lineageKind}
            projectHref={`/estimates/${estimate.id}/lineage`}
          />
        )}
      </div>

      <LedgerProvider
        key={editorKey}
        estimateId={estimate.id}
        initialSections={sectionDTOs}
        initialItems={itemDTOs}
        taxPercents={tax.effective}
        houseRates={tax.house}
        initialOverrides={tax.overrides}
        initialOverheadStale={estimate.overheadRatesStale}
        taxChanges={taxChanges}
        isFinalised={isFinalised}
        initialLocks={lockState}
        initialEdits={edits.edits}
        initialEditCounts={edits.counts}
        viewerId={viewer.id}
        renderedAt={new Date().toISOString()}
      >
        <div className="mt-5 grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_280px]">
          {/* ── the document ─────────────────────────────────────────────── */}
          <div className="min-w-0">
            {/* On a FORK the hierarchy inverts. Reconciling is the thing
                somebody forked in order to do; running is the one that rebuilds
                from the SOW and discards every card the fork copied. So the
                fork gets the reconciliation in the hero position and the run
                demoted to the rail, and an ordinary estimate — which has
                nothing to reconcile against — is left exactly as it was.

                Reconciling is NOT once-only: a settled pass offers "Reconcile
                again", and the dispatcher refuses only while one is still
                running. So this is a standing control, not a one-shot. */}
            {estimate.parentId && !isFinalised ? (
              <ReconcilePanel estimateId={estimate.id} initial={reconciliation} />
            ) : (
              <RunControls
                isFork={false}
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
            )}

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
                key={statementKey(statements.narrative)}
                estimateId={estimate.id}
                initialItems={statements.narrative}
                action={updateNarrative}
                isFinalised={isFinalised}
                addLabel="Add point"
                testid="narrative-list"
                askSubject="narrative line"
                kind="NARRATIVE"
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
                key={statementKey(statements.assumptions)}
                estimateId={estimate.id}
                initialItems={statements.assumptions}
                action={updateAssumptions}
                isFinalised={isFinalised}
                addLabel="Add assumption"
                testid="assumptions-list"
                askSubject="assumption"
                kind="ASSUMPTION"
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
                    initialLastExport={
                      estimate.sheetExports[0]
                        ? lastExportLine({
                            at: estimate.sheetExports[0].exportedAt,
                            by: estimate.sheetExports[0].exportedBy?.email ?? null,
                          })
                        : null
                    }
                    action={exportSheetsAction}
                  />
                )}
                <CollapseAllButton />
                {/* Below the run and export controls: forking is something you
                    do to an estimate that already says something, not a way of
                    starting one. */}
                <ForkDialog estimateId={estimate.id} estimateTitle={estimate.title} />
                {/* Only where there is no origin recorded yet: an estimate has
                    one, and re-pointing it would rewrite somebody's family. */}
                {!estimate.parentId && (
                  <LinkLineageDialog estimateId={estimate.id} candidates={linkCandidates} />
                )}
                {/* Beside the other lineage controls rather than adrift
                    below the forks list. Breaking a link is an action, and
                    this is where actions are. */}
                {estimate.parentId && <UnlinkButton estimateId={estimate.id} />}
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
            {/* The run, demoted, on a fork whose hero slot the reconciliation
                has taken. Still reachable — the rule allows a fork with no
                children and no siblings to re-run — but it carries the warning
                that doing so throws the copy away. */}
            {estimate.parentId && !isFinalised && (
              <RunControls
                isFork
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
            )}

            <ForksOfThis
              forks={estimate.children}
              projectHref={inAFamily ? `/estimates/${estimate.id}/lineage` : null}
            />

            {viewer.role === 'ADMIN' && <OracleAdminPanel estimateId={estimate.id} />}
            {viewer.role === 'ADMIN' && <ModelUsagePanel estimateId={estimate.id} />}


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
/**
 * A remount key for one statement list.
 *
 * Ids AND text, because a steered revision changes wording in place: the row
 * keeps its id, so an id-only key would not notice and `EditableList` would
 * hold its old state through a refresh — the Scribe's output invisible on the
 * screen that asked for it. Provenance is in there too, so a line going from
 * the crew's to steered re-renders its badge.
 */
function statementKey(rows: Array<{ id: string; text: string; provenance: string }>): string {
  return rows.map((r) => `${r.id}:${r.provenance}:${r.text}`).join('|');
}

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
