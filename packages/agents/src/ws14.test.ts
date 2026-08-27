import { describe, it, expect } from 'vitest';
import {
  applyTaxation,
  injectProcessOverhead,
  parseTaxationConfig,
  DEFAULT_PROCESS_OVERHEAD,
  type TaxationConfig,
} from './taxation';
import { MenuItemSchema, RoleLineItemSchema, type RoleLineItem, type MenuItem } from '@repo/shared';

const config: TaxationConfig = {
  pmCommunicationTaxPct: 0.15,
  baCommunicationTaxPct: 0.10,
  qaRegressionBufferPct: 0.20,
};

function makeLineItem(role: 'DEV' | 'QA' | 'PM' | 'BA', baseHours: number): RoleLineItem {
  return RoleLineItemSchema.parse({ role, baseHours, taxedHours: baseHours, edited: false });
}

function makeMenuItem(id: string, lineItems: RoleLineItem[]): MenuItem {
  return MenuItemSchema.parse({
    id,
    taxonomyKey: 'test.item',
    title: 'Test Item',
    enabled: true,
    lineItems,
  });
}

// ─── WS14-01: Taxation engine ─────────────────────────────────────────────────

describe('WS14-01: Taxation — taxedHours = base * (1 + pct) per role from config', () => {
  it('PM taxed at pmCommunicationTaxPct', () => {
    const items = applyTaxation([makeLineItem('PM', 10)], config);
    expect(items[0]!.taxedHours).toBe(11.5);
  });

  it('BA taxed at baCommunicationTaxPct', () => {
    const items = applyTaxation([makeLineItem('BA', 10)], config);
    expect(items[0]!.taxedHours).toBe(Math.round(10 * 1.10));
  });

  it('QA taxed at qaRegressionBufferPct', () => {
    const items = applyTaxation([makeLineItem('QA', 20)], config);
    expect(items[0]!.taxedHours).toBe(Math.round(20 * 1.20));
  });

  it('DEV not taxed (taxedHours == baseHours)', () => {
    const items = applyTaxation([makeLineItem('DEV', 50)], config);
    expect(items[0]!.taxedHours).toBe(50);
  });

  it('applies to all roles in a mixed list', () => {
    const lineItems = [
      makeLineItem('DEV', 50),
      makeLineItem('QA', 20),
      makeLineItem('PM', 10),
      makeLineItem('BA', 12),
    ];
    const taxed = applyTaxation(lineItems, config);
    expect(taxed.find((r) => r.role === 'DEV')!.taxedHours).toBe(50);
    expect(taxed.find((r) => r.role === 'QA')!.taxedHours).toBe(24);
    expect(taxed.find((r) => r.role === 'PM')!.taxedHours).toBe(11.5);
    expect(taxed.find((r) => r.role === 'BA')!.taxedHours).toBe(13.25);
  });
});

// ─── WS14-02: Delivery-overhead injector ─────────────────────────────────────

