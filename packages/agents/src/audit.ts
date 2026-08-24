import type { MenuItem, RiskFinding, ValidationAuditOutput } from '@repo/shared';
import { ValidationAuditOutputSchema } from '@repo/shared';

// ─── WS15-01: Hidden-Work Audit ───────────────────────────────────────────────

/**
 * Risk flags that imply hidden work requiring their own line item.
 */
const HIDDEN_WORK_FLAGS: Record<string, { title: string; taxonomyKey: string }> = {
  'retries': { title: 'Retry & Error Handling Middleware', taxonomyKey: 'infra.retries' },
  'rate-limits': { title: 'Rate Limit Management & Throttling', taxonomyKey: 'infra.rate-limit' },
  'data-migration': { title: 'Data Remediation & Migration', taxonomyKey: 'infra.data-migration' },
  'data-remediation': { title: 'Data Remediation & Migration', taxonomyKey: 'infra.data-migration' },
  'legacy-system': { title: 'Legacy System Integration Adapter', taxonomyKey: 'infra.legacy-adapter' },
  'webhook-reliability': { title: 'Webhook Reliability & Dead Letter Queue', taxonomyKey: 'infra.webhook' },
};

const HIDDEN_WORK_DEFAULT_HOURS = { DEV: 8, QA: 4, PM: 2, BA: 2 } as const;

/**
 * Check if a risk flag already has a corresponding line item in menu items.
 */
function hasLineItemForFlag(menuItems: MenuItem[], flag: string): boolean {
  const config = HIDDEN_WORK_FLAGS[flag];
  if (!config) return true; // unknown flag = not our concern
  return menuItems.some((m) => m.taxonomyKey === config.taxonomyKey);
}

/**
 * Ensure every unmodelled risk flag from Detective findings has a menu item.
 * Returns the updated menu items list (may have new items appended).
 */
export function runHiddenWorkAudit(
  menuItems: MenuItem[],
  findings: RiskFinding[],
): MenuItem[] {
  const allFlags = [...new Set(findings.flatMap((f) => f.riskFlags))];
  const result = [...menuItems];

  for (const flag of allFlags) {
    if (hasLineItemForFlag(result, flag)) continue;
    const config = HIDDEN_WORK_FLAGS[flag];
    if (!config) continue;

    // Add a new menu item for this hidden work
    result.push({
      // The id is for in-flight identification only — persistence mints a cuid
      // and drops this, which is why `injected` is a column and not an id
      // prefix. Promotion keys on the column. AEH-227.
      id: `hidden-${flag}-${Date.now()}`,
      taxonomyKey: config.taxonomyKey,
      title: config.title,
      enabled: true,
      injected: true,
      requirementIds: [],
      toggleable: true,
      notSafelyRemovable: false,
      thinSlice: false,
      lineItems: (['DEV', 'QA', 'PM', 'BA'] as const).map((role) => ({
        role,
        baseHours: HIDDEN_WORK_DEFAULT_HOURS[role],
        taxedHours: HIDDEN_WORK_DEFAULT_HOURS[role],
        edited: false,
        aiAssistApplied: false,
        dependsOn: [],
        anchorPresetIds: [],
        // Injected hidden-work placeholders carry no side; writeback skips them.
        touchesFrontend: false,
        touchesBackend: false,
      })),
    });
  }

  return result;
}

// ─── WS15-02: Validation Audit gate ──────────────────────────────────────────

/**
 * Cross-check Detective risk flags against Specialist buffers.
 * A risk flag is "unreconciled" if:
 *   - It's a known high-risk flag (rate-limits, retries, etc.)
 *   - No menu item explicitly covers it (i.e., hidden-work audit was skipped or insufficient)
 *   - The specialist hours for the affected taxonomy key seem too low
 */
export function runValidationAudit(
  menuItems: MenuItem[],
  findings: RiskFinding[],
): ValidationAuditOutput {
  const unreconciled: Array<{ riskFlag: string; taxonomyKey: string; reason: string }> = [];

  for (const finding of findings) {
    for (const flag of finding.riskFlags) {
      // Check if the flag is a known high-risk flag
      if (!HIDDEN_WORK_FLAGS[flag]) continue;

      // Check if there's a menu item covering this risk
      const covered = menuItems.some(
        (m) =>
          m.taxonomyKey === HIDDEN_WORK_FLAGS[flag]!.taxonomyKey ||
          m.taxonomyKey === finding.taxonomyKey,
      );

      if (!covered) {
        unreconciled.push({
          riskFlag: flag,
          taxonomyKey: finding.taxonomyKey ?? 'unknown',
          reason: `Risk flag '${flag}' detected in ${finding.taxonomyKey ?? 'unknown'} but no buffered line item found`,
        });
      }
    }
  }

  return ValidationAuditOutputSchema.parse({
    passed: unreconciled.length === 0,
    unreconciled,
  });
}

// ─── WS15-03: Reconciliation / acknowledge path ───────────────────────────────

export type AcknowledgementRecord = {
  riskFlag: string;
  taxonomyKey: string;
  acknowledgedBy: string;
  note: string;
  acknowledgedAt: Date;
};

/**
 * Acknowledge an unreconciled item with a note.
 * Returns updated audit result with acknowledged items removed from unreconciled.
 */
export function acknowledgeUnreconciled(
  auditResult: ValidationAuditOutput,
  acknowledgements: AcknowledgementRecord[],
): { audit: ValidationAuditOutput; recorded: AcknowledgementRecord[] } {
  const ackKeys = new Set(acknowledgements.map((a) => `${a.riskFlag}::${a.taxonomyKey}`));

  const remaining = auditResult.unreconciled.filter(
    (u) => !ackKeys.has(`${u.riskFlag}::${u.taxonomyKey}`),
  );

  return {
    audit: ValidationAuditOutputSchema.parse({
      passed: remaining.length === 0,
      unreconciled: remaining,
    }),
    recorded: acknowledgements,
  };
}
