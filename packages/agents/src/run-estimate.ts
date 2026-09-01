import { toMenuItemCreateData, type PrismaClient, type AgentKind } from '@repo/db';
import type {
  IModelProvider,
  IEmbeddingProvider,
  ISearchProvider,
  IMcpProvider,
} from '@repo/providers';
import { createSearchProvider, buildMcpProvider } from '@repo/providers';
import type {
  ArchivistMatch,
  ComplexityOutput,
  LibrarianOutput,
  MenuItem,
  Requirement,
  RiskFinding,
  SpecialistOutput,
} from '@repo/shared';
import { RequirementSchema } from '@repo/shared';
import { runLibrarian, type TaxonomyEntry } from './librarian';
import { createUsageRecorder } from './usage-recorder';
import { runDetective } from './detective';
import { runArchivist } from './archivist';
import { runComplexityScorecard } from './complexity';
import { runSpecialistCouncil, type SpecialistContext } from './specialist';
import { applyTaxationToMenuItems, injectProcessOverhead, ProcessOverheadSchema } from './taxation';
import { runArchitect } from './architect';
import { computeRollup } from './rollup';
import { checkSupervisorGates } from './supervisor-gates';
import {
  buildInjectedMenuItem,
  claimedRiskFlags,
  detectHiddenWork,
  type HiddenWorkDetection,
} from './audit';

/** A single progress tick: a human-readable stage label + 0–100 percentage. */
export type RunProgress = { stage: string; pct: number };

/**
 * Checkpoints one pipeline stage. The default runner just invokes `fn`, so the
 * pipeline behaves identically offline and under test.
 *
 * On serverless the web layer passes Inngest's `step.run`, which turns each
 * stage into its own durable, independently-retried HTTP invocation with a
 * fresh execution-time budget. That matters because Vercel caps a single
 * invocation (300s on Hobby): the specialist council alone is 4 LLM calls per
 * requirement, which would blow that ceiling as one step.
 *
 * Consequence of durability: a checkpointed value is memoised by Inngest as
 * JSON, so `fn` must resolve to something JSON-round-trippable (no Date, Map,
 * or class instances — the agent outputs are all zod-parsed plain objects).
 */
export type StepRunner = <T>(id: string, fn: () => Promise<T>) => Promise<T>;

