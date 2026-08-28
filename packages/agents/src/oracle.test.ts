import { describe, expect, it } from 'vitest';
import {
  ASSUMPTION_CLOSE,
  ASSUMPTION_OPEN,
  QUOTE_CLOSE,
  QUOTE_OPEN,
  checkCitations,
  createQuoteMatcher,
  extractCitations,
  normalizeForMatch,
  splitAnswer,
} from '@repo/shared';
import {
  buildOracleMessages,
  deriveThreadTitle,
  hashSow,
  renderCorpus,
  type OracleCorpus,
} from './oracle';

/**
 * Citation integrity — AEH-259's first acceptance criterion.
 *
 * "Every quote Oracle emits is a verbatim substring of the corpus it was given.
 * A fabricated quote fails the check without a model in the loop." Everything
 * below runs offline, which is the point: this is the safeguard that does not
 * depend on the thing it is guarding against.
 */

const SOW = `Order Hub Rebuild

The client needs a B2B checkout flow supporting multi-currency
pricing across the EU. Payments must reconcile nightly.

Single sign-on is explicitly out of scope for phase one.`;

const corpus = (over: Partial<OracleCorpus> = {}): OracleCorpus => ({
  estimateId: 'est-1',
  title: 'Order Hub Rebuild',
  status: 'REVIEW',
  sowText: SOW,
  sowHash: hashSow(SOW),
  runFinishedAt: null,
  narrative: ['Deliver checkout before reconciliation.'],
  assumptions: ['The client provides a sandbox payment account.'],
  complexityScore: 4,
  complexity: { score: 4, perItemMultipliers: { 'MC-CHECKOUT': 1.2 } },
  requirements: [],
  menuItems: [],
  hiddenWork: [],
  claimedRiskFlags: [],
  ...over,
});

describe('parsing an answer into prose and quotations', () => {
  it('separates quoted spans from the explanation', () => {
    const answer = `The brief says ${QUOTE_OPEN}multi-currency pricing across the EU${QUOTE_CLOSE}, so the cart needs a currency dimension.`;
    expect(splitAnswer(answer)).toEqual([
      { type: 'text', value: 'The brief says ' },
      { type: 'quote', value: 'multi-currency pricing across the EU' },
      { type: 'text', value: ', so the cart needs a currency dimension.' },
    ]);
  });

  it('renders an unterminated opener as prose', () => {
    // Every streamed turn passes through this state, so it must not throw and
    // must not swallow the tail the user is currently watching arrive.
    expect(splitAnswer(`The brief says ${QUOTE_OPEN}multi-cur`)).toEqual([
      { type: 'text', value: `The brief says ${QUOTE_OPEN}multi-cur` },
    ]);
  });

  it('collects citations without duplicates', () => {
    const answer = `${QUOTE_OPEN}reconcile nightly${QUOTE_CLOSE} and again ${QUOTE_OPEN}reconcile nightly${QUOTE_CLOSE}`;
    expect(extractCitations(answer)).toEqual(['reconcile nightly']);
  });

  it('finds no citations in an answer that only refuses', () => {
    expect(extractCitations('The source material does not specify a payment provider.')).toEqual([]);
  });
});

describe('suggested assumptions are parsed apart from quotations', () => {
  // The two markers are opposites: a quotation must already exist in the
  // corpus, a suggested assumption by definition does not. Reading one as the
  // other would be wrong in both directions — a fabricated-quote warning on
  // proposed wording, or an unchecked invention rendered as a source quote.
  const answer = `That is not in the documents. Record it: ${ASSUMPTION_OPEN}Auth already exists and is not costed.${ASSUMPTION_CLOSE} The brief only says ${QUOTE_OPEN}Payments must reconcile nightly${QUOTE_CLOSE}.`;

  it('separates both marker kinds from the prose, in order', () => {
    expect(splitAnswer(answer).map((s) => s.type)).toEqual([
      'text',
      'assumption',
      'text',
      'quote',
      'text',
    ]);
  });

  it('exposes only the proposed wording, not the paragraph around it', () => {
    // The whole point of the change: copying used to hand over the entire
    // answer and leave the estimator to trim the explanation off before
    // pasting it into a client-facing document. This is what the UI copies.
    const wording = splitAnswer(answer)
      .filter((s) => s.type === 'assumption')
      .map((s) => s.value.trim());
    expect(wording).toEqual(['Auth already exists and is not costed.']);
  });

  it('keeps an assumption out of the citations', () => {
    expect(extractCitations(answer)).toEqual(['Payments must reconcile nightly']);
  });

  it('does not check a suggested assumption against the corpus', () => {
    // It is new information by definition; verifying it would flag every one
    // as fabricated.
    const checks = checkCitations(extractCitations(answer), renderCorpus(corpus()), SOW);
    expect(checks.map((c) => c.quote)).toEqual(['Payments must reconcile nightly']);
    expect(checks.every((c) => c.verified)).toBe(true);
  });

  it('renders an unterminated assumption opener as prose', () => {
    expect(splitAnswer(`Record it: ${ASSUMPTION_OPEN}Auth alr`)).toEqual([
      { type: 'text', value: `Record it: ${ASSUMPTION_OPEN}Auth alr` },
    ]);
  });

  it('finds no assumption in an answer that suggests none', () => {
    const segs = splitAnswer(`Only ${QUOTE_OPEN}a quote${QUOTE_CLOSE} here.`);
    expect(segs.filter((s) => s.type === 'assumption')).toEqual([]);
  });
});

