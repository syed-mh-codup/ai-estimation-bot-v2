import { z } from 'zod';
import { MenuItemSchema, type MenuItem, type RoleLineItem, type RoleKind } from '@repo/shared';

// ─── Config shapes (read from EstimationConfig) ────────────────────────────────

export type TaxationConfig = {
  pmCommunicationTaxPct: number;
  baCommunicationTaxPct: number;
  qaRegressionBufferPct: number;
};

/**
 * Standing delivery overhead, expressed as a percentage of the work it attaches
 * to rather than a flat number of hours.
 *
 * Flat hours were the original design and they misprice by an order of
 * magnitude at the extremes: 24h of ceremony is 6% of a nine-month build and
 * 120% of a two-week one. A percentage scales, and it is the same mechanism the
 * PM/BA/QA taxes beside it already use — so nobody has to learn two models for
 * the same kind of cost.
 *
 * What makes this different from those taxes is that it renders as a named card
 * the estimator can see, argue with, edit or delete, instead of a multiplier
 * applied silently behind the total.
 */
export const ProcessOverheadItemSchema = z.object({
  title: z.string(),
  taxonomyKey: z.string(),
  /** Percent of each role's asked-for hours. Omit a role to charge it nothing. */
  pct: z.record(z.enum(['DEV', 'QA', 'PM', 'BA']), z.number().min(0).max(100)),
});
export type ProcessOverheadItem = z.infer<typeof ProcessOverheadItemSchema>;

export const ProcessOverheadSchema = z.object({
  items: z.array(ProcessOverheadItemSchema),
});
export type ProcessOverhead = z.infer<typeof ProcessOverheadSchema>;

// ─── WS14-01: Taxation engine ─────────────────────────────────────────────────

/** Round to the nearest 0.25h — line items are atomic <=4h units at 0.25h granularity (FOUR-HOUR RULE), so whole-hour rounding would visibly distort them. */
function roundToQuarterHour(hours: number): number {
  return Math.round(hours * 4) / 4;
}

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
      taxedHours: roundToQuarterHour(item.baseHours * (1 + taxPct)),
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

// ─── WS14-02: Delivery-overhead injector ─────────────────────────────────────

/**
 * Add the work every project carries and no statement of work mentions.
 *
 * Sized against the ASKED-FOR cards only (`injected: false`), which keeps two
 * things from happening: overhead compounding on overhead, and hidden-work cards
 * inflating the ceremony budget for work that may yet be dismissed.
 *
 * Nothing here re-prices what applyTaxationToMenuItems already priced, and the
 * boundary is worth stating precisely because it is easy to get wrong:
 *
 *   pmCommunicationTaxPct prices THE PM'S OWN hours in a meeting.
 *   process.meetings prices the DEV and QA seats at that same meeting, which
 *   nothing priced before.
 *
 *   qaRegressionBufferPct prices the REGRESSION SWEEP after a change.
 *   process.ticket-reopens prices the churn each individual re-open costs —
 *   writing the bug up, switching back, re-fixing, re-reviewing.
 *
 * So every hour is claimed by exactly one mechanism. Percentages are taken over
 * TAXED hours (the hours a role will really spend) and the resulting cards are
 * not taxed again, which is why this runs after taxation rather than before —
 * the opposite of the hidden-work stage, and for the opposite reason.
 */
export function injectProcessOverhead(
  menuItems: MenuItem[],
  overhead: ProcessOverhead,
): MenuItem[] {
  const askedFor = menuItems.filter((m) => !m.injected && m.enabled);
  const byRole: Record<RoleKind, number> = { DEV: 0, QA: 0, PM: 0, BA: 0 };
  for (const item of askedFor) {
    for (const li of item.lineItems) byRole[li.role] += li.taxedHours;
  }

  const cards: MenuItem[] = [];
  for (const spec of overhead.items) {
    const lineItems: RoleLineItem[] = [];
    for (const role of ['DEV', 'QA', 'PM', 'BA'] as const) {
      const pct = spec.pct[role];
      if (!pct) continue;
      const hours = roundToQuarterHour((byRole[role] * pct) / 100);
      if (hours <= 0) continue;
      lineItems.push({
        role,
        title: `${spec.title} — ${pct}% of ${role}`,
        baseHours: hours,
        // Not taxed again: the percentage was taken over taxed hours already.
        taxedHours: hours,
        edited: false,
        aiAssistApplied: false,
        dependsOn: [],
        anchorPresetIds: [],
        touchesFrontend: false,
        touchesBackend: false,
      });
    }
    // An estimate with no QA work should not carry a QA-only overhead card.
    if (lineItems.length === 0) continue;

    cards.push(
      MenuItemSchema.parse({
        // In-flight only; persistence mints a cuid. AEH-227.
        id: `overhead-${spec.taxonomyKey}`,
        taxonomyKey: spec.taxonomyKey,
        title: spec.title,
        enabled: true,
        injected: true,
        requirementIds: [],
        toggleable: true,
        notSafelyRemovable: false,
        thinSlice: false,
        lineItems,
      }),
    );
  }

  return [...menuItems, ...cards];
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

/**
 * Starting percentages. Deliberately conservative, and deliberately visible:
 * an admin edits these at /admin/config, and an estimator can delete any card
 * they produce. The taxonomy keys are real seeded nodes, none of which the
 * Librarian will ever classify a requirement into — see TaxonomyNode.classifiable.
 */
export const DEFAULT_PROCESS_OVERHEAD: ProcessOverhead = {
  items: [
    {
      title: 'Code Review',
      taxonomyKey: 'process.code-review',
      pct: { DEV: 8 },
    },
    {
      title: 'Unit Testing',
      taxonomyKey: 'process.unit-testing',
      pct: { DEV: 10 },
    },
    {
      title: 'Manual End-to-End Passes',
      taxonomyKey: 'process.manual-e2e',
      pct: { QA: 15 },
    },
    {
      // The DEV and QA seats at meetings the PM/BA taxes only cover their own.
      title: 'Meeting Attendance',
      taxonomyKey: 'process.meetings',
      pct: { DEV: 5, QA: 5 },
    },
    {
      // Per-reopen churn, distinct from the QA regression sweep.
      title: 'Ticket Re-open Churn',
      taxonomyKey: 'process.ticket-reopens',
      pct: { DEV: 5, QA: 5 },
    },
  ],
};
