import { createModelProvider, type ChatOptions, type IModelProvider } from '@repo/providers';

/**
 * Which model provider the Cartographer talks to.
 *
 * Real OpenRouter everywhere except under OPENROUTER_STUB, which
 * playwright.config sets for the e2e run. Same narrow-flag reasoning as
 * `oracle-provider.ts`: OPENROUTER_API_KEY also feeds ingest, so blanking it to
 * make this deterministic would silently change a subsystem the specs are not
 * testing.
 */
export function cartographerModelProvider(): IModelProvider {
  return process.env['OPENROUTER_STUB'] === '1'
    ? stubCartographerProvider()
    : createModelProvider();
}

/**
 * A deterministic Cartographer for the e2e run.
 *
 * It DERIVES a graph from the corpus it was actually handed — reading the card
 * numbers out of the rendered list and chaining them — rather than returning a
 * canned payload. That distinction is the whole value of the stub: a fixed
 * `{"edges":[{"dependent":2,"prerequisite":1}]}` would pass on an estimate
 * whose cards do not exist, and would keep passing if the number-to-id mapping
 * broke entirely. Deriving means the numbers are real, so the mapping, the
 * guards and the cascade are all genuinely exercised.
 *
 * The chain it produces (2→1, 3→2, …) is deliberately the shape that makes a
 * cascade observable: switching card 1 off has to take everything with it.
 */
function stubCartographerProvider(): IModelProvider {
  const graphFor = (options: ChatOptions): string => {
    const rendered = options.messages
      .map((m) => (typeof m.content === 'string' ? m.content : ''))
      .join('\n');

    // The corpus renders one card per line as "N. Title [...]". Anything else
    // in the prompt is prose, so a leading number at line start is the signal.
    const numbers = [...rendered.matchAll(/^(\d+)\.\s/gm)]
      .map((m) => Number(m[1]))
      .filter((n) => Number.isFinite(n))
      .sort((a, b) => a - b);

    if (numbers.length < 2) {
      return JSON.stringify({ edges: [], foundation: numbers, notes: 'stub: nothing to chain' });
    }

    const edges = numbers.slice(1).map((n, i) => ({
      dependent: n,
      prerequisite: numbers[i],
      why: `stub: card ${n} follows card ${numbers[i]}`,
    }));

    return JSON.stringify({
      edges,
      // The first card, which by the chain above everything transitively needs.
      foundation: [numbers[0]],
      notes: 'stub: derived a chain from the cards it was given',
    });
  };

  return {
    async chat(options: ChatOptions) {
      return { text: graphFor(options), model: 'stub/cartographer', usage: null };
    },
    chatStream() {
      // The Cartographer never streams: one request is one JSON answer, and
      // there is no partial graph worth rendering.
      throw new Error('chatStream is not available for the Cartographer');
    },
    async embed() {
      throw new Error('embed is not available for the Cartographer');
    },
  } as unknown as IModelProvider;
}
