import { z } from 'zod';
import type { PrismaClient } from '@repo/db';
import type { IEmbeddingProvider, IModelProvider } from '@repo/providers';
import type { ArchivistOutput, ArchivistMatch, Requirement, Coverage, ImpactLevel } from '@repo/shared';
import { ArchivistOutputSchema } from '@repo/shared';
import { queryPresetsByVector, type RankedPreset } from './rag-retriever';

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

/** DB Level ('LOW'|'MEDIUM'|'HIGH') -> prompt ImpactLevel ('Low'|'Medium'|'High'). */
function toImpactLevel(dbLevel: string): ImpactLevel {
  const s = dbLevel.charAt(0) + dbLevel.slice(1).toLowerCase();
  return (s === 'Low' || s === 'Medium' || s === 'High' ? s : 'Medium') as ImpactLevel;
}

/** Coverage per the ARCHIVIST prompt: state it honestly, never fabricate a preset. */
function classifyCoverage(score: number): Coverage {
  if (score >= 0.75) return 'full';
  if (score >= 0.45) return 'partial';
  return 'none';
}

function noMatchFor(req: Requirement): ArchivistMatch {
  return {
    requirementId: req.id,
    taxonomyKey: req.taxonomyKey,
    coverage: 'none',
    adjustments: {
      projectSizeDelta: '',
      dataVolume: req.dataVolume,
      integrationCount: req.integrationCount,
      aiAssist: 'Low',
      risk: 'Medium',
    },
    rationale: 'No historical analogue found — net-new scope, build up from first principles.',
    sequencing: { requires: [], blocks: [], canParallel: true },
  };
}

/**
 * Embed each requirement individually and find its nearest preset. Returns
 * one match per requirement (coverage full/partial/none), never fabricating a
 * preset ID when nothing fits, per the live ARCHIVIST prompt's RULES.
 */
export async function runArchivist(
  requirements: Requirement[],
  ctx: ArchivistContext,
): Promise<ArchivistOutput> {
  if (requirements.length === 0) {
    return ArchivistOutputSchema.parse({ matches: [] });
  }

  const topK = ctx.topK ?? 5;
  const matches: ArchivistMatch[] = [];

  for (const req of requirements) {
    const [queryVector] = await ctx.embeddingProvider.embed(req.text);
    if (!queryVector) {
      matches.push(noMatchFor(req));
      continue;
    }

    let candidates = await queryPresetsByVector(ctx.db, queryVector, topK);
    if (candidates.length === 0) {
      matches.push(noMatchFor(req));
      continue;
    }

    if (ctx.rerank && ctx.modelProvider && ctx.modelString && candidates.length > 1) {
      candidates = await rerankCandidatesForRequirement(candidates, req, ctx.modelProvider, ctx.modelString);
    }

    const best = candidates[0]!;
    const coverage = classifyCoverage(best.score);

    if (coverage === 'none') {
      matches.push(noMatchFor(req));
      continue;
    }

    const meta = await ctx.db.presetVersion.findFirst({
      where: { presetId: best.presetId, version: best.presetVersion, active: true },
      select: {
        presetId: true,
        version: true,
        risk: true,
        aiAssist: true,
        beHours: true,
        feHours: true,
        taxonomyKey: true,
        requires: true,
        blocks: true,
        canParallel: true,
        name: true,
      },
    });

    if (!meta) {
      matches.push(noMatchFor(req));
      continue;
    }

    matches.push({
      requirementId: req.id,
      taxonomyKey: meta.taxonomyKey ?? req.taxonomyKey,
      coverage,
      presetId: meta.presetId,
      presetVersion: meta.version,
      score: best.score,
      beHours: meta.beHours,
      feHours: meta.feHours,
      adjustments: {
        projectSizeDelta: `preset "${meta.name}" matched at ${(best.score * 100).toFixed(0)}%`,
        dataVolume: req.dataVolume,
        integrationCount: req.integrationCount,
        aiAssist: toImpactLevel(meta.aiAssist),
        risk: toImpactLevel(meta.risk),
      },
      rationale:
        coverage === 'full'
          ? `Closely matches preset "${meta.name}" (${meta.presetId}).`
          : `Partially matches preset "${meta.name}" (${meta.presetId}) — verify coverage gap before anchoring fully.`,
      sequencing: { requires: meta.requires, blocks: meta.blocks, canParallel: meta.canParallel },
    });
  }

  return ArchivistOutputSchema.parse({ matches });
}

/**
 * LLM re-rank: ask the model which candidate best fits THIS requirement's
 * specific scope (not just category match), per the ARCHIVIST prompt's
 * METHOD step 2. Tolerant — falls back to vector order if re-rank fails.
 */
async function rerankCandidatesForRequirement(
  candidates: RankedPreset[],
  requirement: Requirement,
  modelProvider: IModelProvider,
  modelString: string,
): Promise<RankedPreset[]> {
  try {
    const candidateList = candidates
      .map((c, i) => `${i}: ${c.name} (${c.presetId}) score=${c.score.toFixed(3)} BE=${c.beHours}h FE=${c.feHours}h`)
      .join('\n');

    const rawResponse = await modelProvider.chat({
      model: modelString,
      messages: [
        {
          role: 'user',
          content: `Re-rank these preset candidates by genuine fit to this requirement's scope — not just category match.

Requirement: ${requirement.text} [category=${requirement.category}, req_type=${requirement.reqType}]

Candidates (index: details):
${candidateList}

Respond with JSON: {"reranked": ["indices in preferred order, e.g. 2,0,1"]}`,
        },
      ],
      temperature: 0,
    });

    const jsonMatch = rawResponse.match(/\{[\s\S]*\}/);
    if (!jsonMatch?.[0]) return candidates;

    const parsed = LLMRerankSchema.safeParse(JSON.parse(jsonMatch[0]));
    if (!parsed.success) return candidates;

    const order = parsed.data.reranked.map(Number).filter((i) => i >= 0 && i < candidates.length);
    if (order.length === 0) return candidates;

    const reordered: RankedPreset[] = [];
    const used = new Set<number>();
    for (const idx of order) {
      if (!used.has(idx)) {
        reordered.push(candidates[idx]!);
        used.add(idx);
      }
    }
    for (let i = 0; i < candidates.length; i++) {
      if (!used.has(i)) reordered.push(candidates[i]!);
    }
    return reordered;
  } catch {
    return candidates;
  }
}
