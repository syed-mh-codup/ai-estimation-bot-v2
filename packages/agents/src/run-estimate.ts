import type { PrismaClient, AgentKind } from '@repo/db';
import type { IModelProvider, IEmbeddingProvider, ISearchProvider, IMcpProvider } from '@repo/providers';
import { StubSearchProvider, StubMcpProvider } from '@repo/providers';
import type { ArchivistMatch, MenuItem, RiskFinding, SpecialistOutput } from '@repo/shared';
import { hashSOW, normaliseSOW } from './sow-utils';
import { runLibrarian, type TaxonomyEntry } from './librarian';
import { runDetective } from './detective';
import { runArchivist } from './archivist';
import { runComplexityScorecard } from './complexity';
import { runSpecialistCouncil, type SpecialistContext } from './specialist';
import { applyTaxationToMenuItems } from './taxation';
import { runArchitect } from './architect';
import { computeRollup } from './rollup';
import { checkSupervisorGates } from './supervisor-gates';

/** A single progress tick: a human-readable stage label + 0–100 percentage. */
export type RunProgress = { stage: string; pct: number };

export type RunEstimateDeps = {
  db: PrismaClient;
  modelProvider: IModelProvider;
  /** Optional: enables Archivist preset RAG (needs preset embeddings). */
  embeddingProvider?: IEmbeddingProvider;
  /** Optional: enables Detective web research. Falls back to a no-op stub (empty results). */
  searchProvider?: ISearchProvider;
  /** Optional: enables Detective MCP tool discovery. Falls back to a no-op stub (no tools). */
  mcpProvider?: IMcpProvider;
  /**
   * Optional progress callback, fired at each pipeline stage. The web layer
   * persists these to the Estimate row so the UI can poll a reload-safe status.
   * Awaited so a slow DB write can't let two ticks interleave out of order.
   */
  onProgress?: (p: RunProgress) => void | Promise<void>;
};

export type RunEstimateResult = {
  estimateId: string;
  status: 'REVIEW';
  complexityScore: number;
  menuItemCount: number;
  /** Deterministic SUPERVISOR-style invariant checks (not a full reject/retry gate loop — see checkSupervisorGates). */
  gateWarnings: string[];
};

/**
 * Full estimate run: Librarian → (Detective + Archivist, parallel) →
 * Complexity → Specialists (per requirement, per role) → Architect →
 * Taxation → Rollup, persisting a costed Menu Card.
 *
 * Agents take an `IModelProvider`, so the whole pipeline is exercisable offline
 * with a stub provider (see run-estimate.test.ts). In production the web action
 * passes a real OpenRouter provider. Archivist (preset RAG) only runs when an
 * embeddingProvider is supplied AND presets have embeddings.
 */
