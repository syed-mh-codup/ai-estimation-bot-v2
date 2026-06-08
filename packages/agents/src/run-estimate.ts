import type { PrismaClient, AgentKind } from '@repo/db';
import type { IModelProvider, IEmbeddingProvider } from '@repo/providers';
import type { ArchivistMatch, MenuItem, RoleLineItem, SpecialistOutput } from '@repo/shared';
import { hashSOW, normaliseSOW } from './sow-utils';
import { runLibrarian, type TaxonomyEntry } from './librarian';
import { runArchivist } from './archivist';
import { runComplexityScorecard } from './complexity';
import { runSpecialistCouncil, type SpecialistContext } from './specialist';
import { applyTaxationToMenuItems } from './taxation';
import { runArchitect } from './architect';
import { computeRollup } from './rollup';

export type RunEstimateDeps = {
  db: PrismaClient;
  modelProvider: IModelProvider;
  /** Optional: enables Archivist preset RAG (needs preset embeddings). */
  embeddingProvider?: IEmbeddingProvider;
};

export type RunEstimateResult = {
  estimateId: string;
  status: 'REVIEW';
  complexityScore: number;
  menuItemCount: number;
};

/**
 * Full estimate run: Librarian → (Archivist) → Complexity → Specialists →
 * Taxation → Architect → Rollup, persisting a costed Menu Card.
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
  const est = await db.estimate.findUniqueOrThrow({ where: { id: estimateId } });

  // ── Active prompts (one per agent kind) ─────────────────────────────────────
  const [libP, archP, devP, qaP, pmP, baP] = await Promise.all([
    loadActivePrompt(db, 'LIBRARIAN'),
    loadActivePrompt(db, 'ARCHITECT'),
    loadActivePrompt(db, 'SPECIALIST_DEV'),
    loadActivePrompt(db, 'SPECIALIST_QA'),
    loadActivePrompt(db, 'SPECIALIST_PM'),
    loadActivePrompt(db, 'SPECIALIST_BA'),
  ]);

  // ── Active config (complexity rules + taxation %) ───────────────────────────
  const config = await db.estimationConfig.findFirstOrThrow({
    where: { active: true },
    orderBy: { version: 'desc' },
  });

  // ── Taxonomy entries for the Librarian (empty until taxonomy is derived) ────
  const taxonomy = await loadTaxonomyEntries(db);

  // ── 1. Librarian: SOW → requirements ────────────────────────────────────────
  const lib = await runLibrarian(est.sowText, taxonomy, {
    modelProvider,
    modelString: libP.modelString,
    instructions: libP.body,
  });

  // ── 2. Archivist (optional): requirements → preset matches ──────────────────
  let matches: ArchivistMatch[] = [];
  if (deps.embeddingProvider) {
    const archivistOut = await runArchivist(lib.requirements, {
      db,
      embeddingProvider: deps.embeddingProvider,
      modelProvider,
      modelString: archP.modelString,
    });
    matches = archivistOut.matches;
  }

  // ── 3. Complexity (deterministic) ───────────────────────────────────────────
  const complexity = runComplexityScorecard(lib.requirements, [], config.complexityRules);

  // ── 4. Menu items from requirements + 5. Specialist council per item ────────
  const specialistCtx: SpecialistContext = {
    modelProvider,
    modelString: devP.modelString,
    instructions: { DEV: devP.body, QA: qaP.body, PM: pmP.body, BA: baP.body },
  };

  const allSpecialistOutputs: SpecialistOutput[] = [];
  const draftMenuItems: MenuItem[] = [];
  for (let i = 0; i < lib.requirements.length; i += 1) {
    const req = lib.requirements[i]!;
    const taxonomyKey = req.taxonomyKey ?? 'uncategorised';
    const stub = { id: `mi-${i}`, taxonomyKey, title: req.text.slice(0, 120) };
    const match = matches.find((m) => m.taxonomyKey === taxonomyKey);

    const outputs = await runSpecialistCouncil(
      {
        menuItem: stub,
        archivistMatch: match,
        detectiveFindings: [],
        complexityScore: complexity.score,
      },
      specialistCtx,
    );
    allSpecialistOutputs.push(...outputs);

    const lineItems: RoleLineItem[] = outputs.map((o) => ({
      role: o.role,
      baseHours: o.baseHours,
      taxedHours: o.baseHours, // taxation applied next
      edited: false,
    }));

    draftMenuItems.push({
      id: stub.id,
      taxonomyKey,
      title: stub.title,
      enabled: true,
      sourcePresetId: match?.presetId,
      matchScore: match?.score,
      lineItems,
    });
  }

  // ── 6. Taxation (stored %s → fractions, matching the config-admin UI) ───────
  const taxed = applyTaxationToMenuItems(draftMenuItems, {
    pmCommunicationTaxPct: config.pmCommunicationTaxPct / 100,
    baCommunicationTaxPct: config.baCommunicationTaxPct / 100,
    qaRegressionBufferPct: config.qaRegressionBufferPct / 100,
  });

  // ── 7. Architect: narrative + assumptions + assembled menu card ─────────────
  const arch = await runArchitect({
    ctx: { modelProvider, modelString: archP.modelString, instructions: archP.body },
    requirements: lib.requirements,
    archivistMatches: matches,
    specialistOutputs: allSpecialistOutputs,
    menuItems: taxed,
  });

  // ── 8. Rollup (totals; computed for completeness/return value) ──────────────
  computeRollup(arch.menuItems);

  // ── 9. Persist a costed Menu Card + run state ───────────────────────────────
  await db.$transaction(async (tx) => {
    const existing = await tx.menuItem.findMany({
      where: { estimateId },
      select: { id: true },
    });
    const ids = existing.map((m) => m.id);
    if (ids.length) {
      await tx.roleLineItem.deleteMany({ where: { menuItemId: { in: ids } } });
      await tx.menuItem.deleteMany({ where: { id: { in: ids } } });
    }
    for (const item of arch.menuItems) {
      await tx.menuItem.create({
        data: {
          estimateId,
          taxonomyKey: item.taxonomyKey,
          title: item.title,
          enabled: item.enabled,
          sourcePresetId: item.sourcePresetId ?? null,
          matchScore: item.matchScore ?? null,
          lineItems: {
            create: item.lineItems.map((li) => ({
              role: li.role,
              baseHours: li.baseHours,
              taxedHours: li.taxedHours,
              notes: li.notes ?? null,
              edited: li.edited,
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
          archivistMatchCount: matches.length,
          complexity,
          ranAt: new Date().toISOString(),
        },
      },
    });
  });

  return {
    estimateId,
    status: 'REVIEW',
    complexityScore: complexity.score,
    menuItemCount: arch.menuItems.length,
  };
}

/**
 * Load active taxonomy entries for the Librarian. Returns [] until taxonomy is
 * derived from the preset library (a credential-free follow-up); the Librarian
 * tolerates an empty taxonomy.
 */
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

async function loadTaxonomyEntries(db: PrismaClient): Promise<TaxonomyEntry[]> {
  const versions = await db.taxonomyNodeVersion.findMany({
    where: { active: true },
    select: { nodeKey: true, label: true, keywords: true },
  });
  return versions.map((v) => ({ key: v.nodeKey, label: v.label, keywords: v.keywords }));
}
