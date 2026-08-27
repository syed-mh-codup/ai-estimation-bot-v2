import { z } from 'zod';
import type { IModelProvider, ISearchProvider, IMcpProvider } from '@repo/providers';
import type { DetectiveOutput, RiskFinding, OpenQuestion, Requirement } from '@repo/shared';
import { DetectiveOutputSchema, KNOWN_RISK_FLAGS, PlatformSchema } from '@repo/shared';
import { chatJSON } from './llm-json';

export type DetectiveContext = {
  modelProvider: IModelProvider;
  modelString: string;
  instructions: string;
  searchProvider: ISearchProvider;
  mcpProvider: IMcpProvider;
};

const LLMRiskSchema = z.object({
  requirementId: z.string(),
  platform: PlatformSchema.optional(),
  claim: z.string(),
  /**
   * Stays `z.string()` on purpose, and the trailing `...` in the prompt's
   * example list is deliberate too. Two reasons, and they pull the same way:
   * a strict enum here would fail the whole Detective step over one invented
   * flag, and more importantly the stage exists to catch work nobody thought
   * of — a closed list would make the set of things nobody thought of a fixed
   * list. Off-list flags are safe now because they surface to a human instead
   * of being dropped; see detectHiddenWork. AEH-263.
   */
  riskFlags: z.array(z.string()).default([]),
  citation: z.string(),
  spikeRecommended: z.boolean().default(false),
  spikePresetId: z.string().optional(),
});

const LLMQuestionSchema = z.object({
  requirementId: z.string(),
  question: z.string(),
  citation: z.string().optional(),
  blocksEstimation: z.boolean().default(false),
});

const LLMDetectiveSchema = z.object({
  risks: z.array(LLMRiskSchema).default([]),
  questions: z.array(LLMQuestionSchema).default([]),
});

/**
 * Merge findings whose (requirementId, claim) are identical, keeping all citations.
 */
export function deduplicateRisks(risks: RiskFinding[]): RiskFinding[] {
  const seen = new Map<string, RiskFinding>();
  for (const r of risks) {
    const key = `${r.requirementId}::${r.claim.toLowerCase().trim()}`;
    const existing = seen.get(key);
    if (existing) {
      if (!existing.citation.includes(r.citation)) {
        seen.set(key, { ...existing, citation: `${existing.citation}; ${r.citation}` });
      }
    } else {
      seen.set(key, { ...r });
    }
  }
  return Array.from(seen.values());
}

async function gatherSearchContext(
  requirements: Requirement[],
  searchProvider: ISearchProvider,
): Promise<string> {
  const priority = [...requirements].sort((a, b) => {
    const score = (r: Requirement) => (r.blocksEstimation ? 2 : 0) + (r.integrationCount >= 3 ? 1 : 0);
    return score(b) - score(a);
  });

  const sections: string[] = [];
  for (const req of priority) {
    const query = `${req.text} ${req.platforms.join(' ')} technical risks integration`;
    const results = await searchProvider.search(query, 3);
    const snippet = results.map((r: { title: string; url: string; snippet: string }) => `[${r.title}](${r.url}): ${r.snippet}`).join('\n');
    sections.push(`Query for ${req.id}: ${query}\n${snippet || '(no search results)'}`);
  }
  return sections.join('\n\n');
}

function buildUserMessage(requirements: Requirement[], searchContext: string, mcpSummary: string): string {
  const requirementsText = requirements
    .map((r) => `- ${r.id}: ${r.text} [platforms: ${r.platforms.join(', ') || 'none'}, blocks_estimation: ${r.blocksEstimation}, integration_count: ${r.integrationCount}]`)
    .join('\n');

  return `Investigate the risky and unknown parts of these requirements per your METHOD and FOCUS AREAS.
Take requirements with blocks_estimation=true or high integration_count first.

Requirements:
${requirementsText}

Search results:
${searchContext || '(no search results available)'}

MCP tools available:
${mcpSummary}

Respond with JSON only, matching exactly this shape:
{
  "risks": [
    {
      "requirementId": "REQ-###",
      "platform": "<controlled platform value>" | omit,
      "claim": "specific technical claim driving risk",
      "riskFlags": [${KNOWN_RISK_FLAGS.map((f) => `"${f}"`).join(', ')}, ...],
      "citation": "SOW location or external source — never assert without one",
      "spikeRecommended": true | false,
      "spikePresetId": "P01".."P06" | omit
    }
  ],
  "questions": [
    {
      "requirementId": "REQ-###",
      "question": "closed, specific, decision-relevant question a client can answer",
      "citation": "..." (optional),
      "blocksEstimation": true | false
    }
  ]
}
If you cannot cite a platform limitation, frame it as a question instead of an asserted risk.`;
}

/**
 * Run the Detective agent: investigate blocking ambiguities + high-risk
 * integrations, producing a risk register + open questions with citations.
 */
export async function runDetective(
  requirements: Requirement[],
  ctx: DetectiveContext,
): Promise<DetectiveOutput> {
  if (requirements.length === 0) {
    return DetectiveOutputSchema.parse({ risks: [], questions: [] });
  }

  const searchContext = await gatherSearchContext(requirements, ctx.searchProvider);

  const mcpTools = await ctx.mcpProvider.listAllTools();
  const mcpSummary = mcpTools.length > 0
    ? mcpTools.map((t: { connectorId: string; name: string; description: string }) => `${t.connectorId}/${t.name}: ${t.description}`).join('\n')
    : '(no MCP tools available)';

  const llmResult = await chatJSON(
    ctx.modelProvider,
    {
      model: ctx.modelString,
      messages: [
        { role: 'system', content: ctx.instructions },
        { role: 'user', content: buildUserMessage(requirements, searchContext, mcpSummary) },
      ],
      temperature: 0,
    },
    LLMDetectiveSchema,
    'Detective',
  );

  const requirementById = new Map(requirements.map((r) => [r.id, r]));

  const risks: RiskFinding[] = (llmResult.risks ?? [])
    .filter((r) => requirementById.has(r.requirementId))
    .map((r, i) => ({
      id: `RISK-${String(i + 1).padStart(3, '0')}`,
      requirementId: r.requirementId,
      taxonomyKey: requirementById.get(r.requirementId)?.taxonomyKey ?? null,
      platform: r.platform,
      claim: r.claim,
      riskFlags: r.riskFlags ?? [],
      citation: r.citation,
      spikeRecommended: r.spikeRecommended ?? false,
      spikePresetId: r.spikePresetId,
    }));

  const questions: OpenQuestion[] = (llmResult.questions ?? [])
    .filter((q) => requirementById.has(q.requirementId))
    .map((q, i) => ({
      id: `Q-${String(i + 1).padStart(3, '0')}`,
      requirementId: q.requirementId,
      question: q.question,
      citation: q.citation,
      blocksEstimation: q.blocksEstimation ?? false,
    }));

  return DetectiveOutputSchema.parse({ risks: deduplicateRisks(risks), questions });
}
