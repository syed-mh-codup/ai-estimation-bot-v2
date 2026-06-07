import { z } from 'zod';
import type { MenuItem, RoleLineItem, RoleKind } from '@repo/shared';

// ─── Config shapes (read from EstimationConfig) ────────────────────────────────

export type TaxationConfig = {
  pmCommunicationTaxPct: number;
  baCommunicationTaxPct: number;
  qaRegressionBufferPct: number;
};

export const InfraBaselineItemSchema = z.object({
  title: z.string(),
  taxonomyKey: z.string(),
  roles: z.record(
    z.enum(['DEV', 'QA', 'PM', 'BA']),
    z.number(),
  ),
});
export type InfraBaselineItem = z.infer<typeof InfraBaselineItemSchema>;

export const InfraBaselineSchema = z.object({
  items: z.array(InfraBaselineItemSchema),
});
export type InfraBaseline = z.infer<typeof InfraBaselineSchema>;

// ─── WS14-01: Taxation engine ─────────────────────────────────────────────────

/**
 * Apply taxation to a role line item: taxedHours = baseHours * (1 + pct).
 * Pure function.
 */
export function applyTaxation(
  lineItems: RoleLineItem[],
  config: TaxationConfig,
): RoleLineItem[] {
  return lineItems.map((item) => {
    let taxPct = 0;
    if (item.role === 'PM') taxPct = config.pmCommunicationTaxPct;
    if (item.role === 'BA') taxPct = config.baCommunicationTaxPct;
    if (item.role === 'QA') taxPct = config.qaRegressionBufferPct;
    // DEV: no communication tax (complexity multiplier already applied)
    return {
      ...item,
      taxedHours: Math.round(item.baseHours * (1 + taxPct)),
    };
  });
}

/**
 * Apply taxation to all line items across all menu items.
 */
export function applyTaxationToMenuItems(
  menuItems: MenuItem[],
  config: TaxationConfig,
): MenuItem[] {
  return menuItems.map((item) => ({
    ...item,
    lineItems: applyTaxation(item.lineItems, config),
  }));
}

// ─── WS14-02: Infrastructure baseline injector ────────────────────────────────

const BASELINE_ID_PREFIX = 'baseline';

/**
 * Inject mandatory infrastructure menu items (env-setup, CI/CD, hypercare).
 * Each appears once per estimate, sourced from config.
 * Idempotent: won't add if already present.
 */
export function injectInfraBaseline(
  menuItems: MenuItem[],
  infraBaseline: unknown,
  config: TaxationConfig,
): MenuItem[] {
  const baseline = InfraBaselineSchema.parse(infraBaseline);

  const existingBaselineIds = new Set(
    menuItems.filter((m) => m.id.startsWith(BASELINE_ID_PREFIX)).map((m) => m.id),
  );

  const baselineItems: MenuItem[] = baseline.items
    .filter((bi) => !existingBaselineIds.has(`${BASELINE_ID_PREFIX}-${bi.taxonomyKey}`))
    .map((bi) => {
      const lineItems: RoleLineItem[] = (Object.entries(bi.roles) as [RoleKind, number][]).map(
        ([role, hours]) => ({
          role,
          baseHours: hours,
          taxedHours: hours, // baseline items don't get taxed again
          edited: false,
        }),
      );

      return {
        id: `${BASELINE_ID_PREFIX}-${bi.taxonomyKey}`,
        taxonomyKey: bi.taxonomyKey,
        title: bi.title,
        enabled: true,
        lineItems,
      };
    });

  return [...menuItems, ...baselineItems];
}

// ─── WS14-03: Read from active EstimationConfig ──────────────────────────────

/**
 * Parse taxation config from EstimationConfig DB record.
 */
export function parseTaxationConfig(configRecord: {
  pmCommunicationTaxPct: number;
  baCommunicationTaxPct: number;
  qaRegressionBufferPct: number;
}): TaxationConfig {
  return {
    pmCommunicationTaxPct: configRecord.pmCommunicationTaxPct,
    baCommunicationTaxPct: configRecord.baCommunicationTaxPct,
    qaRegressionBufferPct: configRecord.qaRegressionBufferPct,
  };
}

export const DEFAULT_INFRA_BASELINE: InfraBaseline = {
  items: [
    {
      title: 'Environment Setup & DevOps',
      taxonomyKey: 'baseline.env-setup',
      roles: { DEV: 16, QA: 8, PM: 4, BA: 2 },
    },
    {
      title: 'CI/CD Pipeline',
      taxonomyKey: 'baseline.cicd',
      roles: { DEV: 12, QA: 4, PM: 2, BA: 0 },
    },
    {
      title: 'Hypercare & Post-Launch Support',
      taxonomyKey: 'baseline.hypercare',
      roles: { DEV: 8, QA: 8, PM: 4, BA: 2 },
    },
  ],
};
