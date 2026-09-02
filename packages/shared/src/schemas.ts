import { z } from 'zod';

// ─── Enums ───────────────────────────────────────────────────────────────────

export const RoleKindSchema = z.enum(['DEV', 'QA', 'PM', 'BA']);
export type RoleKind = z.infer<typeof RoleKindSchema>;

// The preset-library / audit enums (AgentKind, EstimateStatus, ChangeMotivation,
// DataVolume, PresetPhase, Level) used to be mirrored here as zod enums. They are
// Prisma enums, and every consumer imports the generated type from @repo/db — the
// mirrors had no reader at all. Deleted in AEH-253. The LLM-envelope vocabulary
// below is NOT the same thing: it is Title Case because the live prompts say so,
// and it genuinely needs zod because it parses model output.

// ─── Classification vocabulary ─────────────────────────────────────────────
// category/req_type/platform are open, LLM-assigned labels (same pattern as
// candidate_menu_card_id) — NOT a closed enum. This system estimates a
// variety of software work, not just the ecommerce/B2B vertical the preset
// library and these example lists originated from. A closed enum forced
// every requirement into the nearest ecommerce label regardless of fit; see
// PROGRESS.md's "generalize classification vocabulary" entry. The example
// lists below exist purely as calibration reference for prompt-writing (the
// live agent prompts show the model a few worked examples per field), not as
// a validation source of truth — do not reintroduce z.enum() here.

/** Example categories seen in past (ecommerce/B2B) engagements — not exhaustive. */
export const CATEGORY_EXAMPLES = [
  'Shopify / Ecommerce',
  'B2B',
  'CMS & Content',
  'Integration / Celigo',
  'PIM & Search',
  'Dev Environment',
] as const;

export const CategorySchema = z.string().trim().min(1);
export type Category = z.infer<typeof CategorySchema>;

/** Example req_types seen in past (ecommerce/B2B) engagements — not exhaustive. */
export const REQ_TYPE_EXAMPLES = [
  'Authentication',
  'Checkout',
  'Commerce Logic',
  'Component Development',
  'Content Authoring',
  'Content Modeling',
  'Data Migration',
  'Data Modeling',
  'Data Quality',
  'Data Sync',
  'Frontend Development',
  'Infrastructure',
  'Integration',
  'Inventory',
  'Lead Capture',
  'Marketing / Feeds',
  'Payments',
  'Performance',
  'Pricing',
  'Portal',
  'Research & Discovery',
  'SEO',
  'Search',
  'Search UI',
  'Shipping',
  'Tax',
  'UI Component',
] as const;

export const ReqTypeSchema = z.string().trim().min(1);

/** Example platforms seen in past (ecommerce/B2B) engagements — not exhaustive. */
export const PLATFORM_EXAMPLES = ['Shopify', 'Celigo', 'Contentful', 'Klevu', 'P21', 'Act-On', 'Vercel', 'PIM'] as const;

export const PlatformSchema = z.string().trim().min(1);

/** Menu-card phase (Title Case — distinct from the DB enum's casing). */
export const PhaseSchema = z.enum(['Foundation', 'Core', 'Enhancement']);
export type Phase = z.infer<typeof PhaseSchema>;

export const ProjectSizeSchema = z.enum(['SMB', 'Mid-market', 'Enterprise']);

/** Requirement-level data_volume (None/Low/High — distinct from the DB enum's casing). */
export const DataVolumeLevelSchema = z.enum(['None', 'Low', 'High']);
export type DataVolumeLevel = z.infer<typeof DataVolumeLevelSchema>;

/** ai_assist / risk (Low/Medium/High — distinct from the DB enum's casing). */
export const ImpactLevelSchema = z.enum(['Low', 'Medium', 'High']);
export type ImpactLevel = z.infer<typeof ImpactLevelSchema>;

export const CoverageSchema = z.enum(['full', 'partial', 'none']);
export type Coverage = z.infer<typeof CoverageSchema>;

export const ComplexityTierSchema = z.enum(['base', 'elevated', 'high']);

/** Hard cap from the FOUR-HOUR RULE global invariant: every line item ≤4.0h. */
export const FOUR_HOUR_CAP = 4.0;

// ─── Librarian IO ────────────────────────────────────────────────────────────

