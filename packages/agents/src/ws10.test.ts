import { describe, it, expect, vi } from 'vitest';
import { runDetective, deduplicateRisks, type DetectiveContext } from './detective';
import type { IModelProvider, ISearchProvider, IMcpProvider } from '@repo/providers';
import type { Requirement, RiskFinding } from '@repo/shared';

// ─── Stubs ───────────────────────────────────────────────────────────────────

const mockModel: IModelProvider = { chat: vi.fn(), embed: vi.fn() };
const mockSearch: ISearchProvider = { search: vi.fn() };
const mockMcp: IMcpProvider = {
  listTools: vi.fn(),
  listAllTools: vi.fn(),
  testConnector: vi.fn(),
};

const ctx: DetectiveContext = {
  modelProvider: mockModel,
  modelString: 'openrouter/anthropic/claude-3-haiku',
  instructions: 'You are the Detective agent.',
  searchProvider: mockSearch,
  mcpProvider: mockMcp,
};

function makeRequirement(overrides: Partial<Requirement> = {}): Requirement {
  return {
    id: 'REQ-001',
    text: 'Integrate third-party payment API',
    category: 'B2B',
    reqType: 'Payments',
    platforms: ['Shopify'],
    projectSize: 'Mid-market',
    dataVolume: 'Low',
    integrationCount: 1,
    candidateMenuCardId: 'MC-B2B-PAYMENTS',
    taxonomyKey: 'payments.api',
    sourceRef: 'SOW',
    ambiguities: [],
    blocksEstimation: false,
    ...overrides,
  };
}

const sampleRequirements: Requirement[] = [
  makeRequirement(),
  makeRequirement({ id: 'REQ-002', text: 'Build user authentication', category: 'B2B', reqType: 'Authentication', taxonomyKey: 'auth.sso' }),
];

// ─── WS10-01: Detective wiring with SearchProvider + McpProvider ──────────────

describe('WS10-01: Detective agent wiring with SearchProvider + McpProvider', () => {
  it('calls both searchProvider and mcpProvider during run', async () => {
    vi.mocked(mockSearch.search).mockResolvedValue([
      { title: 'Stripe API limits', url: 'https://stripe.com/docs', snippet: 'Rate limits apply' },
    ]);
    vi.mocked(mockMcp.listAllTools).mockResolvedValue([
      { connectorId: 'jira', name: 'create_issue', description: 'Create a Jira issue', inputSchema: {} },
    ]);
    vi.mocked(mockModel.chat).mockResolvedValue(
      JSON.stringify({
        risks: [
          { requirementId: 'REQ-001', claim: 'API has rate limits', citation: 'stripe.com', riskFlags: ['rate-limits'] },
        ],
        questions: [],
      }),
    );

    const result = await runDetective(sampleRequirements, ctx);

    expect(mockSearch.search).toHaveBeenCalled();
    expect(mockMcp.listAllTools).toHaveBeenCalled();
    expect(result.risks.length).toBeGreaterThan(0);
  });
});

// ─── WS10-02: Risk extraction with flags + questions ─────────────────────────

