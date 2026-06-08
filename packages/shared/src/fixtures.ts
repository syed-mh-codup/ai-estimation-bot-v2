/**
 * Sample SOW fixtures (WS26-01) — three representative statements of work used
 * to exercise the estimation pipeline: one simple, one integration-heavy, one
 * legacy-heavy. Each carries an expected deterministic complexity band (the
 * complexity engine is pure/LLM-free), asserted in agents/fixtures.test.ts.
 *
 * Also seeded as DRAFT estimates (packages/db seed) so they're ready to Run
 * from the dashboard the moment OpenRouter credits are available.
 */
export type SampleSow = {
  id: string;
  title: string;
  sowText: string;
  /** Expected deterministic complexity score band (1–5, inclusive). */
  expectedComplexity: { min: number; max: number };
};

export const SAMPLE_SOWS: SampleSow[] = [
  {
    id: 'sow-simple',
    title: 'Marketing Landing Page',
    sowText:
      'Build a single marketing landing page with a hero section, a features list, ' +
      'testimonials, and a contact form that emails submissions to the team. ' +
      'No user accounts and no integrations — just a static, responsive page with a small form.',
    expectedComplexity: { min: 1, max: 2 },
  },
  {
    id: 'sow-integration',
    title: 'Multi-System Order Hub',
    sowText:
      'Build an order hub that integrates with five external services. Connect to the ' +
      'Stripe payment gateway via its API, sync inventory through a third-party SDK, ' +
      'push fulfilment events to a shipping webhook, pull pricing from an external service API, ' +
      'and expose a public REST API for partners. Each integration needs retry and rate-limit handling.',
    expectedComplexity: { min: 4, max: 5 },
  },
  {
    id: 'sow-legacy',
    title: 'Mainframe Modernisation',
    sowText:
      'Migrate a legacy COBOL mainframe monolith to a modern web stack. This is a ' +
      'data migration of millions of records from the end-of-life system, including a ' +
      'rewrite of core business rules currently locked in the mainframe.',
    expectedComplexity: { min: 3, max: 5 },
  },
];
