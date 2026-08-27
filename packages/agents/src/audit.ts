import type { KnownRiskFlag, MenuItem, RiskFinding, SpecialistOutput } from '@repo/shared';
import { MenuItemSchema, isKnownRiskFlag } from '@repo/shared';

// ─── WS15-01: Hidden-Work Audit ───────────────────────────────────────────────

/**
 * What each known risk flag costs as, and where it lands in the taxonomy.
 *
 * Typed as a total Record over KnownRiskFlag, which is the point: adding a flag
 * to KNOWN_RISK_FLAGS without giving it a title and a taxonomy key is a compile
 * error, not a flag that silently costs nothing. Every key here is a real,
 * seeded TaxonomyNode — they were invented strings until AEH-263, because
 * taxonomy keys were derived from the preset library and no preset is `infra`.
 *
 * Aliases are deliberately absent. `data-remediation` used to map here as a
 * second name for data-migration; now an off-list name surfaces to a human,
 * which is a better answer than a synonym table nobody maintains.
 */
const HIDDEN_WORK_FLAGS: Record<KnownRiskFlag, { title: string; taxonomyKey: string }> = {
  'retries': { title: 'Retry & Error Handling Middleware', taxonomyKey: 'infra.retries' },
  'rate-limits': { title: 'Rate Limit Management & Throttling', taxonomyKey: 'infra.rate-limit' },
  'api-quota': { title: 'API Quota Management', taxonomyKey: 'infra.api-quota' },
  'data-migration': { title: 'Data Remediation & Migration', taxonomyKey: 'infra.data-migration' },
  'legacy-system': { title: 'Legacy System Integration Adapter', taxonomyKey: 'infra.legacy-adapter' },
  'webhook-reliability': { title: 'Webhook Reliability & Dead Letter Queue', taxonomyKey: 'infra.webhook' },
};

/**
 * A risk the Detective raised that no specialist costed.
 *
 * `known` is the whole fork. A known flag has somewhere to put the work and can
 * be routed through the Specialist council without asking anyone. An off-list
 * one cannot — nobody has said what "soc2-audit" is worth or where it belongs —
 * so it goes to a person. What it must never do is vanish, which is what the old
 * `unknown flag = not our concern` branch did.
 */
export type HiddenWorkDetection = {
  riskFlag: string;
  known: boolean;
  /** Present only for known flags — the off-list ones have no agreed name yet. */
  title: string | null;
  taxonomyKey: string | null;
  /** The Detective's own words, so a human deciding has the argument in front of them. */
  claim: string;
  citation: string;
  requirementId: string;
};

/**
 * Every risk flag nobody claimed, in the order the Detective raised them.
 *
 * Deduplicated by flag: two requirements both worrying about rate limits is one
 * piece of work, not two. The first finding wins, so the claim and citation
 * shown to a human are the first place the risk was actually argued.
 */
export function detectHiddenWork(
  findings: RiskFinding[],
  claimedFlags: Iterable<string>,
): HiddenWorkDetection[] {
  const claimed = new Set(claimedFlags);
  const seen = new Set<string>();
  const out: HiddenWorkDetection[] = [];

  for (const finding of findings) {
    for (const flag of finding.riskFlags) {
      if (claimed.has(flag) || seen.has(flag)) continue;
      seen.add(flag);
      const config = isKnownRiskFlag(flag) ? HIDDEN_WORK_FLAGS[flag] : null;
      out.push({
        riskFlag: flag,
        known: config !== null,
        title: config?.title ?? null,
        taxonomyKey: config?.taxonomyKey ?? null,
        claim: finding.claim,
        citation: finding.citation,
        requirementId: finding.requirementId,
      });
    }
  }

  return out;
}

/** Every flag any specialist said its hours account for. */
export function claimedRiskFlags(outputs: SpecialistOutput[]): Set<string> {
  const claimed = new Set<string>();
  for (const o of outputs) for (const f of o.coversRiskFlags) claimed.add(f);
  return claimed;
}

/**
 * Build the costed card for a detected risk from the council's estimate of it.
 *
 * The hours are the council's, not a table's. A flat DEV8/QA4/PM2/BA2 default
 * used to live here, and it was the feature's worst idea: an invented number
 * rendered identically to four agents' deliberation, inside a total someone
 * sends a client. If the council cannot produce hours the caller records an
 * open finding instead — a question a human answers, never a guess.
 *
 * `taxedHours` deliberately mirrors `baseHours` here and is overwritten a moment
 * later: injection runs BEFORE applyTaxationToMenuItems precisely so these hours
 * are taxed like any others. The older injectors set the two equal permanently
 * and skipped taxation, which only made sense while the hours were fictional.
 */
export function buildInjectedMenuItem(
  detection: HiddenWorkDetection,
  outputs: SpecialistOutput[],
): MenuItem | null {
  if (!detection.taxonomyKey || !detection.title) return null;

  const lineItems = outputs.flatMap((o) =>
    o.lineItems.map((li) => ({
      role: o.role,
      title: li.description,
      baseHours: li.hours,
      taxedHours: li.hours,
      complexity: li.complexity,
      aiAssistApplied: li.aiAssistApplied,
      dependsOn: li.dependsOn,
      anchorPresetIds: li.anchorPresetIds,
      touchesFrontend: li.touchesFrontend,
      touchesBackend: li.touchesBackend,
      edited: false,
    })),
  );
  if (lineItems.length === 0) return null;

  return MenuItemSchema.parse({
    // In-flight only. Persistence mints a cuid and drops this, which is why
    // `injected` is a column rather than an id prefix. AEH-227.
    id: `hidden-${detection.riskFlag}`,
    taxonomyKey: detection.taxonomyKey,
    title: detection.title,
    enabled: true,
    injected: true,
    requirementIds: [detection.requirementId],
    toggleable: true,
    notSafelyRemovable: false,
    thinSlice: false,
    lineItems,
  });
}