export const RequirementSchema = z.object({
  /** REQ-001, REQ-002, ... (ID CONVENTIONS). */
  id: z.string(),
  text: z.string(),
  category: CategorySchema,
  reqType: ReqTypeSchema,
  platforms: z.array(PlatformSchema).default([]),
  projectSize: ProjectSizeSchema,
  dataVolume: DataVolumeLevelSchema,
  /** Distinct platform connections this requirement assumes (1–5 per the prompt). */
  integrationCount: z.number().min(0).max(10),
  /** MC-<DOMAIN>-<SLUG> — the candidate menu card the Librarian grouped this into. */
  candidateMenuCardId: z.string(),
  /** Kept for Archivist/preset-taxonomy compatibility (existing taxonomy admin + pgvector match path). */
  taxonomyKey: z.string().nullable(),
  /** SOW section/paraphrase this requirement traces back to (TRACEABILITY invariant). */
  sourceRef: z.string(),
  ambiguities: z.array(z.string()).default([]),
  /** Ambiguity severe enough that DETECTIVE must investigate before estimation. */
  blocksEstimation: z.boolean().default(false),
});
export type Requirement = z.infer<typeof RequirementSchema>;

export const LibrarianOutputSchema = z.object({
  requirements: z.array(RequirementSchema),
});
export type LibrarianOutput = z.infer<typeof LibrarianOutputSchema>;

// ─── Risk-flag vocabulary ────────────────────────────────────────────────────
// Deliberately NOT a z.enum, and for a different reason than category/req_type
// above. Those are open because the label space is genuinely unbounded. This one
// is open because closing it would cap what the Detective is allowed to notice —
// the whole point of the stage is catching work nobody thought of, and an enum
// makes the list of things nobody thought of a fixed list.
//
// Instead: these are the flags the pipeline knows how to cost WITHOUT a human,
// because each maps to a taxonomy node and can be routed through the Specialist
// council. Anything else the Detective emits is not discarded — it surfaces as an
// unreconciled finding for someone to promote or dismiss. That inversion is the
// safety net that makes leaving the vocabulary open safe.
//
// Three copies of this list used to exist and no two agreed: the prompt taught
// `api-quota` with no cost mapping, while the cost table carried
// `data-remediation` and `webhook-reliability` that the prompt never mentioned,
// so those two could only ever fire by luck. One list now, interpolated into the
// prompt and keyed by the cost table, so they cannot drift again. AEH-263.
export const KNOWN_RISK_FLAGS = [
  'rate-limits',
  'retries',
  'data-migration',
  'legacy-system',
  'api-quota',
  'webhook-reliability',
] as const;
export type KnownRiskFlag = (typeof KNOWN_RISK_FLAGS)[number];

export function isKnownRiskFlag(flag: string): flag is KnownRiskFlag {
  return (KNOWN_RISK_FLAGS as readonly string[]).includes(flag);
}

// ─── Detective IO ────────────────────────────────────────────────────────────

export const RiskFindingSchema = z.object({
  /** RISK-001, ... */
  id: z.string(),
  requirementId: z.string(),
  /** Kept for audit.ts/hidden-work compatibility; derived from the linked requirement. */
  taxonomyKey: z.string().nullable().default(null),
  platform: PlatformSchema.optional(),
  claim: z.string(),
  riskFlags: z.array(z.string()).default([]),
  /** SOW location or external source citation — never assert without one. */
  citation: z.string(),
  spikeRecommended: z.boolean().default(false),
  /** Maps to an existing spike preset (P01–P06) where one fits. */
  spikePresetId: z.string().optional(),
});
export type RiskFinding = z.infer<typeof RiskFindingSchema>;

export const OpenQuestionSchema = z.object({
  /** Q-001, ... */
  id: z.string(),
  requirementId: z.string(),
  question: z.string(),
  citation: z.string().optional(),
  blocksEstimation: z.boolean().default(false),
});
export type OpenQuestion = z.infer<typeof OpenQuestionSchema>;

export const DetectiveInputSchema = z.object({
  requirements: z.array(RequirementSchema),
  enabledMcpTools: z.array(z.string()),
  searchTool: z.string(),
});
export type DetectiveInput = z.infer<typeof DetectiveInputSchema>;

export const DetectiveOutputSchema = z.object({
  risks: z.array(RiskFindingSchema),
  questions: z.array(OpenQuestionSchema),
});
export type DetectiveOutput = z.infer<typeof DetectiveOutputSchema>;

// ─── Archivist IO ────────────────────────────────────────────────────────────