describe('WS14-02: Delivery overhead — scales with the work it attaches to', () => {
  it('charges each role a percentage of its asked-for hours', () => {
    const menuItems: MenuItem[] = [makeMenuItem('item-1', [makeLineItem('DEV', 100)])];
    const result = injectProcessOverhead(menuItems, {
      items: [{ title: 'Code Review', taxonomyKey: 'process.code-review', pct: { DEV: 8 } }],
    });

    const card = result.find((m) => m.taxonomyKey === 'process.code-review')!;
    expect(card.injected).toBe(true);
    expect(card.lineItems).toHaveLength(1);
    expect(card.lineItems[0]!.baseHours).toBe(8);
  });

  /**
   * The failure flat hours had: 24h of ceremony is 6% of a nine-month build and
   * 120% of a two-week one. A percentage has to move with the project or it is
   * the same bug in a different shape.
   */
  it('scales between a small and a large project', () => {
    const spec = {
      items: [{ title: 'Code Review', taxonomyKey: 'process.code-review', pct: { DEV: 10 } }],
    };
    const small = injectProcessOverhead([makeMenuItem('s', [makeLineItem('DEV', 20)])], spec);
    const large = injectProcessOverhead([makeMenuItem('l', [makeLineItem('DEV', 200)])], spec);

    const hoursOf = (r: MenuItem[]) =>
      r.find((m) => m.taxonomyKey === 'process.code-review')!.lineItems[0]!.baseHours;
    expect(hoursOf(small)).toBe(2);
    expect(hoursOf(large)).toBe(20);
  });

  it('ignores injected cards, so overhead never compounds on overhead', () => {
    const menuItems: MenuItem[] = [
      makeMenuItem('asked-for', [makeLineItem('DEV', 100)]),
      MenuItemSchema.parse({
        id: 'hidden-rate-limits',
        taxonomyKey: 'infra.rate-limit',
        title: 'Rate Limit Management',
        enabled: true,
        injected: true,
        lineItems: [{ role: 'DEV', baseHours: 100, taxedHours: 100, edited: false }],
      }),
    ];
    const result = injectProcessOverhead(menuItems, {
      items: [{ title: 'Code Review', taxonomyKey: 'process.code-review', pct: { DEV: 10 } }],
    });
    // 10% of the 100 asked-for hours, not of all 200.
    expect(result.find((m) => m.taxonomyKey === 'process.code-review')!.lineItems[0]!.baseHours).toBe(10);
  });

  it('skips a card whose roles all come to nothing', () => {
    // No QA work on the estimate, so a QA-only overhead card would be 0h.
    const result = injectProcessOverhead([makeMenuItem('item-1', [makeLineItem('DEV', 100)])], {
      items: [{ title: 'Manual E2E', taxonomyKey: 'process.manual-e2e', pct: { QA: 15 } }],
    });
    expect(result.find((m) => m.taxonomyKey === 'process.manual-e2e')).toBeUndefined();
  });

  it('does not tax overhead again — the percentage was taken over taxed hours', () => {
    const result = injectProcessOverhead([makeMenuItem('item-1', [makeLineItem('QA', 50)])], {
      items: [{ title: 'Manual E2E', taxonomyKey: 'process.manual-e2e', pct: { QA: 20 } }],
    });
    const li = result.find((m) => m.taxonomyKey === 'process.manual-e2e')!.lineItems[0]!;
    expect(li.taxedHours).toBe(li.baseHours);
  });

  it('every default item names a real seeded taxonomy node', () => {
    for (const item of DEFAULT_PROCESS_OVERHEAD.items) {
      expect(item.taxonomyKey.startsWith('process.')).toBe(true);
    }
    expect(DEFAULT_PROCESS_OVERHEAD.items).toHaveLength(5);
  });
});

// ─── WS14-03: Config-driven (no hardcoding) ───────────────────────────────────

describe('WS14-03: All percentages from active EstimationConfig (no hardcoding)', () => {
  it('parseTaxationConfig reads from DB-shaped record', () => {
    const dbRecord = {
      pmCommunicationTaxPct: 0.20,
      baCommunicationTaxPct: 0.12,
      qaRegressionBufferPct: 0.25,
      id: 'cfg-1',
      version: 1,
      active: true,
      complexityRules: {},
      infraBaseline: {},
      changeMotivation: 'OTHER' as const,
      createdAt: new Date(),
    };
    const cfg = parseTaxationConfig(dbRecord);
    expect(cfg.pmCommunicationTaxPct).toBe(0.20);
    expect(cfg.qaRegressionBufferPct).toBe(0.25);
  });

  it('changing config changes output without code change', () => {
    const lineItems = [makeLineItem('PM', 10)];

    const cfg1: TaxationConfig = { pmCommunicationTaxPct: 0.10, baCommunicationTaxPct: 0.10, qaRegressionBufferPct: 0.10 };
    const cfg2: TaxationConfig = { pmCommunicationTaxPct: 0.30, baCommunicationTaxPct: 0.10, qaRegressionBufferPct: 0.10 };

    const result1 = applyTaxation(lineItems, cfg1);
    const result2 = applyTaxation(lineItems, cfg2);

    expect(result1[0]!.taxedHours).not.toBe(result2[0]!.taxedHours);
  });
});