describe('WS10-02: Risk register — claim + citation + risk flags, plus open questions', () => {
  it('produces risks with explicit risk flags for an API requirement', async () => {
    vi.mocked(mockSearch.search).mockResolvedValue([
      { title: 'Payment API docs', url: 'https://api.example.com', snippet: 'Webhook retries on failure' },
    ]);
    vi.mocked(mockMcp.listAllTools).mockResolvedValue([]);
    vi.mocked(mockModel.chat).mockResolvedValue(
      JSON.stringify({
        risks: [
          {
            requirementId: 'REQ-001',
            claim: 'Payment API requires webhook retry logic for failed events',
            citation: 'https://api.example.com',
            riskFlags: ['retries', 'rate-limits', 'webhook-reliability'],
          },
        ],
        questions: [
          { requirementId: 'REQ-001', question: 'Does the payment provider expose a sandbox for webhook testing?', blocksEstimation: false },
        ],
      }),
    );

    const result = await runDetective([makeRequirement({ text: 'Integrate payment API with webhook' })], ctx);

    expect(result.risks).toHaveLength(1);
    const risk = result.risks[0]!;
    expect(risk.requirementId).toBe('REQ-001');
    expect(risk.taxonomyKey).toBe('payments.api');
    expect(risk.claim).toContain('webhook');
    expect(risk.citation).toBeTruthy();
    expect(risk.riskFlags).toContain('retries');
    expect(result.questions).toHaveLength(1);
    expect(result.questions[0]?.id).toBe('Q-001');
  });

  it('drops a risk/question referencing an unknown requirementId (no fabricated traceability)', async () => {
    vi.mocked(mockSearch.search).mockResolvedValue([]);
    vi.mocked(mockMcp.listAllTools).mockResolvedValue([]);
    vi.mocked(mockModel.chat).mockResolvedValue(
      JSON.stringify({
        risks: [{ requirementId: 'REQ-999', claim: 'ghost risk', citation: 'nowhere' }],
        questions: [],
      }),
    );

    const result = await runDetective(sampleRequirements, ctx);
    expect(result.risks).toHaveLength(0);
  });
});

// ─── WS10-03: Source attribution + dedup ─────────────────────────────────────

describe('WS10-03: Citation attribution + deduplicate risks', () => {
  function makeRisk(overrides: Partial<RiskFinding> = {}): RiskFinding {
    return {
      id: 'RISK-001',
      requirementId: 'REQ-001',
      taxonomyKey: 'payments.api',
      claim: 'API has rate limits',
      riskFlags: ['rate-limits'],
      citation: 'stripe.com',
      spikeRecommended: false,
      ...overrides,
    };
  }

  it('merges duplicate risks by (requirementId, claim), retaining all citations', () => {
    const risks = [
      makeRisk({ citation: 'stripe.com' }),
      makeRisk({ citation: 'braintree.com' }),
      makeRisk({ id: 'RISK-002', requirementId: 'REQ-002', taxonomyKey: 'auth.sso', claim: 'OAuth2 token refresh needed', citation: 'auth0.com', riskFlags: ['auth-complexity'] }),
    ];

    const deduped = deduplicateRisks(risks);

    expect(deduped).toHaveLength(2);
    const paymentRisk = deduped.find((r) => r.requirementId === 'REQ-001');
    expect(paymentRisk).toBeDefined();
    expect(paymentRisk!.citation).toContain('stripe.com');
    expect(paymentRisk!.citation).toContain('braintree.com');
  });

  it('keeps distinct risks with different claims separate', () => {
    const risks = [
      makeRisk({ claim: 'Rate limiting applies' }),
      makeRisk({ id: 'RISK-002', claim: 'Webhook retries needed', riskFlags: ['retries'] }),
    ];

    expect(deduplicateRisks(risks)).toHaveLength(2);
  });

  it('runDetective returns deduplicated risks when the LLM produces duplicates', async () => {
    vi.mocked(mockSearch.search).mockResolvedValue([]);
    vi.mocked(mockMcp.listAllTools).mockResolvedValue([]);
    vi.mocked(mockModel.chat).mockResolvedValue(
      JSON.stringify({
        risks: [
          { requirementId: 'REQ-001', claim: 'rate limit concern', citation: 'source-a.com', riskFlags: ['rate-limits'] },
          { requirementId: 'REQ-001', claim: 'rate limit concern', citation: 'source-b.com', riskFlags: ['rate-limits'] },
        ],
        questions: [],
      }),
    );

    const result = await runDetective(sampleRequirements, ctx);
    const paymentRisks = result.risks.filter((r) => r.requirementId === 'REQ-001');
    const uniqueClaims = new Set(paymentRisks.map((r) => r.claim.toLowerCase().trim()));
    expect(uniqueClaims.size).toBe(paymentRisks.length);
  });
});