export const SequencingSchema = z.object({
  /**
   * Preset ids this preset needs delivered before it — resolved transitively
   * from the dependency graph (AEH-242), not the loose code strings the old
   * `requires`/`blocks` arrays held.
   *
   * PRESET ids, never requirement ids. Conflating the two is exactly what left
   * `notSafelyRemovable` dead in production: the Architect tested these values
   * against `REQ-001`-shaped ids they could never match, and the only test
   * covering it hand-fed a shape the Archivist never produced. The name says
   * which it is so that cannot recur.
   */
  prerequisitePresetIds: z.array(z.string()).default([]),
  canParallel: z.boolean().default(true),
});

export const ArchivistAdjustmentsSchema = z.object({
  /** Free-text rationale: how the preset's fit size compares to this requirement's project_size. */
  projectSizeDelta: z.string().default(''),
  dataVolume: DataVolumeLevelSchema,
  integrationCount: z.number().min(0).max(10),
  aiAssist: ImpactLevelSchema,
  risk: ImpactLevelSchema,
});

export const ArchivistMatchSchema = z.object({
  requirementId: z.string(),
  /** Kept for taxonomy-admin/pgvector-match compatibility. */
  taxonomyKey: z.string().nullable().default(null),
  coverage: CoverageSchema,
  /** Absent when coverage is "none" — never fabricate a preset ID. */
  presetId: z.string().optional(),
  presetVersion: z.number().optional(),
  score: z.number().min(0).max(1).optional(),
  /** The matched preset's dev effort as one figure (never divided). */
  devHours: z.number().optional(),
  /** Which sides that preset's work covered — reference only. */
  touchesFrontend: z.boolean().optional(),
  touchesBackend: z.boolean().optional(),
  adjustments: ArchivistAdjustmentsSchema,
  /** Specific rationale, e.g. "matches B2B contextual pricing via @inContext, but adds volume tiers not in P28". */
  rationale: z.string(),
  sequencing: SequencingSchema.default({ prerequisitePresetIds: [], canParallel: true }),
  /**
   * What the matched preset records about DELIVERING this kind of work, as
   * opposed to sizing it: its notes (assumptions and exclusions an admin typed),
   * whether it historically needed a discovery spike, and what its sequencing
   * implies. These are statements about the estimate, so the Architect folds
   * them into `assumptions` rather than into hours.
   */
  presetCaveats: z.array(z.string()).default([]),
  /**
   * The matched preset's delivery phase, in the menu-card vocabulary. A prior,
   * not a verdict: the Architect's own LLM judgment wins where it has one, and
   * this fills the gap where it doesn't.
   */
  presetPhase: PhaseSchema.optional(),
});
export type ArchivistMatch = z.infer<typeof ArchivistMatchSchema>;

export const ArchivistOutputSchema = z.object({
  matches: z.array(ArchivistMatchSchema),
});
export type ArchivistOutput = z.infer<typeof ArchivistOutputSchema>;

// ─── Specialist IO ────────────────────────────────────────────────────────────

export const SpecialistInputSchema = z.object({
  requirement: RequirementSchema,
  menuCardId: z.string(),
  archivistMatch: ArchivistMatchSchema.optional(),
  riskFindings: z.array(RiskFindingSchema).default([]),
  complexityScore: z.number().min(1).max(5),
});
export type SpecialistInput = z.infer<typeof SpecialistInputSchema>;

/** One atomic, ≤4h unit of work (SPECIALIST_* METHOD: DECOMPOSE until every item is ≤4.0h). */
export const SpecialistLineItemSchema = z.object({
  /** <ROLE>-<REQ###>-<NN>, e.g. DEV-REQ003-04. */
  id: z.string(),
  requirementId: z.string(),
  menuCardId: z.string(),
  description: z.string(),
  hours: z.number().min(0.25).max(FOUR_HOUR_CAP),
  complexity: ComplexityTierSchema,
  aiAssistApplied: z.boolean().default(false),
  /** Intra-requirement ordering — other line_item_ids this depends on. */
  dependsOn: z.array(z.string()).default([]),
  anchorPresetIds: z.array(z.string()).default([]),
  /**
   * Which side of the stack this unit touches. DEV tags these; the other roles
   * leave them false. The hours are never divided by them.
   */
  touchesFrontend: z.boolean().default(false),
  touchesBackend: z.boolean().default(false),
});
export type SpecialistLineItem = z.infer<typeof SpecialistLineItemSchema>;

