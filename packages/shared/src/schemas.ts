import { z } from 'zod';

// ─── Enums ───────────────────────────────────────────────────────────────────

export const RoleKindSchema = z.enum(['DEV', 'QA', 'PM', 'BA']);
export type RoleKind = z.infer<typeof RoleKindSchema>;

export const AgentKindSchema = z.enum([
  'SUPERVISOR',
  'LIBRARIAN',
  'DETECTIVE',
  'ARCHIVIST',
  'SPECIALIST_DEV',
  'SPECIALIST_QA',
  'SPECIALIST_PM',
  'SPECIALIST_BA',
  'ARCHITECT',
]);
export type AgentKind = z.infer<typeof AgentKindSchema>;

export const EstimateStatusSchema = z.enum(['DRAFT', 'REVIEW', 'FINALISED']);
export type EstimateStatus = z.infer<typeof EstimateStatusSchema>;

export const ChangeMotivationSchema = z.enum([
  'UPSKILL',
  'TECH_ADVANCEMENT',
  'NEW_PROCESS',
  'POST_DELIVERY_VALIDATION',
  'CORRECTION',
  'OTHER',
]);
export type ChangeMotivation = z.infer<typeof ChangeMotivationSchema>;

// Preset-library enums (DB/admin data, upper-case — distinct from the LLM
// envelope vocabulary below, which the live prompts dictate in Title Case).
export const DataVolumeSchema = z.enum(['NONE', 'LOW', 'HIGH']);
export type DataVolume = z.infer<typeof DataVolumeSchema>;

export const PresetPhaseSchema = z.enum(['FOUNDATION', 'CORE', 'ENHANCEMENT']);
export type PresetPhase = z.infer<typeof PresetPhaseSchema>;

export const LevelSchema = z.enum(['LOW', 'MEDIUM', 'HIGH']);
export type Level = z.infer<typeof LevelSchema>;

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
export type ReqType = z.infer<typeof ReqTypeSchema>;

/** Example platforms seen in past (ecommerce/B2B) engagements — not exhaustive. */
export const PLATFORM_EXAMPLES = ['Shopify', 'Celigo', 'Contentful', 'Klevu', 'P21', 'Act-On', 'Vercel', 'PIM'] as const;

export const PlatformSchema = z.string().trim().min(1);
export type Platform = z.infer<typeof PlatformSchema>;

/** Menu-card phase (Title Case — distinct from PresetPhaseSchema's DB casing). */
export const PhaseSchema = z.enum(['Foundation', 'Core', 'Enhancement']);
export type Phase = z.infer<typeof PhaseSchema>;

export const ProjectSizeSchema = z.enum(['SMB', 'Mid-market', 'Enterprise']);
export type ProjectSize = z.infer<typeof ProjectSizeSchema>;

/** Requirement-level data_volume (None/Low/High — distinct from DataVolumeSchema's DB casing). */
export const DataVolumeLevelSchema = z.enum(['None', 'Low', 'High']);
export type DataVolumeLevel = z.infer<typeof DataVolumeLevelSchema>;

/** ai_assist / risk (Low/Medium/High — distinct from LevelSchema's DB casing). */
export const ImpactLevelSchema = z.enum(['Low', 'Medium', 'High']);
export type ImpactLevel = z.infer<typeof ImpactLevelSchema>;

export const CoverageSchema = z.enum(['full', 'partial', 'none']);
export type Coverage = z.infer<typeof CoverageSchema>;

export const ComplexityTierSchema = z.enum(['base', 'elevated', 'high']);
export type ComplexityTier = z.infer<typeof ComplexityTierSchema>;

/** Hard cap from the FOUR-HOUR RULE global invariant: every line item ≤4.0h. */
export const FOUR_HOUR_CAP = 4.0;

// ─── Supervisor IO ────────────────────────────────────────────────────────────

export const SupervisorInputSchema = z.object({
  estimateId: z.string(),
  sowText: z.string(),
  mode: z.enum(['full', 'refine']),
  changedMenuItemIds: z.array(z.string()).optional(),
});
export type SupervisorInput = z.infer<typeof SupervisorInputSchema>;

