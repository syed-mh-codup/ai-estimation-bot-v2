import { describe, it, expect } from 'vitest';
import {
  runHiddenWorkAudit,
  runValidationAudit,
  acknowledgeUnreconciled,
  type AcknowledgementRecord,
} from './audit';
import type { MenuItem, RiskFinding, RoleLineItem } from '@repo/shared';

function makeMenuItem(id: string, taxonomyKey: string): MenuItem {
  const lineItems: RoleLineItem[] = [
    { role: 'DEV', baseHours: 20, taxedHours: 20, edited: false },
  ];
  return { id, taxonomyKey, title: id, enabled: true, lineItems };
}

const rateRiskFinding: RiskFinding = {
  id: 'RISK-001',
  requirementId: 'REQ-001',
  taxonomyKey: 'payments.api',
  claim: 'Stripe API has rate limits',
  citation: 'docs.stripe.com',
  riskFlags: ['rate-limits'],
  spikeRecommended: false,
};

const retryRiskFinding: RiskFinding = {
  id: 'RISK-002',
  requirementId: 'REQ-001',
  taxonomyKey: 'payments.api',
  claim: 'Webhook retries needed',
  citation: 'docs.stripe.com',
  riskFlags: ['retries'],
  spikeRecommended: false,
};

// ─── WS15-01: Hidden-Work Audit ───────────────────────────────────────────────

describe('WS15-01: Hidden-Work Audit', () => {
  it('adds a menu item when a risk flag has no matching line item', () => {
    const menuItems: MenuItem[] = [makeMenuItem('item-1', 'payments.api')];
    const findings = [rateRiskFinding];

    const result = runHiddenWorkAudit(menuItems, findings);

    const hiddenItems = result.filter((m) => m.taxonomyKey === 'infra.rate-limit');
    expect(hiddenItems.length).toBe(1);
    expect(hiddenItems[0]!.title).toContain('Rate Limit');
  });

  it('does NOT add a duplicate if the item is already present', () => {
    const menuItems: MenuItem[] = [
      makeMenuItem('item-1', 'payments.api'),
      makeMenuItem('item-rate', 'infra.rate-limit'),
    ];
    const findings = [rateRiskFinding];

    const result = runHiddenWorkAudit(menuItems, findings);
    const rateLimitItems = result.filter((m) => m.taxonomyKey === 'infra.rate-limit');
    expect(rateLimitItems.length).toBe(1);
  });

  it('added item has DEV/QA/PM/BA line items', () => {
    const menuItems: MenuItem[] = [];
    const findings = [retryRiskFinding];

    const result = runHiddenWorkAudit(menuItems, findings);
    const retryItem = result.find((m) => m.taxonomyKey === 'infra.retries');
    expect(retryItem).toBeDefined();
    const roles = retryItem!.lineItems.map((li) => li.role);
    expect(roles).toContain('DEV');
    expect(roles).toContain('QA');
    expect(roles).toContain('PM');
    expect(roles).toContain('BA');
  });

  it('handles multiple risk flags adding multiple hidden items', () => {
    const menuItems: MenuItem[] = [];
    const findings: RiskFinding[] = [
      { id: 'RISK-003', requirementId: 'REQ-001', taxonomyKey: 'api', claim: 'rate limit', citation: 's', riskFlags: ['rate-limits', 'retries'], spikeRecommended: false },
    ];

    const result = runHiddenWorkAudit(menuItems, findings);
    const infraItems = result.filter((m) => m.taxonomyKey.startsWith('infra.'));
    expect(infraItems.length).toBe(2);
  });
});

// ─── WS15-02: Validation Audit gate ──────────────────────────────────────────

describe('WS15-02: Validation Audit gate', () => {
  it('passed=true when all risk flags have menu items', () => {
    const menuItems: MenuItem[] = [
      makeMenuItem('item-1', 'payments.api'),
      makeMenuItem('item-2', 'infra.rate-limit'),
    ];
    const findings = [rateRiskFinding];

    const result = runValidationAudit(menuItems, findings);
    expect(result.passed).toBe(true);
    expect(result.unreconciled).toHaveLength(0);
  });

  it('passed=false with unreconciled non-empty when rate-limit has no line item', () => {
    const menuItems: MenuItem[] = [makeMenuItem('item-1', 'other.feature')];
    const findings = [rateRiskFinding];

    const result = runValidationAudit(menuItems, findings);
    expect(result.passed).toBe(false);
    expect(result.unreconciled.length).toBeGreaterThan(0);
    expect(result.unreconciled[0]!.riskFlag).toBe('rate-limits');
  });

  it('unreconciled item has riskFlag, taxonomyKey, and reason', () => {
    const menuItems: MenuItem[] = [];
    const result = runValidationAudit(menuItems, [rateRiskFinding]);
    const item = result.unreconciled[0]!;
    expect(item.riskFlag).toBeTruthy();
    expect(item.taxonomyKey).toBeTruthy();
    expect(item.reason).toBeTruthy();
  });
});

// ─── WS15-03: Reconciliation / acknowledge path ───────────────────────────────

describe('WS15-03: Reconciliation — acknowledged item unblocks the gate', () => {
  it('acknowledging an unreconciled item removes it and unblocks gate', () => {
    const menuItems: MenuItem[] = [];
    const audit = runValidationAudit(menuItems, [rateRiskFinding]);
    expect(audit.passed).toBe(false);

    const ack: AcknowledgementRecord = {
      riskFlag: 'rate-limits',
      taxonomyKey: 'payments.api',
      acknowledgedBy: 'admin@example.com',
      note: 'Rate limiting handled by API gateway',
      acknowledgedAt: new Date(),
    };

    const { audit: resolved, recorded } = acknowledgeUnreconciled(audit, [ack]);

    expect(resolved.passed).toBe(true);
    expect(resolved.unreconciled).toHaveLength(0);
    expect(recorded).toHaveLength(1);
  });

  it('partial acknowledgement leaves remaining items unreconciled', () => {
    const findings = [rateRiskFinding, retryRiskFinding];
    const menuItems: MenuItem[] = [];
    const audit = runValidationAudit(menuItems, findings);

    const ack: AcknowledgementRecord = {
      riskFlag: 'rate-limits',
      taxonomyKey: 'payments.api',
      acknowledgedBy: 'admin@example.com',
      note: 'Acknowledged',
      acknowledgedAt: new Date(),
    };

    const { audit: partial } = acknowledgeUnreconciled(audit, [ack]);

    // 'retries' is still unreconciled
    expect(partial.passed).toBe(false);
    expect(partial.unreconciled.some((u) => u.riskFlag === 'retries')).toBe(true);
  });
});
