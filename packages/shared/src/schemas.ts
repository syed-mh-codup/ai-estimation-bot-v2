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

export const DataVolumeSchema = z.enum(['NONE', 'LOW', 'HIGH']);
export type DataVolume = z.infer<typeof DataVolumeSchema>;

export const PresetPhaseSchema = z.enum(['FOUNDATION', 'CORE', 'ENHANCEMENT']);
export type PresetPhase = z.infer<typeof PresetPhaseSchema>;

export const LevelSchema = z.enum(['LOW', 'MEDIUM', 'HIGH']);
export type Level = z.infer<typeof LevelSchema>;

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
  text: z.string(),
  taxonomyKey: z.string().nullable(),
  confidence: z.number().min(0).max(1),
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

export const DetectiveFindingSchema = z.object({
  taxonomyKey: z.string(),
  claim: z.string(),
  source: z.string(),
  riskFlags: z.array(z.string()),
});
export type DetectiveFinding = z.infer<typeof DetectiveFindingSchema>;

export const DetectiveInputSchema = z.object({
  requirements: z.array(RequirementSchema),
  enabledMcpTools: z.array(z.string()),
  searchTool: z.string(),
});
export type DetectiveInput = z.infer<typeof DetectiveInputSchema>;

export const DetectiveOutputSchema = z.object({
  findings: z.array(DetectiveFindingSchema),
});
export type DetectiveOutput = z.infer<typeof DetectiveOutputSchema>;

// ─── Archivist IO ────────────────────────────────────────────────────────────

export const ArchivistMatchSchema = z.object({
  taxonomyKey: z.string(),
  presetId: z.string(),
  presetVersion: z.number(),
  score: z.number().min(0).max(1),
  beHours: z.number(),
  feHours: z.number(),
  risk: LevelSchema,
  aiAssist: LevelSchema,
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

export const MenuItemStubSchema = z.object({
  id: z.string(),
  taxonomyKey: z.string(),
  title: z.string(),
});
export type MenuItemStub = z.infer<typeof MenuItemStubSchema>;

export const SpecialistInputSchema = z.object({
  menuItem: MenuItemStubSchema,
  archivistMatch: ArchivistMatchSchema.optional(),
  detectiveFindings: z.array(DetectiveFindingSchema),
  complexityScore: z.number().min(1).max(5),
});
export type SpecialistInput = z.infer<typeof SpecialistInputSchema>;

export const SpecialistOutputSchema = z.object({
  role: RoleKindSchema,
  baseHours: z.number().min(0),
  rationale: z.string(),
  assumptions: z.array(z.string()),
});
export type SpecialistOutput = z.infer<typeof SpecialistOutputSchema>;

// ─── Complexity IO ────────────────────────────────────────────────────────────

export const ComplexityInputSchema = z.object({
  requirements: z.array(RequirementSchema),
  detectiveFindings: z.array(DetectiveFindingSchema),
});
export type ComplexityInput = z.infer<typeof ComplexityInputSchema>;

export const ComplexityOutputSchema = z.object({
  score: z.number().min(1).max(5),
  perItemMultipliers: z.record(z.string(), z.number()),
});
export type ComplexityOutput = z.infer<typeof ComplexityOutputSchema>;

// ─── Architect IO ────────────────────────────────────────────────────────────

export const RoleLineItemSchema = z.object({
  role: RoleKindSchema,
  baseHours: z.number().min(0),
  taxedHours: z.number().min(0),
  notes: z.string().optional(),
  edited: z.boolean().default(false),
});
export type RoleLineItem = z.infer<typeof RoleLineItemSchema>;

export const MenuItemSchema = z.object({
  id: z.string(),
  taxonomyKey: z.string(),
  sourcePresetId: z.string().optional(),
  matchScore: z.number().optional(),
  title: z.string(),
  enabled: z.boolean().default(true),
  parentItemId: z.string().optional(),
  lineItems: z.array(RoleLineItemSchema),
});
export type MenuItem = z.infer<typeof MenuItemSchema>;

export const ArchitectInputSchema = z.object({
  estimateId: z.string(),
  requirements: z.array(RequirementSchema),
  archivistMatches: z.array(ArchivistMatchSchema),
  detectiveFindings: z.array(DetectiveFindingSchema),
  specialistOutputs: z.array(SpecialistOutputSchema),
  complexityScore: z.number().min(1).max(5),
});
export type ArchitectInput = z.infer<typeof ArchitectInputSchema>;

export const ArchitectOutputSchema = z.object({
  narrative: z.array(z.string()),
  assumptions: z.array(z.string()),
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
