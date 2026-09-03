import { createModelProvider, type ChatOptions, type IModelProvider } from '@repo/providers';

/**
 * Which model provider artifact generation talks to. AEH-239.
 *
 * Real OpenRouter everywhere except under OPENROUTER_STUB, which
 * playwright.config sets for the e2e run. Same narrow-flag reasoning as
 * `oracle-provider.ts` and `cartographer-provider.ts`: OPENROUTER_API_KEY also
 * feeds ingest, so blanking it to make this deterministic would silently change
 * a subsystem the specs are not testing.
 */
export function artifactModelProvider(): IModelProvider {
  return process.env['OPENROUTER_STUB'] === '1' ? stubArtifactProvider() : createModelProvider();
}

/**
 * A deterministic artifact generator for the e2e run.
 *
 * It answers BOTH call shapes, because generation is not one call: an outline
 * step and then one call per section. Telling them apart by what the envelope
 * asks for is what lets one stub serve the whole pipeline.
 *
 * Like `stubCartographerProvider`, it DERIVES from the corpus it was handed
 * rather than returning a canned payload. The outline it plans is built from
 * headings that actually appear in the dossier, so a spec passing here means
 * the corpus really was assembled, really was selected down to the ticked
 * sections, and really did reach the model. A fixed `{"sections":[…]}` would
 * pass against an estimate with no data at all.
 */
function stubArtifactProvider(): IModelProvider {
  const answer = (options: ChatOptions): string => {
    const text = options.messages.map((m) => String(m.content)).join('\n');

    if (text.includes('Plan the sections')) {
      // The dossier renders each selected slice under a "## Label" heading, so
      // those headings are the real evidence of what was sent. One section per
      // heading means the outline's length is a fact about the corpus.
      const headings = [...text.matchAll(/^## (.+)$/gm)].map((m) => m[1]!.trim());
      const sections = (headings.length ? headings : ['Overview']).map((h, i) => ({
        id: h.toLowerCase().replace(/[^a-z0-9]+/g, '-') || `section-${i + 1}`,
        title: h,
        brief: `Summarise what the dossier says under "${h}".`,
      }));
      return JSON.stringify({
        title: 'Stub artifact',
        vocabulary: sections.map((s) => s.title),
        sections,
      });
    }

    // A section. Echo the id it was told to scope under, so the assembled
    // document proves each call got its own instruction rather than a shared
    // one — and produce markup the shell's own classes style, so the e2e
    // renders something that looks like a real artifact.
    const scoped = /#panel-([a-z0-9-]+)/.exec(text)?.[1] ?? 'unknown';
    const title = /You are writing section \d+ of \d+: "(.+?)"/.exec(text)?.[1] ?? 'Section';
    return [
      `<style>#panel-${scoped} .stub{border-left:3px solid var(--green)}</style>`,
      `<h2>${title}</h2>`,
      `<div class="card stub"><p class="muted">Generated for section <span class="num">${scoped}</span>.</p></div>`,
    ].join('');
  };

  return {
    async chat(options: ChatOptions) {
      return {
        text: answer(options),
        model: 'stub/artifact',
        usage: { promptTokens: 100, completionTokens: 200, costUsd: 0.0001 },
      };
    },
    // Never called: artifact generation writes whole sections, so there is no
    // partial fragment worth streaming.
    chatStream() {
      throw new Error('chatStream is not used by artifact generation');
    },
    async embed() {
      throw new Error('embed is not available for artifact generation');
    },
  } as unknown as IModelProvider;
}
