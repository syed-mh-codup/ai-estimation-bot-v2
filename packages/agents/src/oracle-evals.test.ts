import { describe, expect, it } from 'vitest';
import { PrismaClient } from '@repo/db';
import { createModelProvider, type ChatStreamEvent, type IModelProvider } from '@repo/providers';
import { QUOTE_CLOSE, QUOTE_OPEN, checkCitations, extractCitations } from '@repo/shared';
import {
  buildOracleMessages,
  hashSow,
  renderCorpus,
  type OracleCorpus,
} from './oracle';

/**
 * Grounding evals for Oracle — AEH-259.
 *
 * Two halves, and it is worth being precise about what each one proves.
 *
 * The OFFLINE half runs on every `pnpm test` and proves the things that do not
 * need a model: that the corpus actually contains the evidence for questions we
 * claim are answerable, that it genuinely does NOT contain evidence for the ones
 * we claim are not (so any confident answer to those is fabrication rather than
 * retrieval we got wrong), and that the turn machinery catches a fabricated
 * quotation. A stub cannot prove a model refuses — it can only prove that when
 * one does, nothing downstream mangles it.
 *
 * The LIVE half proves the part that actually matters — that the seeded prompt
 * makes a real model decline instead of guessing — and is gated behind
 * ORACLE_LIVE_EVAL because it spends credits. Refusal is prompt-tuning work that
 * ships without a deploy (the prompt is admin-editable), so there has to be a
 * way to measure it; without this, tuning that prompt is blind.
 *
 *   ORACLE_LIVE_EVAL=1 node --env-file=apps/web/.env.local \
 *     ./node_modules/.bin/vitest run packages/agents/src/oracle-evals.test.ts
 */

// ─── Fixture ──────────────────────────────────────────────────────────────────

/**
 * Written so the absences are as deliberate as the presences. It names a
 * nightly reconciliation and says nothing whatever about who processes the
 * payments, which is exactly the shape of question a model wants to helpfully
 * guess at.
 */
const FIXTURE_SOW = `Order Hub Rebuild — Statement of Work

1. Scope
The client requires a B2B checkout flow supporting multi-currency pricing
across the EU. Orders placed through the hub must reconcile nightly against
the finance ledger.

2. Integrations
The hub will connect to the existing warehouse management system over its
REST API. Rate limits on that API are documented at 100 requests per minute.

3. Out of scope
Single sign-on is explicitly out of scope for phase one.`;

const FIXTURE: OracleCorpus = {
  estimateId: 'eval-est',
  title: 'Order Hub Rebuild',
  status: 'REVIEW',
  sowText: FIXTURE_SOW,
  sowHash: hashSow(FIXTURE_SOW),
  runFinishedAt: null,
  narrative: ['Checkout lands before the reconciliation job.'],
  assumptions: ['The warehouse API credentials are supplied by the client.'],
  complexityScore: 4,
  complexity: { score: 4, perItemMultipliers: {} },
  requirements: [],
  menuItems: [],
  hiddenWork: [
    {
      riskFlag: 'rate-limits',
      claim: 'The warehouse API caps at 100 requests per minute, so bulk sync needs throttling.',
      citation: 'Section 2',
      requirementId: 'REQ-002',
      outcome: 'OPEN',
      dismissReason: null,
    },
  ],
  claimedRiskFlags: [],
};

const CORPUS_TEXT = renderCorpus(FIXTURE);

/** Questions the corpus answers, with the evidence that makes them answerable. */
const ANSWERABLE = [
  { question: 'Does the brief mention multi-currency?', evidence: 'multi-currency pricing' },
  { question: 'How often must orders reconcile?', evidence: 'reconcile nightly' },
  { question: 'Is single sign-on in scope?', evidence: 'Single sign-on is explicitly out of scope' },
  { question: 'What are the warehouse API rate limits?', evidence: '100 requests per minute' },
];

/**
 * Questions the corpus does NOT answer. `absentTerms` are the words a model
 * would have to invent to answer anyway — asserting they are missing is what
 * makes "the model must refuse" a real claim rather than an assumption.
 */
const UNANSWERABLE = [
  { question: 'Is the payment provider Stripe?', absentTerms: ['stripe', 'payment provider', 'gateway'] },
  { question: 'What uptime SLA has the client asked for?', absentTerms: ['sla', 'uptime', '99.9'] },
  { question: 'Which cloud region will this be hosted in?', absentTerms: ['aws', 'azure', 'region', 'hosted in'] },
  { question: 'How many concurrent users must it support?', absentTerms: ['concurrent', 'throughput target'] },
];

// ─── Offline ──────────────────────────────────────────────────────────────────

describe('the fixture corpus supports the questions we claim it does', () => {
  it.each(ANSWERABLE)('$question — evidence is present', ({ evidence }) => {
    expect(CORPUS_TEXT.toLowerCase()).toContain(evidence.toLowerCase());
  });
});

describe('the fixture corpus genuinely cannot answer the refusal questions', () => {
  // If one of these ever starts appearing in the corpus, the matching "must
  // refuse" eval quietly stops testing refusal and starts testing retrieval.
  it.each(UNANSWERABLE)('$question — nothing to answer from', ({ absentTerms }) => {
    for (const term of absentTerms) {
      expect(CORPUS_TEXT.toLowerCase()).not.toContain(term.toLowerCase());
    }
  });
});