describe('locating a quotation in the source', () => {
  const findQuoteInSource = (quote: string, source: string) => createQuoteMatcher(source)(quote);

  it('finds an exact span and reports real offsets', () => {
    const at = findQuoteInSource('Payments must reconcile nightly', SOW);
    expect(at).not.toBeNull();
    expect(SOW.slice(at!.start, at!.end)).toBe('Payments must reconcile nightly');
  });

  it('finds a quotation the model reflowed across a line break', () => {
    // The single most common false negative: the SOW wraps mid-phrase and the
    // model quotes it as one line. A naive includes() rejects a real quote here.
    const at = findQuoteInSource('B2B checkout flow supporting multi-currency pricing', SOW);
    expect(at).not.toBeNull();
    expect(normalizeForMatch(SOW.slice(at!.start, at!.end))).toBe(
      'b2b checkout flow supporting multi-currency pricing',
    );
  });

  it('finds a quotation retyped with curly punctuation', () => {
    const source = "The client's sandbox is ready.";
    const at = findQuoteInSource('The client’s sandbox is ready.', source);
    expect(at).not.toBeNull();
    expect(source.slice(at!.start, at!.end)).toBe("The client's sandbox is ready.");
  });

  it('rejects a fabricated quotation', () => {
    expect(findQuoteInSource('Stripe is the payment provider', SOW)).toBeNull();
  });

  it('rejects a quotation that reorders real words', () => {
    // Folding whitespace and punctuation glyphs must not extend to folding
    // meaning. This is the line the normalisation must not cross.
    expect(findQuoteInSource('nightly reconcile must Payments', SOW)).toBeNull();
  });

  it('rejects a near-miss that changes a number', () => {
    expect(findQuoteInSource('out of scope for phase two', SOW)).toBeNull();
  });

  it('ignores an empty or whitespace-only quotation', () => {
    expect(findQuoteInSource('   ', SOW)).toBeNull();
  });

  it('reuses one matcher across many quotations', () => {
    const match = createQuoteMatcher(SOW);
    expect(match('reconcile nightly')).not.toBeNull();
    expect(match('Single sign-on is explicitly out of scope')).not.toBeNull();
    expect(match('invented text')).toBeNull();
  });
});

describe('checkCitations separates verified, jumpable and fabricated', () => {
  const c = corpus();
  const corpusText = renderCorpus(c);

  it('marks a quotation from the source as verified and jumpable', () => {
    const [check] = checkCitations(['Payments must reconcile nightly'], corpusText, c.sowText);
    expect(check).toMatchObject({ verified: true });
    expect(check!.location).not.toBeNull();
  });

  it('marks a quotation from the narrative as verified but not jumpable', () => {
    // A legitimate quote that is not in the SOW. It must verify, but the UI has
    // nowhere in the #sow block to jump to, and must not pretend otherwise.
    const [check] = checkCitations(
      ['Deliver checkout before reconciliation.'],
      corpusText,
      c.sowText,
    );
    expect(check).toMatchObject({ verified: true, location: null });
  });

  it('marks a fabricated quotation as unverified', () => {
    const [check] = checkCitations(['The provider is Stripe'], corpusText, c.sowText);
    expect(check).toMatchObject({ verified: false, location: null });
  });
});