export async function runEstimate(
  estimateId: string,
  deps: RunEstimateDeps,
): Promise<RunEstimateResult> {
  const { db, modelProvider } = deps;
  const searchProvider = deps.searchProvider ?? new StubSearchProvider();
  const mcpProvider = deps.mcpProvider ?? new StubMcpProvider();
  // Progress is awaited so ticks can't interleave; pct weights are coarse but
  // monotonic so the UI bar only ever moves forward.
  const report = async (stage: string, pct: number): Promise<void> => {
    if (deps.onProgress) await deps.onProgress({ stage, pct });
  };

  await report('Loading prompts & config', 2);
  const est = await db.estimate.findUniqueOrThrow({ where: { id: estimateId } });

  // Refuse a trivially-empty SOW rather than let the Librarian fabricate one
  // from nothing. This can happen if document ingestion silently produced no
  // text (e.g. a broken PDF parser) — see estimate-quality-prompt-code-drift
  // memory. A real SOW is always at least a few sentences; this threshold is
  // deliberately far below that, just enough to catch "genuinely nothing here."
  const MIN_SOW_CHARS = 40;
  if (est.sowText.trim().length < MIN_SOW_CHARS) {
    throw new Error(
      `SOW text is empty or too short to estimate (${est.sowText.trim().length} chars, need >=${MIN_SOW_CHARS}) — refusing to run. Check ingestStatus/ingestError; document ingestion may have failed silently.`,
    );
  }

  // ── Active prompts (one per agent kind) ─────────────────────────────────────
  const [libP, detP, archP, devP, qaP, pmP, baP, architectP] = await Promise.all([
    loadActivePrompt(db, 'LIBRARIAN'),
    loadActivePrompt(db, 'DETECTIVE'),
    loadActivePrompt(db, 'ARCHIVIST'),
    loadActivePrompt(db, 'SPECIALIST_DEV'),
    loadActivePrompt(db, 'SPECIALIST_QA'),
    loadActivePrompt(db, 'SPECIALIST_PM'),
    loadActivePrompt(db, 'SPECIALIST_BA'),
    loadActivePrompt(db, 'ARCHITECT'),
  ]);

  // ── Active config (complexity rules + taxation %) ───────────────────────────
  const config = await db.estimationConfig.findFirstOrThrow({
    where: { active: true },
    orderBy: { version: 'desc' },
  });

  // ── Taxonomy entries for the Librarian (empty until taxonomy is derived) ────
  const taxonomy = await loadTaxonomyEntries(db);

  // ── 1. Librarian: SOW → requirements ────────────────────────────────────────
  await report('Analysing scope (Librarian)', 8);
  const lib = await runLibrarian(est.sowText, taxonomy, {
    modelProvider,
    modelString: libP.modelString,
    instructions: libP.body,
  });

  // ── 2. Detective + Archivist (parallel): risk register + preset matches ─────
  await report('Investigating risk & matching presets (Detective + Archivist)', 20);
  const [detectiveOut, archivistOut] = await Promise.all([
    runDetective(lib.requirements, {
      modelProvider,
      modelString: detP.modelString,
      instructions: detP.body,
      searchProvider,
      mcpProvider,
    }),
    deps.embeddingProvider
      ? runArchivist(lib.requirements, {
          db,
          embeddingProvider: deps.embeddingProvider,
          modelProvider,
          modelString: archP.modelString,
        })
      : Promise.resolve({ matches: [] as ArchivistMatch[] }),
  ]);
  const matches = archivistOut.matches;
  const riskFindings: RiskFinding[] = detectiveOut.risks;

  // ── 3. Complexity (deterministic, fed by real Librarian/Detective signals) ──
  await report('Scoring complexity', 35);
  const complexity = runComplexityScorecard(lib.requirements, riskFindings, config.complexityRules);

  // ── 4. Specialist council per requirement (DEV/QA/PM/BA, each ≤4h line items) ─
  const specialistCtx: SpecialistContext = {
    modelProvider,
    modelString: devP.modelString,
    instructions: { DEV: devP.body, QA: qaP.body, PM: pmP.body, BA: baP.body },
  };

  const allSpecialistOutputs: SpecialistOutput[] = [];
  const matchByRequirementId = new Map(matches.map((m: ArchivistMatch) => [m.requirementId, m]));
  const risksByRequirementId = new Map<string, RiskFinding[]>();
  for (const rf of riskFindings) {
    const list = risksByRequirementId.get(rf.requirementId) ?? [];
    list.push(rf);
    risksByRequirementId.set(rf.requirementId, list);
  }

  const reqCount = lib.requirements.length;
  for (let i = 0; i < lib.requirements.length; i += 1) {
    // Specialists span 35→85% of the bar, spread across the requirement count.
    await report(
      `Estimating items (Specialists ${i + 1}/${reqCount})`,
      reqCount > 0 ? Math.round(35 + (50 * i) / reqCount) : 35,
    );
    const req = lib.requirements[i]!;

    const outputs = await runSpecialistCouncil(
      {
        requirement: req,
        menuCardId: req.candidateMenuCardId,
        archivistMatch: matchByRequirementId.get(req.id),
        riskFindings: risksByRequirementId.get(req.id) ?? [],
        complexityScore: complexity.score,
      },
      specialistCtx,
    );
    allSpecialistOutputs.push(...outputs);
  }

  // ── 5. Architect: assemble menu cards + write the narrative ─────────────────
  await report('Writing narrative (Architect)', 87);
  const arch = await runArchitect({
    ctx: { modelProvider, modelString: architectP.modelString, instructions: architectP.body },
    requirements: lib.requirements,
    archivistMatches: matches,
    specialistOutputs: allSpecialistOutputs,
    openQuestions: detectiveOut.questions.map((q: { question: string }) => q.question),
  });

  // ── 6. Taxation (stored %s → fractions, matching the config-admin UI) ───────
  const taxed = applyTaxationToMenuItems(arch.menuItems, {
    pmCommunicationTaxPct: config.pmCommunicationTaxPct / 100,
    baCommunicationTaxPct: config.baCommunicationTaxPct / 100,
    qaRegressionBufferPct: config.qaRegressionBufferPct / 100,
  });

  // ── 7. Rollup (totals; computed for completeness/return value) ──────────────
  computeRollup(taxed);

  // ── 8. Deterministic SUPERVISOR-style invariant checks (see supervisor-gates.ts) ─
  const gateWarnings = checkSupervisorGates({
    requirements: lib.requirements,
    archivistMatches: matches,
    riskFindings,
    specialistOutputs: allSpecialistOutputs,
    menuItems: taxed,
    consistencyFlags: arch.consistencyFlags,
  });
  if (gateWarnings.length > 0) {
    // eslint-disable-next-line no-console
    console.warn(`[runEstimate] ${estimateId} gate warnings:\n${gateWarnings.join('\n')}`);
  }

  // ── 9. Persist a costed Menu Card + run state ───────────────────────────────
  await report('Saving menu card', 95);
  // Many sequential writes (per menu item + line items). Over a remote DB (Neon)
  // network latency pushes this past Prisma's default 5s interactive-transaction
  // timeout, so raise it generously.
  await db.$transaction(
    async (tx) => {
    const existing = await tx.menuItem.findMany({
      where: { estimateId },
      select: { id: true },
    });
    const ids = existing.map((m) => m.id);
    if (ids.length) {
      await tx.roleLineItem.deleteMany({ where: { menuItemId: { in: ids } } });
      await tx.menuItem.deleteMany({ where: { id: { in: ids } } });
    }
    for (const item of taxed) {
      await tx.menuItem.create({
        data: {
          estimateId,
          taxonomyKey: item.taxonomyKey,
          category: item.category ?? null,
          phase: item.phase ?? null,
          title: item.title,
          enabled: item.enabled,
          sourcePresetId: item.sourcePresetId ?? null,
          matchScore: item.matchScore ?? null,
          meta: {
            requirementIds: item.requirementIds,
            toggleable: item.toggleable,
            notSafelyRemovable: item.notSafelyRemovable,
            thinSlice: item.thinSlice,
          },
          lineItems: {
            create: item.lineItems.map((li) => ({
              role: li.role,
              title: li.title ?? null,
              baseHours: li.baseHours,
              taxedHours: li.taxedHours,
              notes: li.notes ?? null,
              edited: li.edited,
              meta: {
                id: li.id ?? null,
                requirementId: li.requirementId ?? null,
                complexity: li.complexity ?? null,
                aiAssistApplied: li.aiAssistApplied,
                dependsOn: li.dependsOn,
                anchorPresetIds: li.anchorPresetIds,
              },
            })),
          },
        },
      });
    }
    await tx.estimate.update({
      where: { id: estimateId },
      data: {
        sowHash: hashSOW(normaliseSOW(est.sowText)),
        status: 'REVIEW',
        complexityScore: complexity.score,
        narrative: arch.narrative,
        assumptions: arch.assumptions,
        agentState: {
          librarianOutput: lib,
          detectiveRiskCount: riskFindings.length,
          detectiveQuestionCount: detectiveOut.questions.length,
          archivistMatchCount: matches.length,
          complexity,
          gateWarnings,
          ranAt: new Date().toISOString(),
        },
      },
    });
    },
    { maxWait: 15_000, timeout: 60_000 },
  );

  return {
    estimateId,
    status: 'REVIEW',
    complexityScore: complexity.score,
    menuItemCount: arch.menuItems.length,
    gateWarnings,
  };
}

/** Load the active prompt body + model for an agent kind (throws if none). */
async function loadActivePrompt(
  db: PrismaClient,
  kind: AgentKind,
): Promise<{ body: string; modelString: string }> {
  const pv = await db.promptVersion.findFirst({
    where: { kind, active: true },
    orderBy: { version: 'desc' },
    select: { body: true, modelString: true },
  });
  if (!pv) {
    throw new Error(`No active prompt version for agent kind: ${kind}`);
  }
  return pv;
}

/**
 * Load active taxonomy entries for the Librarian. Returns [] until taxonomy is
 * derived from the preset library (a credential-free follow-up); the Librarian
 * tolerates an empty taxonomy.
 */
async function loadTaxonomyEntries(db: PrismaClient): Promise<TaxonomyEntry[]> {
  const versions = await db.taxonomyNodeVersion.findMany({
    where: { active: true },
    select: { nodeKey: true, label: true, keywords: true },
  });
  return versions.map((v) => ({ key: v.nodeKey, label: v.label, keywords: v.keywords }));
}