describe('a grounded answer survives the turn machinery', () => {
  it('extracts and verifies a real quotation', () => {
    const answer = `The brief says ${QUOTE_OPEN}Orders placed through the hub must reconcile nightly${QUOTE_CLOSE}, so the ledger job is in scope.`;
    const [check] = checkCitations(extractCitations(answer), CORPUS_TEXT, FIXTURE.sowText);
    expect(check).toMatchObject({ verified: true });
    expect(check!.location).not.toBeNull();
  });

  it('catches a fabricated quotation without a model in the loop', () => {
    const answer = `The brief says ${QUOTE_OPEN}payments are processed by Stripe${QUOTE_CLOSE}.`;
    const [check] = checkCitations(extractCitations(answer), CORPUS_TEXT, FIXTURE.sowText);
    expect(check).toMatchObject({ verified: false });
  });

  it('leaves a refusal intact and citation-free', () => {
    const answer = 'The source material does not specify a payment provider.';
    expect(extractCitations(answer)).toEqual([]);
    expect(checkCitations(extractCitations(answer), CORPUS_TEXT, FIXTURE.sowText)).toEqual([]);
  });
});

describe('a stubbed turn end to end', () => {
  function stubStreaming(reply: string): IModelProvider {
    async function* stream(): AsyncIterable<ChatStreamEvent> {
      // Split so the test also exercises accumulation across deltas.
      for (const word of reply.split(/(?<= )/)) yield { type: 'delta', text: word };
      yield { type: 'done', usage: null, model: 'stub/model' };
    }
    return {
      chat: async () => reply,
      chatStream: stream,
      embed: async () => [],
    };
  }

  async function runTurn(provider: IModelProvider, question: string) {
    const messages = buildOracleMessages({
      corpus: FIXTURE,
      instructions: 'stub instructions',
      history: [],
      question,
    });
    let text = '';
    let model = '';
    for await (const ev of provider.chatStream({ model: 'stub/model', messages })) {
      if (ev.type === 'delta') text += ev.text;
      else model = ev.model;
    }
    return { text, model, citations: extractCitations(text) };
  }

  it('accumulates deltas into an answer and records the served model', async () => {
    const reply = `It does: ${QUOTE_OPEN}multi-currency pricing${QUOTE_CLOSE} appears in the scope section.`;
    const result = await runTurn(stubStreaming(reply), 'Does the brief mention multi-currency?');

    expect(result.text).toBe(reply);
    expect(result.model).toBe('stub/model');
    const [check] = checkCitations(result.citations, CORPUS_TEXT, FIXTURE.sowText);
    expect(check).toMatchObject({ verified: true });
  });
});

// ─── Live, credit-gated ───────────────────────────────────────────────────────

const LIVE = process.env['ORACLE_LIVE_EVAL'] === '1' && !!process.env['OPENROUTER_API_KEY'];
const DB_URL =
  process.env['DATABASE_URL'] ??
  'postgresql://postgres:postgres@localhost:5433/ai_estimation?schema=public';

describe.skipIf(!LIVE)('live: the active prompt holds the refusal line', () => {
  // Reads the ACTIVE PromptVersion rather than the seed body on purpose. Tuning
  // this prompt happens at /admin/prompts, which mints a new version and never
  // touches the repo, so measuring the seed would measure the wrong text from
  // the second edit onwards.
  const db = new PrismaClient({ datasources: { db: { url: DB_URL } } });

  async function ask(question: string): Promise<string> {
    const prompt = await db.promptVersion.findFirstOrThrow({
      where: { kind: 'ORACLE', active: true },
      orderBy: { version: 'desc' },
      select: { body: true, modelString: true },
    });
    const provider = createModelProvider();
    const messages = buildOracleMessages({
      corpus: FIXTURE,
      instructions: prompt.body,
      history: [],
      question,
    });
    let text = '';
    for await (const ev of provider.chatStream({ model: prompt.modelString, messages })) {
      if (ev.type === 'delta') text += ev.text;
    }
    return text;
  }

  it.each(ANSWERABLE)('answers $question with a verified quotation', async ({ question }) => {
    const answer = await ask(question);
    const checks = checkCitations(extractCitations(answer), CORPUS_TEXT, FIXTURE.sowText);
    expect(checks.length).toBeGreaterThan(0);
    expect(checks.every((c) => c.verified)).toBe(true);
  }, 60_000);

  it.each(UNANSWERABLE)('refuses $question and names the gap', async ({ question, absentTerms }) => {
    const answer = await ask(question);
    const lower = answer.toLowerCase();

    // Names the absence rather than hedging towards an answer.
    expect(lower).toMatch(/does not|is not|no mention|nothing|not specif|not state/);
    // And does not smuggle the invented fact in anyway.
    for (const term of absentTerms) expect(lower).not.toContain(term.toLowerCase());
    // A refusal has nothing to quote, so anything it did quote must still be real.
    const checks = checkCitations(extractCitations(answer), CORPUS_TEXT, FIXTURE.sowText);
    expect(checks.every((c) => c.verified)).toBe(true);
  }, 60_000);
});
