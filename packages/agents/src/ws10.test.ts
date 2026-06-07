import { describe, it, expect, vi } from 'vitest';
import { runDetective, deduplicateFindings, type DetectiveContext } from './detective';
import type { IModelProvider, ISearchProvider, IMcpProvider } from '@repo/providers';
import type { Requirement } from '@repo/shared';

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

const sampleRequirements: Requirement[] = [
  { text: 'Integrate third-party payment API', taxonomyKey: 'payments.api', confidence: 0.9 },
  { text: 'Build user authentication', taxonomyKey: 'auth.sso', confidence: 0.85 },
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
        findings: [
          { taxonomyKey: 'payments.api', claim: 'API has rate limits', source: 'stripe.com', riskFlags: ['rate-limits'] },
        ],
      }),
    );

    const result = await runDetective(sampleRequirements, ctx);

    expect(mockSearch.search).toHaveBeenCalled();
    expect(mockMcp.listAllTools).toHaveBeenCalled();
    expect(result.findings.length).toBeGreaterThan(0);
  });
});

// ─── WS10-02: Findings extraction with risk flags ────────────────────────────

describe('WS10-02: Findings extraction — claim + source + risk flags', () => {
  it('produces findings with explicit risk flags for API requirement', async () => {
    vi.mocked(mockSearch.search).mockResolvedValue([
      { title: 'Payment API docs', url: 'https://api.example.com', snippet: 'Webhook retries on failure' },
    ]);
    vi.mocked(mockMcp.listAllTools).mockResolvedValue([]);
    vi.mocked(mockModel.chat).mockResolvedValue(
      JSON.stringify({
        findings: [
          {
            taxonomyKey: 'payments.api',
            claim: 'Payment API requires webhook retry logic for failed events',
            source: 'https://api.example.com',
            riskFlags: ['retries', 'rate-limits', 'webhook-reliability'],
          },
        ],
      }),
    );

    const result = await runDetective(
      [{ text: 'Integrate payment API with webhook', taxonomyKey: 'payments.api', confidence: 0.9 }],
      ctx,
    );

    expect(result.findings).toHaveLength(1);
    const finding = result.findings[0]!;
    expect(finding.taxonomyKey).toBe('payments.api');
    expect(finding.claim).toContain('webhook');
    expect(finding.source).toBeTruthy();
    expect(finding.riskFlags).toContain('retries');
    expect(finding.riskFlags.length).toBeGreaterThan(0);
  });
});

// ─── WS10-03: Source attribution + dedup ─────────────────────────────────────

describe('WS10-03: Source attribution + deduplicate findings', () => {
  it('merges duplicate findings by claim, retaining all sources', () => {
    const findings = [
      { taxonomyKey: 'payments.api', claim: 'API has rate limits', source: 'stripe.com', riskFlags: ['rate-limits'] },
      { taxonomyKey: 'payments.api', claim: 'API has rate limits', source: 'braintree.com', riskFlags: ['rate-limits'] },
      { taxonomyKey: 'auth.sso', claim: 'OAuth2 token refresh needed', source: 'auth0.com', riskFlags: ['auth-complexity'] },
    ];

    const deduped = deduplicateFindings(findings);

    expect(deduped).toHaveLength(2);
    const paymentFinding = deduped.find((f) => f.taxonomyKey === 'payments.api');
    expect(paymentFinding).toBeDefined();
    // Both sources should be retained
    expect(paymentFinding!.source).toContain('stripe.com');
    expect(paymentFinding!.source).toContain('braintree.com');
  });

  it('keeps distinct findings with different claims separate', () => {
    const findings = [
      { taxonomyKey: 'payments.api', claim: 'Rate limiting applies', source: 'docs.stripe.com', riskFlags: ['rate-limits'] },
      { taxonomyKey: 'payments.api', claim: 'Webhook retries needed', source: 'docs.stripe.com', riskFlags: ['retries'] },
    ];

    const deduped = deduplicateFindings(findings);
    expect(deduped).toHaveLength(2);
  });

  it('runDetective returns deduplicated findings when LLM produces duplicates', async () => {
    vi.mocked(mockSearch.search).mockResolvedValue([]);
    vi.mocked(mockMcp.listAllTools).mockResolvedValue([]);
    vi.mocked(mockModel.chat).mockResolvedValue(
      JSON.stringify({
        findings: [
          { taxonomyKey: 'payments.api', claim: 'rate limit concern', source: 'source-a.com', riskFlags: ['rate-limits'] },
          { taxonomyKey: 'payments.api', claim: 'rate limit concern', source: 'source-b.com', riskFlags: ['rate-limits'] },
        ],
      }),
    );

    const result = await runDetective(sampleRequirements, ctx);
    // Duplicates should be merged
    const paymentFindings = result.findings.filter((f) => f.taxonomyKey === 'payments.api');
    const uniqueClaims = new Set(paymentFindings.map((f) => f.claim.toLowerCase().trim()));
    expect(uniqueClaims.size).toBe(paymentFindings.length);
  });
});