describe('the corpus given to the model', () => {
  it('includes the source material verbatim, so quotes can match it', () => {
    expect(renderCorpus(corpus())).toContain(SOW);
  });

  it('omits sections an estimate does not have yet', () => {
    // A DRAFT before any run is source material and nothing else. Empty headings
    // would invite the model to answer about a menu card that does not exist.
    const text = renderCorpus(
      corpus({ narrative: [], assumptions: [], complexityScore: null, complexity: null }),
    );
    expect(text).toContain('# SOURCE MATERIAL');
    expect(text).not.toContain('# NARRATIVE');
    expect(text).not.toContain('# MENU CARD');
    expect(text).not.toContain('# COMPLEXITY');
  });

  it('carries both halves of the risk-coverage question', () => {
    const text = renderCorpus(
      corpus({
        claimedRiskFlags: ['rate-limits'],
        hiddenWork: [
          {
            riskFlag: 'data-migration',
            claim: 'Legacy orders must be backfilled.',
            citation: 'section 4',
            requirementId: 'REQ-002',
            outcome: 'DISMISSED',
            dismissReason: 'Client will migrate their own data.',
          },
        ],
      }),
    );
    // Answerable: what did we spot and choose not to cost...
    expect(text).toContain('data-migration');
    expect(text).toContain('Client will migrate their own data.');
    // ...and what did the estimators say they had already covered.
    expect(text).toContain('rate-limits');
  });

  it('renders hours and dependencies for a card', () => {
    const text = renderCorpus(
      corpus({
        menuItems: [
          {
            title: 'Checkout flow',
            taxonomyKey: 'commerce.checkout',
            enabled: true,
            injected: false,
            sectionTitle: 'Core',
            requirementIds: ['REQ-001'],
            lineItems: [
              {
                role: 'DEV',
                title: 'Cart currency dimension',
                baseHours: 4,
                taxedHours: 4.8,
                notes: null,
                requirementId: 'REQ-001',
                dependsOn: ['DEV-REQ001-01'],
                anchorPresetIds: ['P12'],
              },
            ],
          },
        ],
      }),
    );
    expect(text).toContain('Checkout flow');
    expect(text).toContain('DEV 4h base / 4.8h taxed');
    expect(text).toContain('depends on DEV-REQ001-01');
    expect(text).toContain('anchored on P12');
  });

  it('says when a card is excluded from the total', () => {
    const text = renderCorpus(
      corpus({
        menuItems: [
          {
            title: 'Nice to have',
            taxonomyKey: 'x.y',
            enabled: false,
            injected: false,
            sectionTitle: null,
            requirementIds: [],
            lineItems: [],
          },
        ],
      }),
    );
    expect(text).toContain('toggled OFF, excluded from the total');
  });
});

describe('message assembly', () => {
  const messages = buildOracleMessages({
    corpus: corpus(),
    instructions: 'ADMIN PROMPT BODY',
    history: [
      { role: 'USER', content: 'Does it mention SSO?' },
      { role: 'ASSISTANT', content: 'Yes, as out of scope.' },
    ],
    question: 'What about multi-currency?',
  });

  it('keeps the admin prompt as the system message', () => {
    expect(messages[0]!.role).toBe('system');
    expect(messages[0]!.content).toContain('ADMIN PROMPT BODY');
  });

  it('appends both wire formats in code, not in the prompt', () => {
    // The formats must survive an admin rewriting the prompt body — otherwise a
    // reworded prompt silently stops citations being extractable and the
    // copy-an-assumption block from ever appearing, while answers still read
    // perfectly well.
    expect(messages[0]!.content).toContain(QUOTE_OPEN);
    expect(messages[0]!.content).toContain(ASSUMPTION_OPEN);
    expect(messages[0]!.content).toContain('OUTPUT FORMAT');
  });

  it('replays prior turns and ends on the new question', () => {
    expect(messages.map((m) => m.role)).toEqual([
      'system',
      'user',
      'assistant',
      'user',
      'assistant',
      'user',
    ]);
    expect(messages.at(-1)).toEqual({ role: 'user', content: 'What about multi-currency?' });
  });
});

describe('thread titles', () => {
  it('uses the question when it is short', () => {
    expect(deriveThreadTitle('Where did multi-currency come from?')).toBe(
      'Where did multi-currency come from?',
    );
  });

  it('truncates a long question on a whole character', () => {
    const title = deriveThreadTitle('x'.repeat(200));
    expect(title.length).toBeLessThanOrEqual(60);
    expect(title.endsWith('…')).toBe(true);
  });

  it('collapses newlines rather than breaking the list layout', () => {
    expect(deriveThreadTitle('  Does the\n\nBRD mention SSO?  ')).toBe('Does the BRD mention SSO?');
  });

  it('never returns an empty title', () => {
    expect(deriveThreadTitle('   ')).toBe('Untitled question');
  });
});

describe('sow hashing', () => {
  it('is stable for identical text and differs when the source moves', () => {
    expect(hashSow(SOW)).toBe(hashSow(SOW));
    expect(hashSow(SOW)).not.toBe(hashSow(`${SOW} Plus a new paragraph.`));
  });
});
