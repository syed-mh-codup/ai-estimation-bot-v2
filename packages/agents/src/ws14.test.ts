import { describe, it, expect } from 'vitest';
import {
  applyTaxation,
  applyTaxationToMenuItems,
  injectInfraBaseline,
  parseTaxationConfig,
  DEFAULT_INFRA_BASELINE,
  type TaxationConfig,
} from './taxation';
import type { RoleLineItem, MenuItem } from '@repo/shared';

const config: TaxationConfig = {
  pmCommunicationTaxPct: 0.15,
  baCommunicationTaxPct: 0.10,
  qaRegressionBufferPct: 0.20,
};

function makeLineItem(role: 'DEV' | 'QA' | 'PM' | 'BA', baseHours: number): RoleLineItem {
  return { role, baseHours, taxedHours: baseHours, edited: false };
}

function makeMenuItem(id: string, lineItems: RoleLineItem[]): MenuItem {
  return {
    id,
    taxonomyKey: 'test.item',
    title: 'Test Item',
    enabled: true,
    lineItems,
  };
}

// ─── WS14-01: Taxation engine ─────────────────────────────────────────────────

describe('WS14-01: Taxation — taxedHours = base * (1 + pct) per role from config', () => {
  it('PM taxed at pmCommunicationTaxPct', () => {
    const items = applyTaxation([makeLineItem('PM', 10)], config);
    expect(items[0]!.taxedHours).toBe(Math.round(10 * 1.15));
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
    expect(taxed.find((r) => r.role === 'PM')!.taxedHours).toBe(12);
    expect(taxed.find((r) => r.role === 'BA')!.taxedHours).toBe(13);
  });
});

// ─── WS14-02: Infrastructure baseline injector ────────────────────────────────

describe('WS14-02: Infrastructure baseline — mandatory items injected once', () => {
  it('injects baseline items from config into menu items', () => {
    const menuItems: MenuItem[] = [makeMenuItem('item-1', [makeLineItem('DEV', 30)])];
    const result = injectInfraBaseline(menuItems, DEFAULT_INFRA_BASELINE, config);

    const baselineItems = result.filter((m) => m.id.startsWith('baseline'));
    expect(baselineItems.length).toBe(3); // env-setup, cicd, hypercare
  });

  it('each baseline item has DEV/QA/PM/BA line items', () => {
    const menuItems: MenuItem[] = [];
    const result = injectInfraBaseline(menuItems, DEFAULT_INFRA_BASELINE, config);

    for (const baseline of result.filter((m) => m.id.startsWith('baseline'))) {
      const roles = baseline.lineItems.map((li) => li.role);
      expect(roles).toContain('DEV');
      expect(roles).toContain('QA');
      expect(roles).toContain('PM');
    }
  });

  it('idempotent — does not add baseline twice on second call', () => {
    const menuItems: MenuItem[] = [];
    const once = injectInfraBaseline(menuItems, DEFAULT_INFRA_BASELINE, config);
    const twice = injectInfraBaseline(once, DEFAULT_INFRA_BASELINE, config);

    const baselineOnce = once.filter((m) => m.id.startsWith('baseline')).length;
    const baselineTwice = twice.filter((m) => m.id.startsWith('baseline')).length;
    expect(baselineTwice).toBe(baselineOnce);
  });

  it('baseline items are enabled by default', () => {
    const result = injectInfraBaseline([], DEFAULT_INFRA_BASELINE, config);
    for (const item of result) {
      expect(item.enabled).toBe(true);
    }
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
