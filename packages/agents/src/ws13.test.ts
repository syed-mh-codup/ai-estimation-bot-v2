import { describe, it, expect, vi } from 'vitest';
import { runSpecialist, runSpecialistCouncil, DEFAULT_SPECIALIST_INSTRUCTIONS, type SpecialistContext } from './specialist';
import type { IModelProvider } from '@repo/providers';
import type { SpecialistInput, ArchivistMatch } from '@repo/shared';

const mockModel: IModelProvider = { chat: vi.fn(), embed: vi.fn() };

const ctx: SpecialistContext = {
  modelProvider: mockModel,
  modelString: 'openrouter/anthropic/claude-3-haiku',
  instructions: DEFAULT_SPECIALIST_INSTRUCTIONS,
};

const sampleMatch: ArchivistMatch = {
  taxonomyKey: 'b2b.checkout',
  presetId: 'preset-123',
  presetVersion: 1,
  score: 0.9,
  beHours: 40,
  feHours: 20,
  risk: 'MEDIUM',
  aiAssist: 'LOW',
};

const sampleInput: SpecialistInput = {
  menuItem: { id: 'item-1', taxonomyKey: 'b2b.checkout', title: 'B2B Checkout Flow' },
  archivistMatch: sampleMatch,
  detectiveFindings: [
    { taxonomyKey: 'b2b.checkout', claim: 'API rate limits apply', source: 'docs.stripe.com', riskFlags: ['rate-limits', 'retries'] },
  ],
  complexityScore: 3,
};

function mockLLMResponse(hours: number, rationale = 'Anchored on preset', assumptions = ['Standard timeline']) {
  vi.mocked(mockModel.chat).mockResolvedValue(
    JSON.stringify({ baseHours: hours, rationale, assumptions }),
  );
}

// ─── WS13-01: Dev specialist ──────────────────────────────────────────────────

describe('WS13-01: Dev specialist — baseHours + rationale + assumptions', () => {
  it('produces baseHours, rationale, and assumptions for a menu item', async () => {
    mockLLMResponse(65);

    const result = await runSpecialist('DEV', sampleInput, ctx);

    expect(result.role).toBe('DEV');
    expect(typeof result.baseHours).toBe('number');
    expect(result.baseHours).toBeGreaterThanOrEqual(0);
    expect(typeof result.rationale).toBe('string');
    expect(result.rationale.length).toBeGreaterThan(0);
    expect(Array.isArray(result.assumptions)).toBe(true);
  });
});

// ─── WS13-02: QA specialist ───────────────────────────────────────────────────

describe('WS13-02: QA specialist — independent of Dev hours', () => {
  it('produces QA line item with its own baseHours', async () => {
    mockLLMResponse(20, 'QA derived from risk', ['Test env setup needed']);

    const result = await runSpecialist('QA', sampleInput, ctx);

    expect(result.role).toBe('QA');
    expect(typeof result.baseHours).toBe('number');
    expect(result.baseHours).toBeGreaterThanOrEqual(0);
  });
});

// ─── WS13-03: PM specialist ───────────────────────────────────────────────────

describe('WS13-03: PM specialist — coordination effort with rationale', () => {
  it('produces PM line item with rationale', async () => {
    mockLLMResponse(10, 'PM: sprint ceremonies + stakeholder sync', ['Weekly sync required']);

    const result = await runSpecialist('PM', sampleInput, ctx);

    expect(result.role).toBe('PM');
    expect(result.rationale.length).toBeGreaterThan(0);
  });
});

// ─── WS13-04: BA specialist ───────────────────────────────────────────────────

describe('WS13-04: BA specialist — analysis effort with rationale', () => {
  it('produces BA line item with rationale', async () => {
    mockLLMResponse(12, 'BA: AC writing + workshop facilitation', ['Acceptance criteria review needed']);

    const result = await runSpecialist('BA', sampleInput, ctx);

    expect(result.role).toBe('BA');
    expect(result.rationale.length).toBeGreaterThan(0);
  });
});

// ─── WS13-05: Specialist Council — 4 roles per menu item ─────────────────────

describe('WS13-05: Assemble 4 independent RoleLineItems per menu item', () => {
  it('runSpecialistCouncil returns exactly DEV/QA/PM/BA line items', async () => {
    vi.mocked(mockModel.chat)
      .mockResolvedValueOnce(JSON.stringify({ baseHours: 65, rationale: 'Dev work', assumptions: [] }))
      .mockResolvedValueOnce(JSON.stringify({ baseHours: 20, rationale: 'QA work', assumptions: [] }))
      .mockResolvedValueOnce(JSON.stringify({ baseHours: 10, rationale: 'PM work', assumptions: [] }))
      .mockResolvedValueOnce(JSON.stringify({ baseHours: 12, rationale: 'BA work', assumptions: [] }));

    const results = await runSpecialistCouncil(sampleInput, ctx);

    expect(results).toHaveLength(4);
    const roles = results.map((r) => r.role);
    expect(roles).toContain('DEV');
    expect(roles).toContain('QA');
    expect(roles).toContain('PM');
    expect(roles).toContain('BA');
  });

  it('each role has independent baseHours (QA != DEV hours)', async () => {
    vi.mocked(mockModel.chat)
      .mockResolvedValueOnce(JSON.stringify({ baseHours: 80, rationale: 'Dev', assumptions: [] }))
      .mockResolvedValueOnce(JSON.stringify({ baseHours: 25, rationale: 'QA', assumptions: [] }))
      .mockResolvedValueOnce(JSON.stringify({ baseHours: 12, rationale: 'PM', assumptions: [] }))
      .mockResolvedValueOnce(JSON.stringify({ baseHours: 15, rationale: 'BA', assumptions: [] }));

    const results = await runSpecialistCouncil(sampleInput, ctx);

    const devHours = results.find((r) => r.role === 'DEV')?.baseHours;
    const qaHours = results.find((r) => r.role === 'QA')?.baseHours;

    expect(devHours).toBe(80);
    expect(qaHours).toBe(25);
    expect(devHours).not.toBe(qaHours);
  });
});
