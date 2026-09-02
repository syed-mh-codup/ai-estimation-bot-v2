import { z } from 'zod';
import { loadPresetGraph, type PrismaClient } from '@repo/db';
import { prerequisitesOf } from '@repo/shared';
import type { IEmbeddingProvider, IModelProvider } from '@repo/providers';
import type { ArchivistOutput, ArchivistMatch, Requirement, Coverage, ImpactLevel, Phase } from '@repo/shared';
import { ArchivistOutputSchema } from '@repo/shared';
import { queryPresetsByVector, type RankedPreset } from './rag-retriever';
import type { UsageRecorder } from './usage-recorder';

export type ArchivistContext = {
  db: PrismaClient;
  embeddingProvider: IEmbeddingProvider;
  modelProvider?: IModelProvider;
  modelString?: string;
  topK?: number;
  rerank?: boolean;
  recorder: UsageRecorder;
};

const LLMRerankSchema = z.object({
  reranked: z.array(z.string()),
});

/** DB Level ('LOW'|'MEDIUM'|'HIGH') -> prompt ImpactLevel ('Low'|'Medium'|'High'). */
function toImpactLevel(dbLevel: string): ImpactLevel {
  const s = dbLevel.charAt(0) + dbLevel.slice(1).toLowerCase();
  return (s === 'Low' || s === 'Medium' || s === 'High' ? s : 'Medium') as ImpactLevel;
}

/** DB PresetPhase ('FOUNDATION'|'CORE'|'ENHANCEMENT') -> menu-card Phase. */
function toCardPhase(dbPhase: string): Phase | undefined {
  const s = dbPhase.charAt(0) + dbPhase.slice(1).toLowerCase();
  return s === 'Foundation' || s === 'Core' || s === 'Enhancement' ? (s as Phase) : undefined;
}

/**
 * How well the matched preset's historical project sizes cover this
 * requirement's.
 *
 * This field used to be filled with the match score restated as a sentence,
 * which is what `score` already says. `projectSizeFit` — the column that exists
 * precisely to answer this — was written on all 45 seeded presets and read by
 * nothing. A preset proven at SMB being anchored to an Enterprise requirement is
 * a real reason to distrust its hours, and the Specialists get to see it now.
 */
function describeProjectSizeFit(requirementSize: string, fit: string[]): string {
  if (fit.length === 0) return 'no recorded project-size fit for this preset';
  if (fit.includes(requirementSize)) return `proven at ${requirementSize}`;
  return `proven at ${fit.join(', ')} — this requirement is ${requirementSize}, expect drift`;
}

/**
 * The delivery caveats a matched preset carries. Statements about the estimate
 * rather than about its size, so they end up in `assumptions`.
 */
function presetCaveatsFor(meta: {
  presetId: string;
  notes: string;
  spikeNeeded: boolean;
  /** DIRECT prerequisites, by display name. Deliberately not the transitive set:
   *  a caveat naming eighteen presets is noise, and the immediate ones are what
   *  a human sanity-checks the estimate against. */
  prerequisiteNames: string[];
  canParallel: boolean;
}): string[] {
  const out: string[] = [];
  const notes = meta.notes.trim();
  if (notes) out.push(`${meta.presetId}: ${notes}`);
  if (meta.spikeNeeded) {
    out.push(`${meta.presetId} has historically needed a discovery spike before delivery.`);
  }
  if (meta.prerequisiteNames.length > 0) {
    out.push(
      `${meta.presetId} needs ${meta.prerequisiteNames.join(', ')} delivered first — check they are in scope.`,
    );
  }
  if (!meta.canParallel) {
    out.push(`${meta.presetId} has not been delivered in parallel with other work.`);
  }
  return out;
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
    sequencing: { prerequisitePresetIds: [], canParallel: true },
    presetCaveats: [],
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

  // One load for the whole run. Every match needs reachability over the same
  // graph, and it is a few hundred rows — a query per requirement would be the
  // same data fetched N times.
  const graph = await loadPresetGraph(ctx.db);

  for (const req of requirements) {
    const embedResult = await ctx.embeddingProvider.embed(req.text);
    await ctx.recorder.record({ kind: 'ARCHIVIST', model: embedResult.model, usage: embedResult.usage });
    const queryVector = embedResult.vectors[0];
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
      candidates = await rerankCandidatesForRequirement(
        candidates,
        req,
        ctx.modelProvider,
        ctx.modelString,
        ctx.recorder,
      );
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
        anchor: {
          select: {
            risk: true,
            aiAssist: true,
            devHours: true,
            touchesFrontend: true,
            touchesBackend: true,
            taxonomyKey: true,
            spikeNeeded: true,
            phase: true,
            projectSizeFit: true,
          },
        },
        retrieval: {
          select: { name: true, notes: true },
        },
        composition: {
          select: { canParallel: true },
        },
      },
    });

    if (!meta?.anchor || !meta.retrieval) {
      matches.push(noMatchFor(req));
      continue;
    }

    const anchor = meta.anchor;
    const name = meta.retrieval.name;
    // Transitive, not direct. The Architect decides whether a card is safe to
    // remove by asking whether any OTHER card's prerequisites reach it, and it
    // has no graph of its own — so the reachable set has to travel in the DTO.
    // Closures here are small (the retired library's largest was 18).
    const prerequisitePresetIds = [...prerequisitesOf(graph, meta.presetId)];
    const directPrerequisiteNames = (graph.edges.get(meta.presetId) ?? []).map(
      (id) => graph.nodes.get(id)?.name ?? id,
    );
    const sequencing = {
      prerequisitePresetIds,
      canParallel: meta.composition?.canParallel ?? true,
    };

    matches.push({
      requirementId: req.id,
      taxonomyKey: anchor.taxonomyKey ?? req.taxonomyKey,
      coverage,
      presetId: meta.presetId,
      presetVersion: meta.version,
      score: best.score,
      devHours: anchor.devHours,
      touchesFrontend: anchor.touchesFrontend,
      touchesBackend: anchor.touchesBackend,
      adjustments: {
        projectSizeDelta: describeProjectSizeFit(req.projectSize, anchor.projectSizeFit),
        dataVolume: req.dataVolume,
        integrationCount: req.integrationCount,
        aiAssist: toImpactLevel(anchor.aiAssist),
        risk: toImpactLevel(anchor.risk),
      },
      rationale:
        coverage === 'full'
          ? `Closely matches preset "${name}" (${meta.presetId}).`
          : `Partially matches preset "${name}" (${meta.presetId}) — verify coverage gap before anchoring fully.`,
      sequencing,
      presetCaveats: presetCaveatsFor({
        presetId: meta.presetId,
        notes: meta.retrieval.notes,
        spikeNeeded: anchor.spikeNeeded,
        prerequisiteNames: directPrerequisiteNames,
        canParallel: sequencing.canParallel,
      }),
      presetPhase: toCardPhase(anchor.phase),
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
  recorder: UsageRecorder,
): Promise<RankedPreset[]> {
  try {
    const candidateList = candidates
      .map((c, i) => `${i}: ${c.name} (${c.presetId}) score=${c.score.toFixed(3)} DEV=${c.devHours}h`)
      .join('\n');

    const result = await modelProvider.chat({
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
    await recorder.record({ kind: 'ARCHIVIST', model: result.model, usage: result.usage });
    const rawResponse = result.text;

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
