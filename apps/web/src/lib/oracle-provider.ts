import {
  createModelProvider,
  type ChatOptions,
  type ChatStreamEvent,
  type IModelProvider,
} from '@repo/providers';
import { QUOTE_CLOSE, QUOTE_OPEN } from '@repo/agents';

/**
 * Which model provider an Oracle turn talks to.
 *
 * Real OpenRouter everywhere except under ORACLE_STUB_MODEL, which
 * playwright.config sets for the e2e run.
 *
 * A dedicated flag rather than the house "stub when the credentials are blank"
 * idiom (createSheetsProvider) on purpose: OPENROUTER_API_KEY is also what the
 * ingest path uses, so blanking it to make Oracle deterministic would silently
 * change a second subsystem the Oracle specs are not testing. Narrow flag,
 * no blast radius.
 */
export function oracleModelProvider(): IModelProvider {
  return process.env['ORACLE_STUB_MODEL'] === '1' ? stubOracleProvider() : createModelProvider();
}

/**
 * A deterministic Oracle for the e2e run.
 *
 * It quotes the estimate it was actually given rather than a canned string,
 * by lifting the opening of the SOURCE MATERIAL section straight out of the
 * corpus it was handed. That matters: the citation the spec then clicks is a
 * real one, so the e2e exercises genuine quote verification and a genuine jump
 * into the source, instead of a fixture that would pass even if matching were
 * broken.
 */
function stubOracleProvider(): IModelProvider {
  const answerFor = (options: ChatOptions): string => {
    const corpus = options.messages
      .map((m) => (typeof m.content === 'string' ? m.content : ''))
      .join('\n');

    const quote = firstSentenceOfSource(corpus);
    if (!quote) {
      return 'The source material does not cover this. Nothing in the corpus speaks to it.';
    }
    return `The source material addresses this directly: ${QUOTE_OPEN}${quote}${QUOTE_CLOSE} — which is where that requirement comes from.`;
  };

  async function* stream(options: ChatOptions): AsyncIterable<ChatStreamEvent> {
    for (const chunk of answerFor(options).split(/(?<= )/)) {
      yield { type: 'delta', text: chunk };
    }
    yield {
      type: 'done',
      usage: { promptTokens: 1234, completionTokens: 56, costUsd: 0.0001 },
      model: 'stub/oracle',
    };
  }

  return {
    chat: async (options: ChatOptions) => answerFor(options),
    chatStream: stream,
    embed: async () => [],
  };
}

/** The first sentence of the corpus's SOURCE MATERIAL section, if it has one. */
function firstSentenceOfSource(corpus: string): string | null {
  const marker = '# SOURCE MATERIAL\n\n';
  const at = corpus.indexOf(marker);
  if (at === -1) return null;

  const body = corpus.slice(at + marker.length);
  const end = body.search(/\n\n|# [A-Z]/);
  const section = (end === -1 ? body : body.slice(0, end)).trim();
  if (!section) return null;

  // One sentence, and never so long that the highlight covers the whole block.
  const sentence = section.split(/(?<=[.!?])\s/)[0] ?? section;
  return sentence.slice(0, 160).trim() || null;
}
