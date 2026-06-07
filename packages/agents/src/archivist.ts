import { z } from 'zod';
import type { PrismaClient } from '@repo/db';
import type { IEmbeddingProvider, IModelProvider } from '@repo/providers';
import type { ArchivistOutput, ArchivistMatch, Requirement } from '@repo/shared';
import { ArchivistOutputSchema } from '@repo/shared';
import { queryPresetsByVector } from './rag-retriever';

export type ArchivistContext = {
  db: PrismaClient;
  embeddingProvider: IEmbeddingProvider;
  modelProvider?: IModelProvider;
  modelString?: string;
  topK?: number;
  rerank?: boolean;
};

const LLMRerankSchema = z.object({
  reranked: z.array(z.string()),
});

/**
 * Embed requirements text and find nearest preset versions.
 * Returns matches with presetId/version, hours, risk, aiAssist, and score.
 */
export async function runArchivist(
  requirements: Requirement[],
  ctx: ArchivistContext,
): Promise<ArchivistOutput> {
  if (requirements.length === 0) {
    return ArchivistOutputSchema.parse({ matches: [] });
  }

  const topK = ctx.topK ?? 5;

  // Build a single query text from all requirements
  const queryText = requirements.map((r) => r.text).join('. ');
  const [queryVector] = await ctx.embeddingProvider.embed(queryText);
  if (!queryVector) {
    return ArchivistOutputSchema.parse({ matches: [] });
  }

  const rankedPresets = await queryPresetsByVector(ctx.db, queryVector, topK);

  // Fetch full PresetVersion metadata for matched presets
  const presetVersionIds = rankedPresets.map((p) => ({
    presetId: p.presetId,
    version: p.presetVersion,
  }));

  const matchData = await ctx.db.presetVersion.findMany({
    where: {
      OR: presetVersionIds.map((p) => ({ presetId: p.presetId, version: p.version })),
      active: true,
    },
    select: {
      presetId: true,
      version: true,
      risk: true,
      aiAssist: true,
      beHours: true,
      feHours: true,
      taxonomyKey: true,
    },
  });

  const metaByKey = new Map(matchData.map((m) => [`${m.presetId}:${m.version}`, m]));

  let matches: ArchivistMatch[] = rankedPresets
    .map((p) => {
      const meta = metaByKey.get(`${p.presetId}:${p.presetVersion}`);
      if (!meta) return null;
      return {
        taxonomyKey: meta.taxonomyKey ?? requirements[0]?.taxonomyKey ?? '',
        presetId: meta.presetId,
        presetVersion: meta.version,
        score: p.score,
        beHours: meta.beHours,
        feHours: meta.feHours,
        risk: meta.risk as 'LOW' | 'MEDIUM' | 'HIGH',
        aiAssist: meta.aiAssist as 'LOW' | 'MEDIUM' | 'HIGH',
      };
    })
    .filter((m): m is ArchivistMatch => m !== null);

  // Optional LLM re-rank (WS11-03): if enabled and model is available
  if (ctx.rerank && ctx.modelProvider && ctx.modelString && matches.length > 1) {
    matches = await rerankMatches(matches, requirements, ctx.modelProvider, ctx.modelString);
  }

  return ArchivistOutputSchema.parse({ matches });
}

/**
 * LLM re-rank: ask the model to order matches by relevance to requirements.
 * Tolerant — falls back to original order if re-rank fails or produces bad output.
 */
async function rerankMatches(
  matches: ArchivistMatch[],
  requirements: Requirement[],
  modelProvider: IModelProvider,
  modelString: string,
): Promise<ArchivistMatch[]> {
  try {
    const matchList = matches
      .map((m, i) => `${i}: presetId=${m.presetId} score=${m.score.toFixed(3)} risk=${m.risk}`)
      .join('\n');

    const reqText = requirements.map((r) => r.text).join('; ');

    const rawResponse = await modelProvider.chat({
      model: modelString,
      messages: [
        {
          role: 'user',
          content: `Re-rank these preset matches by relevance to the requirements.

Requirements: ${reqText}

Matches (index: details):
${matchList}

Respond with JSON: {"reranked": [indices in preferred order, e.g. ["2","0","1"]]}`,
        },
      ],
      temperature: 0,
    });

    const jsonMatch = rawResponse.match(/\{[\s\S]*\}/);
    if (!jsonMatch?.[0]) return matches;

    const parsed = LLMRerankSchema.safeParse(JSON.parse(jsonMatch[0]));
    if (!parsed.success) return matches;

    const order = parsed.data.reranked.map(Number).filter((i) => i >= 0 && i < matches.length);
    if (order.length === 0) return matches;

    const reordered: ArchivistMatch[] = [];
    const used = new Set<number>();
    for (const idx of order) {
      if (!used.has(idx)) {
        reordered.push(matches[idx]!);
        used.add(idx);
      }
    }
    // Append any not included in re-rank
    for (let i = 0; i < matches.length; i++) {
      if (!used.has(i)) reordered.push(matches[i]!);
    }
    return reordered;
  } catch {
    return matches;
  }
}