export type RunEstimateDeps = {
  db: PrismaClient;
  modelProvider: IModelProvider;
  /** Correlates every ModelUsage row this run produces. Null in offline/tests. */
  runId?: string;
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
  /**
   * Optional durable-execution seam (see StepRunner). Defaults to running each
   * stage inline, which is what tests and the local dev server do.
   */
  step?: StepRunner;
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
/**
 * What a run records about itself, beyond the estimate it produced.
 *
 * This type sits next to the write below and describes it exactly. The previous
 * declaration (`AgentStateSnapshot`) described `librarianOutput`,
 * `archivistOutput` and `architectOutput` while the pipeline actually wrote
 * seven different keys — a type nothing enforced, drifting from the payload it
 * claimed to describe, unnoticed because nothing read the column either.
 *
 * Do NOT put `satisfies RunDiagnostics` on the write, tempting as it is. The
 * field audit discovers a Json column's keys by finding `agentState: { … }` as
 * a property assignment whose initializer is an object LITERAL; wrapping it in
 * a `satisfies` expression (or hoisting it to a variable) hides the keys, and
 * the gate then audits `agentState` as one opaque column that the diagnostics
 * panel reads — green, with all seven keys silently unaudited. What guards the
 * drift instead is a test that asserts the persisted key set. AEH-253.
 */
export type RunDiagnostics = {
  /** The Librarian's full classification pass — requirements and their taxonomy keys. */
  librarianOutput: LibrarianOutput;
  /** Risks the Detective raised. */
  detectiveRiskCount: number;
  /** Questions the Detective could not answer from the SOW. */
  detectiveQuestionCount: number;
  /** Requirements the Archivist found a historical analogue for. */
  archivistMatchCount: number;
  complexity: ComplexityOutput;
  /** Deterministic gate warnings. Until now these reached console.warn and nothing else. */
  gateWarnings: string[];
  /**
   * Risk flags the Specialist council said its hours already cover.
   *
   * The mirror image of HiddenWorkFinding, and needed for the same reason that
   * table exists. A claimed flag produces no finding row — detectHiddenWork
   * skips it — so before this key the claimed half of the coverage question
   * simply vanished at the end of a run. "Which risks did we spot, and which of
   * them did somebody actually cost" was answerable in one direction only.
   * Oracle reads both halves. AEH-259.
   */
  claimedRiskFlags: string[];
  /** ISO timestamp. A Date would violate the step-JSON memoisation contract. */
  ranAt: string;
};

export async function runEstimate(
  estimateId: string,
  deps: RunEstimateDeps,
): Promise<RunEstimateResult> {
  const { db, modelProvider } = deps;
  const recorder = createUsageRecorder({ db, estimateId, runId: deps.runId });
  // `createSearchProvider` returns the real Tavily adapter when TAVILY_API_KEY
  // is set and the stub otherwise, so the Detective is grounded in production
  // without callers having to know which. An explicit dep still wins (tests
  // pass a stub deliberately).
  const searchProvider = deps.searchProvider ?? createSearchProvider();
  // Same contract as `createSearchProvider` above: the caller may inject one
  // (tests do), and otherwise the run uses whatever the admin has actually
  // configured. Until AEH-253 this line always built a stub, so a connector an
  // admin had added, tested and enabled influenced exactly zero estimates.
  //
  // Unwrapped rather than inside a step: it is one cheap idempotent read, and
  // only rows already marked enabled are considered.
  const mcpProvider =
    deps.mcpProvider ??
    buildMcpProvider(
      await db.mcpConnector.findMany({
        where: { enabled: true },
        select: { id: true, name: true, transport: true, endpoint: true, authRef: true, enabled: true },
      }),
      { masterKey: process.env['ENCRYPTION_KEY'] },
    );
  // Progress is awaited so ticks can't interleave; pct weights are coarse but
  // monotonic so the UI bar only ever moves forward.
  const report = async (stage: string, pct: number): Promise<void> => {
    if (deps.onProgress) await deps.onProgress({ stage, pct });
  };
  // Inline unless the caller supplies a durable runner (Inngest's step.run).
  // Everything *outside* a step re-executes on each replay, so only cheap,
  // idempotent work (DB reads, deterministic scoring) is left unwrapped.
  const step: StepRunner = deps.step ?? ((_id, fn) => fn());

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
  const lib = await step('librarian', () =>
    runLibrarian(est.sowText, taxonomy, {
      modelProvider,
      modelString: libP.modelString,
      instructions: libP.body,
      recorder,
    }),
  );

  // ── 2. Detective + Archivist (parallel): risk register + preset matches ─────
  await report('Investigating risk & matching presets (Detective + Archivist)', 20);
  const [detectiveOut, archivistOut] = await Promise.all([
    step('detective', () =>
      runDetective(lib.requirements, {
        modelProvider,
        modelString: detP.modelString,
        instructions: detP.body,
        searchProvider,
        mcpProvider,
        recorder,
      }),
    ),
    deps.embeddingProvider
      ? step('archivist', () =>
          runArchivist(lib.requirements, {
            db,
            embeddingProvider: deps.embeddingProvider!,
            modelProvider,
            modelString: archP.modelString,
            recorder,
          }),
        )
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
    recorder,
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

    // Checkpointed per requirement, not per loop: the council is 4 LLM calls
    // each, so one step for the whole loop would scale with requirement count
    // and eventually exceed the invocation ceiling. Keyed by requirement id
    // (not index) so the memoised steps stay stable.
    const outputs = await step(`specialists:${req.id}`, () =>
      runSpecialistCouncil(
        {
          requirement: req,
          menuCardId: req.candidateMenuCardId,
          archivistMatch: matchByRequirementId.get(req.id),
          riskFindings: risksByRequirementId.get(req.id) ?? [],
          complexityScore: complexity.score,
        },
        specialistCtx,
      ),
    );
    allSpecialistOutputs.push(...outputs);
  }

  // ── 5. Architect: assemble menu cards + write the narrative ─────────────────
  await report('Writing narrative (Architect)', 87);
  const arch = await step('architect', () =>
    runArchitect({
      ctx: { modelProvider, modelString: architectP.modelString, instructions: architectP.body, recorder },
      requirements: lib.requirements,
      archivistMatches: matches,
      specialistOutputs: allSpecialistOutputs,
      openQuestions: detectiveOut.questions.map((q: { question: string }) => q.question),
    }),
  );

  // ── 5b. Hidden-work audit: cost what the SOW implied but nobody asked for ───
  //
  // Placed here and nowhere else. It needs the Architect's cards to exist (there
  // is nothing to be uncovered ALONGSIDE until they do) and it must finish before
  // taxation, because an injected card's hours are real council hours and should
  // be taxed exactly like the rest. The older injectors set taxedHours=baseHours
  // and skipped tax, which only made sense while their numbers were fictional.
  await report('Auditing hidden work', 90);
  // Hoisted because it is persisted as well as consumed here: a claimed flag
  // produces no finding row, so without recording the set the claimed half of
  // the coverage question is lost the moment the run ends. AEH-259.
  const claimedFlags = claimedRiskFlags(allSpecialistOutputs);
  const detections = detectHiddenWork(riskFindings, claimedFlags);
  const injected: MenuItem[] = [];
  const resolvedDetections: Array<{ detection: HiddenWorkDetection; costed: boolean }> = [];

  for (const detection of detections) {
    // Off-list flags have no taxonomy key and no agreed cost shape, so there is
    // nothing to estimate against — they go straight to a person.
    if (!detection.known) {
      resolvedDetections.push({ detection, costed: false });
      continue;
    }

    // Own step id, never the `specialists:` prefix — run-estimate.test.ts
    // asserts on that prefix's cardinality, and these are not per-requirement.
    // Keyed by flag so the memoised step stays stable across replays.
    let outputs: SpecialistOutput[] = [];
    try {
      outputs = await step(`hidden-work:${detection.riskFlag}`, () =>
        runSpecialistCouncil(
          {
            requirement: syntheticRequirement(detection, lib.requirements),
            menuCardId: detection.taxonomyKey!,
            riskFindings: riskFindings.filter((r) => r.riskFlags.includes(detection.riskFlag)),
            complexityScore: complexity.score,
          },
          specialistCtx,
        ),
      );
    } catch (err) {
      // A refinement failing must not fail the whole estimate. Falling back to a
      // flat default is what this ticket deleted, so the honest fallback is the
      // other direction: record it as an open question for a human.
      console.warn(
        `[runEstimate] ${estimateId} could not cost hidden work '${detection.riskFlag}':`,
        err,
      );
      resolvedDetections.push({ detection, costed: false });
      continue;
    }

    const card = buildInjectedMenuItem(detection, outputs);
    if (!card) {
      resolvedDetections.push({ detection, costed: false });
      continue;
    }
    injected.push(card);
    resolvedDetections.push({ detection, costed: true });
  }

  // ── 6. Taxation (stored %s → fractions, matching the config-admin UI) ───────
  const taxed = applyTaxationToMenuItems([...arch.menuItems, ...injected], {
    pmCommunicationTaxPct: config.pmCommunicationTaxPct / 100,
    baCommunicationTaxPct: config.baCommunicationTaxPct / 100,
    qaRegressionBufferPct: config.qaRegressionBufferPct / 100,
  });

  // ── 6b. Delivery overhead: the work every project carries and no SOW names ──
  //
  // After taxation, unlike the hidden-work stage above, and for the opposite
  // reason: these are percentages OF the taxed hours, so taxing the result
  // would compound. See injectProcessOverhead for how the split against
  // pmCommunicationTaxPct / qaRegressionBufferPct is drawn.
  //
  // A config that does not parse injects nothing and says so loudly. Falling
  // back to built-in defaults would quietly put hours nobody configured into a
  // client-facing total, which is the habit this ticket exists to break.
  const overheadParsed = ProcessOverheadSchema.safeParse(config.infraBaseline);
  if (!overheadParsed.success) {
    console.warn(
      `[runEstimate] ${estimateId} delivery overhead not configured or malformed — no overhead cards injected. ` +
        `Set it at /admin/config; expected {"items":[{"title","taxonomyKey","pct":{"DEV":8}}]}.`,
    );
  }
  const withOverhead = overheadParsed.success
    ? injectProcessOverhead(taxed, overheadParsed.data)
    : taxed;

  // ── 7. Rollup (totals; computed for completeness/return value) ──────────────
  computeRollup(withOverhead);

  // ── 8. Deterministic SUPERVISOR-style invariant checks (see supervisor-gates.ts) ─
  const gateWarnings = checkSupervisorGates({
    requirements: lib.requirements,
    archivistMatches: matches,
    riskFindings,
    specialistOutputs: allSpecialistOutputs,
    menuItems: withOverhead,
    consistencyFlags: arch.consistencyFlags,
  });
  if (gateWarnings.length > 0) {
    console.warn(`[runEstimate] ${estimateId} gate warnings:\n${gateWarnings.join('\n')}`);
  }

  // ── 9. Persist a costed Menu Card + run state ───────────────────────────────
  await report('Saving menu card', 95);
  // Many sequential writes (per menu item + line items). Over a remote DB (Neon)
  // network latency pushes this past Prisma's default 5s interactive-transaction
  // timeout, so raise it generously.
  await step('persist-menu-card', async () => {
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
        for (const item of withOverhead) {
          await tx.menuItem.create({ data: toMenuItemCreateData(item, estimateId) });
        }
        // What the audit found, and what became of it. Upserted rather than
        // recreated: a re-run must not duplicate a finding or overwrite a
        // decision someone already made about it. The menu-item link IS cleared,
        // because every card above was just deleted and rebuilt.
        for (const { detection, costed } of resolvedDetections) {
          const card = costed
            ? await tx.menuItem.findFirst({
                where: { estimateId, taxonomyKey: detection.taxonomyKey ?? '', injected: true },
                select: { id: true },
              })
            : null;
          await tx.hiddenWorkFinding.upsert({
            where: { estimateId_riskFlag: { estimateId, riskFlag: detection.riskFlag } },
            update: {
              claim: detection.claim,
              citation: detection.citation,
              requirementId: detection.requirementId,
              known: detection.known,
              taxonomyKey: detection.taxonomyKey,
              menuItemId: card?.id ?? null,
            },
            create: {
              estimateId,
              riskFlag: detection.riskFlag,
              known: detection.known,
              claim: detection.claim,
              citation: detection.citation,
              requirementId: detection.requirementId,
              taxonomyKey: detection.taxonomyKey,
              outcome: costed ? 'AUTO_COST' : 'OPEN',
              menuItemId: card?.id ?? null,
            },
          });
        }

        await tx.estimate.update({
          where: { id: estimateId },
          data: {
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
              claimedRiskFlags: [...claimedFlags],
              ranAt: new Date().toISOString(),
            },
          },
        });
      },
      { maxWait: 15_000, timeout: 60_000 },
    );
    // step results are memoised as JSON; nothing here needs to survive.
    return null;
  });

  return {
    estimateId,
    status: 'REVIEW',
    complexityScore: complexity.score,
    // Everything persisted, not just what the Architect assembled — inferred
    // and overhead cards are rows on the estimate too, and a count that omitted
    // them would disagree with the editor.
    menuItemCount: withOverhead.length,
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
 * The requirement a hidden-work card is estimated against.
 *
 * There is no Librarian requirement for work the SOW never stated — that is the
 * definition of hidden work — so one is synthesised from the Detective's own
 * claim. Project-level attributes are borrowed from the requirement the risk was
 * raised against rather than defaulted, because they are what calibrate the
 * council: rate limiting for an Enterprise integration with High data volume is
 * not the same job as rate limiting for an SMB brochure site, and defaulting
 * them would quietly estimate every project as the same size.
 *
 * `archivistMatch` is deliberately omitted: describeCoverage renders that as
 * "coverage: none — build from first principles", which is exactly right here.
 */
function syntheticRequirement(
  detection: HiddenWorkDetection,
  requirements: Requirement[],
): Requirement {
  const parent = requirements.find((r) => r.id === detection.requirementId);
  return RequirementSchema.parse({
    id: `REQ-HIDDEN-${detection.riskFlag.toUpperCase()}`,
    text: `${detection.title}. Implied by the SOW but not stated in it — the Detective found: ${detection.claim}`,
    category: 'Infrastructure & Resilience',
    reqType: 'Infrastructure',
    platforms: parent?.platforms ?? [],
    projectSize: parent?.projectSize ?? 'Mid-market',
    dataVolume: parent?.dataVolume ?? 'Low',
    integrationCount: parent?.integrationCount ?? 1,
    candidateMenuCardId: detection.taxonomyKey ?? 'infra',
    taxonomyKey: detection.taxonomyKey,
    sourceRef: detection.citation,
    ambiguities: [],
    blocksEstimation: false,
  });
}

/**
 * Load active taxonomy entries for the Librarian. Returns [] until taxonomy is
 * derived from the preset library (a credential-free follow-up); the Librarian
 * tolerates an empty taxonomy.
 */
async function loadTaxonomyEntries(db: PrismaClient): Promise<TaxonomyEntry[]> {
  const versions = await db.taxonomyNodeVersion.findMany({
    // Three independent gates, and they mean different things. `active` picks
    // the current VERSION of a node. `status` decides whether the node is real
    // yet, so a PROPOSED node cannot change how requirements are classified
    // before an admin has accepted it. `classifiable` decides whether a client
    // could ask for it at all — this query IS the Librarian's whole vocabulary,
    // and offering it `process.code-review` would just give a real requirement
    // somewhere wrong to land. AEH-263.
    where: { active: true, node: { status: 'ACTIVE', classifiable: true } },
    select: { nodeKey: true, label: true, keywords: true },
  });
  return versions.map((v) => ({ key: v.nodeKey, label: v.label, keywords: v.keywords }));
}