export const SpecialistOutputSchema = z.object({
  role: RoleKindSchema,
  lineItems: z.array(SpecialistLineItemSchema),
  assumptions: z.array(z.string()).default([]),
  /**
   * Which of the Detective's risk flags these hours actually account for.
   *
   * The coverage question — "did anyone cost the rate limiting?" — used to be
   * answered by comparing a card's taxonomyKey against a flag's, which could
   * never match: the Architect writes its own MC-<DOMAIN>-<SLUG> id into that
   * field, so the comparison was between two different kinds of string. Asking
   * the estimator to declare it makes coverage a fact somebody asserted rather
   * than a string coincidence, and it is what lets Oracle answer which risks
   * were claimed and what happened to them.
   *
   * Defaults to empty, which reads as "claimed nothing" — the safe direction,
   * since an unclaimed flag surfaces to a human rather than being dropped.
   */
  coversRiskFlags: z.array(z.string()).default([]),
});
export type SpecialistOutput = z.infer<typeof SpecialistOutputSchema>;

// ─── Complexity IO ────────────────────────────────────────────────────────────

export const ComplexityOutputSchema = z.object({
  score: z.number().min(1).max(5),
  perItemMultipliers: z.record(z.string(), z.number()),
});
export type ComplexityOutput = z.infer<typeof ComplexityOutputSchema>;

// ─── Architect IO ────────────────────────────────────────────────────────────

export const RoleLineItemSchema = z.object({
  /** <ROLE>-<REQ###>-<NN>; optional for legacy/injected rows (baseline, hidden-work). */
  id: z.string().optional(),
  role: RoleKindSchema,
  /** Short description of this atomic unit of work. */
  title: z.string().optional(),
  requirementId: z.string().optional(),
  baseHours: z.number().min(0),
  taxedHours: z.number().min(0),
  complexity: ComplexityTierSchema.optional(),
  aiAssistApplied: z.boolean().default(false),
  dependsOn: z.array(z.string()).default([]),
  anchorPresetIds: z.array(z.string()).default([]),
  notes: z.string().optional(),
  edited: z.boolean().default(false),
  /**
   * Which side of the stack this unit touches (DEV only). The hours stay one
   * combined number — these describe what it covers, they don't divide it.
   * Both false means untagged; both true means genuinely full-stack.
   */
  touchesFrontend: z.boolean().default(false),
  touchesBackend: z.boolean().default(false),
});
export type RoleLineItem = z.infer<typeof RoleLineItemSchema>;

export const MenuItemSchema = z.object({
  /**
   * MC-<DOMAIN>-<SLUG> as assembled by the Architect, and the row's cuid once
   * persisted — `run-estimate` does not pass `id` on create, so the Architect's
   * value does not survive the write. Anything reading a card back from the DB
   * (promotion keys `sourceMenuItemId` on it) sees the cuid. AEH-227.
   */
  id: z.string(),
  taxonomyKey: z.string(),
  category: CategorySchema.optional(),
  phase: PhaseSchema.optional(),
  requirementIds: z.array(z.string()).default([]),
  sourcePresetId: z.string().optional(),
  matchScore: z.number().optional(),
  title: z.string(),
  enabled: z.boolean().default(true),
  /** Whether the whole card can be toggled off for cost optimisation. */
  toggleable: z.boolean().default(true),
  /** Foundation/spike cards with Requires-chain dependents. */
  notSafelyRemovable: z.boolean().default(false),
  /** Tags the thin vertical slice cards giving the earliest demoable path. */
  thinSlice: z.boolean().default(false),
  /**
   * An injected placeholder (hidden-work audit), not delivered feature work.
   * Promotion reads this to keep placeholders out of the preset library.
   *
   * A real DB column, not a `meta` key: behaviour depends on reading it, and
   * `meta` is write-only throughout this repo. The guard it replaces keyed on
   * an `id` string prefix that persistence discards. See AEH-227.
   */
  injected: z.boolean().default(false),
  lineItems: z.array(RoleLineItemSchema),
});
export type MenuItem = z.infer<typeof MenuItemSchema>;

export const ArchitectOutputSchema = z.object({
  /** Sentences of ONE cohesive 8–15 sentence narrative (kept as an array — DB/UI already render narrative as a bullet list). */
  narrative: z.array(z.string()),
  assumptions: z.array(z.string()),
  /** Pulled through from DETECTIVE unchanged. */
  openQuestions: z.array(z.string()).default([]),
  /** e.g. a line item found >4.0h — Architect must flag, not silently fix. */
  consistencyFlags: z.array(z.string()).default([]),
  menuItems: z.array(MenuItemSchema),
});
export type ArchitectOutput = z.infer<typeof ArchitectOutputSchema>;

// ─── Search Provider ─────────────────────────────────────────────────────────

export const SearchResultSchema = z.object({
  title: z.string(),
  url: z.string(),
  snippet: z.string(),
});
export type SearchResult = z.infer<typeof SearchResultSchema>;
