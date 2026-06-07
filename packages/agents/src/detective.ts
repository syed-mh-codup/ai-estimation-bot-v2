import { z } from 'zod';
import type { IModelProvider } from '@repo/providers';
import type { ISearchProvider } from '@repo/providers';
import type { IMcpProvider } from '@repo/providers';
import type { DetectiveOutput, DetectiveFinding, Requirement } from '@repo/shared';
import { DetectiveOutputSchema } from '@repo/shared';

export type DetectiveContext = {
  modelProvider: IModelProvider;
  modelString: string;
  instructions: string;
  searchProvider: ISearchProvider;
  mcpProvider: IMcpProvider;
};

const LLMFindingsSchema = z.object({
  findings: z.array(
    z.object({
      taxonomyKey: z.string(),
      claim: z.string(),
      source: z.string(),
      riskFlags: z.array(z.string()),
    }),
  ),
});

/**
 * Deduplicate findings: merge findings with identical claim text, keeping all sources.
 */
export function deduplicateFindings(findings: DetectiveFinding[]): DetectiveFinding[] {
  const seen = new Map<string, DetectiveFinding>();
  for (const f of findings) {
    const key = `${f.taxonomyKey}::${f.claim.toLowerCase().trim()}`;
    const existing = seen.get(key);
    if (existing) {
      // Merge sources
      if (!existing.source.includes(f.source)) {
        seen.set(key, { ...existing, source: `${existing.source}; ${f.source}` });
      }
    } else {
      seen.set(key, { ...f });
    }
  }
  return Array.from(seen.values());
}

/**
 * Build search queries from requirements.
 */
function buildSearchQueries(requirements: Requirement[]): string[] {
  return requirements
    .filter((r) => r.taxonomyKey !== null)
    .map((r) => `${r.text} technical complexity risks`);
}

/**
 * Run the Detective agent: gather findings per requirement using search + MCP tools.
 */
export async function runDetective(
  requirements: Requirement[],
  ctx: DetectiveContext,
): Promise<DetectiveOutput> {
  // Gather search results for each requirement
  const searchResults: Array<{ query: string; results: string }> = [];
  for (const req of requirements) {
    const query = `${req.text} technical risks middleware integration`;
    const results = await ctx.searchProvider.search(query, 3);
    const snippet = results
      .map((r) => `[${r.title}](${r.url}): ${r.snippet}`)
      .join('\n');
    searchResults.push({ query, results: snippet || '(no results)' });
  }

  // Gather MCP tool data
  const mcpTools = await ctx.mcpProvider.listAllTools();
  const mcpSummary = mcpTools.length > 0
    ? mcpTools.map((t) => `${t.connectorId}/${t.name}: ${t.description}`).join('\n')
    : '(no MCP tools available)';

  const requirementsText = requirements
    .map((r) => `- ${r.text} [taxonomy: ${r.taxonomyKey ?? 'unknown'}]`)
    .join('\n');

  const searchContext = searchResults
    .map((s) => `Query: ${s.query}\n${s.results}`)
    .join('\n\n');

  const rawResponse = await ctx.modelProvider.chat({
    model: ctx.modelString,
    messages: [
      {
        role: 'system',
        content: ctx.instructions,
      },
      {
        role: 'user',
        content: `Analyse these requirements and identify technical findings with risk flags.

Requirements:
${requirementsText}

Search results:
${searchContext}

MCP tools available:
${mcpSummary}

For each requirement, identify:
1. Technical claims (complexity, integration points, middleware needed)
2. Risk flags (e.g., "rate-limits", "retries", "data-migration", "legacy-system", "api-quota")
3. Source attribution

Respond with JSON only:
{"findings": [{"taxonomyKey": "...", "claim": "...", "source": "...", "riskFlags": ["..."]}]}`,
      },
    ],
    temperature: 0,
  });

  const jsonMatch = rawResponse.match(/\{[\s\S]*\}/);
  if (!jsonMatch?.[0]) {
    throw new Error(`Detective: could not extract JSON from response: ${rawResponse}`);
  }

  const parsed = LLMFindingsSchema.safeParse(JSON.parse(jsonMatch[0]));
  if (!parsed.success) {
    throw new Error(`Detective: invalid response shape: ${parsed.error.message}`);
  }

  const findings = deduplicateFindings(parsed.data.findings);
  return DetectiveOutputSchema.parse({ findings });
}