export const SupervisorOutputSchema = z.object({
  estimateId: z.string(),
  status: EstimateStatusSchema,
});
export type SupervisorOutput = z.infer<typeof SupervisorOutputSchema>;

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

export const LibrarianInputSchema = z.object({
  sowText: z.string(),
  taxonomyVersionPin: z.number().optional(),
});
export type LibrarianInput = z.infer<typeof LibrarianInputSchema>;

export const LibrarianOutputSchema = z.object({
  requirements: z.array(RequirementSchema),
});
export type LibrarianOutput = z.infer<typeof LibrarianOutputSchema>;

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
  requires: z.array(z.string()).default([]),
  blocks: z.array(z.string()).default([]),
  canParallel: z.boolean().default(true),
});
export type Sequencing = z.infer<typeof SequencingSchema>;

export const ArchivistAdjustmentsSchema = z.object({
  /** Free-text rationale: how the preset's fit size compares to this requirement's project_size. */
  projectSizeDelta: z.string().default(''),
  dataVolume: DataVolumeLevelSchema,
  integrationCount: z.number().min(0).max(10),
  aiAssist: ImpactLevelSchema,
  risk: ImpactLevelSchema,
});
export type ArchivistAdjustments = z.infer<typeof ArchivistAdjustmentsSchema>;

export const ArchivistMatchSchema = z.object({
  requirementId: z.string(),
  /** Kept for taxonomy-admin/pgvector-match compatibility. */
  taxonomyKey: z.string().nullable().default(null),
  coverage: CoverageSchema,
  /** Absent when coverage is "none" — never fabricate a preset ID. */
  presetId: z.string().optional(),
  presetVersion: z.number().optional(),
  score: z.number().min(0).max(1).optional(),
  beHours: z.number().optional(),
  feHours: z.number().optional(),
  adjustments: ArchivistAdjustmentsSchema,
  /** Specific rationale, e.g. "matches B2B contextual pricing via @inContext, but adds volume tiers not in P28". */
  rationale: z.string(),
  sequencing: SequencingSchema.default({ requires: [], blocks: [], canParallel: true }),
});
export type ArchivistMatch = z.infer<typeof ArchivistMatchSchema>;

export const ArchivistInputSchema = z.object({
  requirements: z.array(RequirementSchema),
});
export type ArchivistInput = z.infer<typeof ArchivistInputSchema>;

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
});
export type SpecialistOutput = z.infer<typeof SpecialistOutputSchema>;

// ─── Complexity IO ────────────────────────────────────────────────────────────

export const ComplexityInputSchema = z.object({
  requirements: z.array(RequirementSchema),
  riskFindings: z.array(RiskFindingSchema),
});
export type ComplexityInput = z.infer<typeof ComplexityInputSchema>;

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
  /** MC-<DOMAIN>-<SLUG> once assembled by the Architect (or a synthetic id for injected items). */
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
  parentItemId: z.string().optional(),
  lineItems: z.array(RoleLineItemSchema),
});
export type MenuItem = z.infer<typeof MenuItemSchema>;

export const ArchitectInputSchema = z.object({
  estimateId: z.string(),
  requirements: z.array(RequirementSchema),
  archivistMatches: z.array(ArchivistMatchSchema),
  riskFindings: z.array(RiskFindingSchema),
  specialistOutputs: z.array(SpecialistOutputSchema),
  complexityScore: z.number().min(1).max(5),
});
export type ArchitectInput = z.infer<typeof ArchitectInputSchema>;

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

// ─── Validation Audit ────────────────────────────────────────────────────────

export const ValidationAuditOutputSchema = z.object({
  passed: z.boolean(),
  unreconciled: z.array(
    z.object({
      riskFlag: z.string(),
      taxonomyKey: z.string(),
      reason: z.string(),
    }),
  ),
});
export type ValidationAuditOutput = z.infer<typeof ValidationAuditOutputSchema>;

// ─── Search Provider ─────────────────────────────────────────────────────────

export const SearchResultSchema = z.object({
  title: z.string(),
  url: z.string(),
  snippet: z.string(),
});
export type SearchResult = z.infer<typeof SearchResultSchema>;
