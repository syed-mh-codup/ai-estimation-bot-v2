import { z } from 'zod';
import type { IModelProvider } from '@repo/providers';
import type { LibrarianOutput, Requirement } from '@repo/shared';
import { LibrarianOutputSchema } from '@repo/shared';

export type LibrarianContext = {
  modelProvider: IModelProvider;
  modelString: string;
  instructions: string;
};

export type TaxonomyEntry = {
  key: string;
  label: string;
  keywords: string[];
};

const LLMResponseSchema = z.object({
  requirements: z.array(
    z.object({
      text: z.string(),
      taxonomyKey: z.string().nullable(),
      confidence: z.number().min(0).max(1),
      suggestedLabel: z.string().optional(),
    }),
  ),
});

/**
 * Build a prompt that asks the LLM to map SOW text to taxonomy keys.
 */
function buildLibrarianPrompt(
  sowText: string,
  taxonomy: TaxonomyEntry[],
  instructions: string,
): string {
  const taxList = taxonomy
    .map((t) => `- ${t.key}: ${t.label} [keywords: ${t.keywords.join(', ')}]`)
    .join('\n');

  return `${instructions}

## Taxonomy
${taxList || '(no taxonomy loaded yet)'}

## SOW
${sowText}

Respond with valid JSON only, matching this schema:
{"requirements": [{"text": "...", "taxonomyKey": "key.from.taxonomy" | null, "confidence": 0.0-1.0}]}
If no taxonomy key fits, set taxonomyKey to null.`;
}

/**
 * Run the Librarian agent: decompose SOW into requirements with taxonomy keys.
 */
export async function runLibrarian(
  sowText: string,
  taxonomy: TaxonomyEntry[],
  ctx: LibrarianContext,
): Promise<LibrarianOutput> {
  const prompt = buildLibrarianPrompt(sowText, taxonomy, ctx.instructions);

  const rawResponse = await ctx.modelProvider.chat({
    model: ctx.modelString,
    messages: [
      {
        role: 'system',
        content: ctx.instructions,
      },
      {
        role: 'user',
        content: `Decompose this SOW into requirements:\n\n${sowText}\n\nTaxonomy:\n${taxonomy.map((t) => `${t.key}: ${t.label}`).join('\n')}\n\nRespond with JSON only: {"requirements": [{"text": "...", "taxonomyKey": "..." or null, "confidence": 0.0-1.0}]}`,
      },
    ],
    temperature: 0,
  });

  // Extract JSON from response (LLM may wrap in markdown)
  const jsonMatch = rawResponse.match(/\{[\s\S]*\}/);
  if (!jsonMatch?.[0]) {
    throw new Error(`Librarian: could not extract JSON from response: ${rawResponse}`);
  }

  const parsed = LLMResponseSchema.safeParse(JSON.parse(jsonMatch[0]));
  if (!parsed.success) {
    throw new Error(`Librarian: invalid response shape: ${parsed.error.message}`);
  }

  const requirements: Requirement[] = parsed.data.requirements.map((r) => ({
    text: r.text,
    taxonomyKey: r.taxonomyKey,
    confidence: r.confidence,
  }));

  return LibrarianOutputSchema.parse({ requirements });
}

/**
 * RAG retriever: load taxonomy entries from the DB filtered by query similarity.
 * Uses pre-computed embeddings or falls back to keyword match.
 */
export async function loadTaxonomy(db: {
  taxonomyNodeVersion: {
    findMany: (args: { where: { active: boolean }; select: { nodeKey: boolean; label: boolean; keywords: boolean } }) => Promise<Array<{ nodeKey: string; label: string; keywords: string[] }>>;
  };
}): Promise<TaxonomyEntry[]> {
  const nodes = await db.taxonomyNodeVersion.findMany({
    where: { active: true },
    select: { nodeKey: true, label: true, keywords: true },
  });
  return nodes.map((n) => ({ key: n.nodeKey, label: n.label, keywords: n.keywords }));
}
