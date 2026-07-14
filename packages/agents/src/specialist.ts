import { z } from 'zod';
import type { IModelProvider } from '@repo/providers';
import type { SpecialistOutput, SpecialistInput, SpecialistLineItem } from '@repo/shared';
import { SpecialistOutputSchema, ComplexityTierSchema, FOUR_HOUR_CAP } from '@repo/shared';
import { chatJSON } from './llm-json';
import { withRetry } from './step-error';

export type SpecialistContext = {
  modelProvider: IModelProvider;
  modelString: string;
  instructions: Record<'DEV' | 'QA' | 'PM' | 'BA', string>;
};

/**
 * What the LLM emits: an ordered list of atomic (<=4h) line items for this
 * role + requirement. `dependsOn` references OTHER items in this same list
 * by their 0-based position (the model can't know final line_item_ids up
 * front) — resolved to real ids after the response comes back.
 */
const LLMLineItemSchema = z.object({
  description: z.string(),
  // No min/max here despite the four-hour rule: the model sometimes emits a
  // 0h "not needed" placeholder instead of omitting the item, or exceeds the
  // cap on a genuinely large unit of work despite the explicit instruction
  // not to. Both are normalized below (0h items dropped, oversized items
  // split into <=4h chunks) rather than rejected — a hard bound here would
  // kill the whole run on an otherwise well-formed response instead of
  // actually enforcing the four-hour rule.
  hours: z.number().min(0),
  complexity: ComplexityTierSchema,
  aiAssistApplied: z.boolean().default(false),
  dependsOn: z.array(z.number().int().min(0)).default([]),
});

const LLMSpecialistSchema = z.object({
  lineItems: z.array(LLMLineItemSchema).min(1),
  assumptions: z.array(z.string()).default([]),
});

function describeCoverage(input: SpecialistInput): string {
  const m = input.archivistMatch;
  if (!m || m.coverage === 'none') {
    return 'Coverage: none — no historical preset analogue. Build this up from first principles, item by item, and note the absence of an anchor in assumptions.';
  }
  const anchor = `BE=${m.beHours ?? 0}h, FE=${m.feHours ?? 0}h`;
  const adj = m.adjustments;
  return [
    `Coverage: ${m.coverage} (preset ${m.presetId ?? 'n/a'} v${m.presetVersion ?? '?'}, match score ${m.score?.toFixed(2) ?? 'n/a'}).`,
    `Anchor at base complexity: ${anchor}. Treat this as an anchor, not a final answer.`,
    `Adjustment signals — project_size delta: ${adj.projectSizeDelta || 'n/a'}; data_volume: ${adj.dataVolume}; integration_count: ${adj.integrationCount}; ai_assist: ${adj.aiAssist}; risk: ${adj.risk}.`,
    `Rationale: ${m.rationale}`,
    m.coverage === 'partial' ? 'Preset covers only part of this requirement — build up the uncovered gap from first principles too.' : '',
  ]
    .filter(Boolean)
    .join('\n');
}

function buildUserMessage(role: 'DEV' | 'QA' | 'PM' | 'BA', input: SpecialistInput): string {
  const { requirement, riskFindings, complexityScore } = input;
  const riskText = riskFindings.length
    ? riskFindings.map((f: typeof riskFindings[number]) => `- [${f.riskFlags.join(', ') || 'risk'}] ${f.claim} (${f.citation})`).join('\n')
    : '(no Detective findings for this requirement)';

  return `Estimate ${role} effort for this requirement, decomposed into atomic line items per your METHOD.

Requirement ${requirement.id}: ${requirement.text}
category=${requirement.category} | req_type=${requirement.reqType} | platforms=${requirement.platforms.join(', ') || 'none'}
project_size=${requirement.projectSize} | data_volume=${requirement.dataVolume} | integration_count=${requirement.integrationCount}
Overall complexity score: ${complexityScore}/5

${describeCoverage(input)}

Detective risk findings:
${riskText}

Respond with JSON only, matching exactly this shape:
{
  "lineItems": [
    {
      "description": "specific atomic unit of work",
      "hours": <number, 0.25-4.0, granularity 0.25>,
      "complexity": "base" | "elevated" | "high",
      "aiAssistApplied": true | false,
      "dependsOn": [<0-based indices of other items in THIS list this depends on>]
    }
  ],
  "assumptions": ["..."]
}
HARD CAP: no item's "hours" may exceed 4.0. If a unit of work needs more, split it into multiple items.
If a category of work genuinely isn't needed for this requirement (e.g. no integration to test), OMIT it from "lineItems" entirely — do not include a 0-hour placeholder item.`;
}

function snapToQuarterHour(hours: number): number {
  return Math.max(0.25, Math.min(FOUR_HOUR_CAP, Math.round(hours * 4) / 4));
}

/**
 * Split a total that exceeds FOUR_HOUR_CAP into N<=4h, >=0.25h chunks
 * (N = ceil(total/cap)), roughly evenly, snapped to quarter-hour granularity.
 * The last chunk absorbs any rounding drift so the chunks still sum close
 * to the original total.
 */
function splitOversizedHours(totalHours: number): number[] {
  const n = Math.ceil(totalHours / FOUR_HOUR_CAP);
  const chunks = Array.from({ length: n }, () => snapToQuarterHour(totalHours / n));
  const drift = Math.round((totalHours - chunks.reduce((s, h) => s + h, 0)) * 4) / 4;
  if (drift !== 0) {
    chunks[n - 1] = snapToQuarterHour((chunks[n - 1] ?? 0.25) + drift);
  }
  return chunks;
}

/**
 * Run a single specialist (DEV, QA, PM, or BA): decompose the requirement's
 * scope for this role into atomic, <=4h line items per the FOUR-HOUR RULE.
 */
export async function runSpecialist(
  role: 'DEV' | 'QA' | 'PM' | 'BA',
  input: SpecialistInput,
  ctx: SpecialistContext,
): Promise<SpecialistOutput> {
  const step = (`SPECIALIST_${role}` as const) as
    | 'SPECIALIST_DEV'
    | 'SPECIALIST_QA'
    | 'SPECIALIST_PM'
    | 'SPECIALIST_BA';

  const llmResult = await withRetry(step, () =>
    chatJSON(
      ctx.modelProvider,
      {
        model: ctx.modelString,
        messages: [
          { role: 'system', content: ctx.instructions[role] },
          { role: 'user', content: buildUserMessage(role, input) },
        ],
        temperature: 0,
      },
      LLMSpecialistSchema,
      `Specialist(${role})`,
    ),
  );

  const idOf = (index: number): string =>
    `${role}-${input.requirement.id}-${String(index + 1).padStart(2, '0')}`;

  type LLMLineItem = {
    description: string;
    hours: number;
    complexity: 'base' | 'elevated' | 'high';
    aiAssistApplied: boolean;
    dependsOn: number[];
  };

  const rawLineItems = llmResult.lineItems as unknown as LLMLineItem[];
  // Drop 0h "not needed" items (see LLMLineItemSchema comment). Every
  // survivor is expanded into 1+ <=4h chunks (>1 only when the model
  // exceeded the cap). `dependsOn` is expressed against ORIGINAL (pre-drop,
  // pre-split) list positions, so it's remapped: other items depend on the
  // LAST chunk of whichever original item they referenced (that's when the
  // work is actually done); a split item's own internal chunks chain
  // sequentially, with the original dependsOn attached to the first chunk.
  type Expanded = {
    originalIndex: number;
    description: string;
    hours: number;
    complexity: 'base' | 'elevated' | 'high';
    aiAssistApplied: boolean;
    dependsOnOriginal: number[] | null; // null = internal chain link, not the model's dependsOn
  };
  const expanded: Expanded[] = [];
  const lastChunkIndexByOriginal = new Map<number, number>();

  rawLineItems.forEach((li, originalIndex) => {
    if (li.hours < 0.25) return; // 0h "not needed" placeholder
    const chunkHours = li.hours > FOUR_HOUR_CAP ? splitOversizedHours(li.hours) : [snapToQuarterHour(li.hours)];
    chunkHours.forEach((hours, chunkIndex) => {
      expanded.push({
        originalIndex,
        description: chunkHours.length > 1 ? `${li.description} (part ${chunkIndex + 1}/${chunkHours.length})` : li.description,
        hours,
        complexity: li.complexity,
        aiAssistApplied: li.aiAssistApplied,
        dependsOnOriginal: chunkIndex === 0 ? li.dependsOn : null,
      });
    });
    lastChunkIndexByOriginal.set(originalIndex, expanded.length - 1);
  });

  const idByExpandedIndex = expanded.map((_, i) => idOf(i));

  const lineItems: SpecialistLineItem[] = expanded.map((item, i) => {
    const deps: string[] = [];
    if (item.dependsOnOriginal === null) {
      // Non-first chunk of a split item: chain to the immediately preceding chunk.
      deps.push(idByExpandedIndex[i - 1]!);
    } else {
      for (const idx of item.dependsOnOriginal) {
        if (idx === item.originalIndex) continue;
        const lastChunk = lastChunkIndexByOriginal.get(idx);
        if (lastChunk !== undefined) deps.push(idByExpandedIndex[lastChunk]!);
      }
    }
    return {
      id: idOf(i),
      requirementId: input.requirement.id,
      menuCardId: input.menuCardId,
      description: item.description,
      hours: item.hours,
      complexity: item.complexity,
      aiAssistApplied: item.aiAssistApplied,
      dependsOn: deps,
      anchorPresetIds: input.archivistMatch?.presetId ? [input.archivistMatch.presetId] : [],
    };
  });

  return SpecialistOutputSchema.parse({
    role,
    lineItems,
    assumptions: llmResult.assumptions,
  });
}

/**
 * Run all 4 specialists (DEV, QA, PM, BA) independently for a requirement.
 * Returns one SpecialistOutput (a set of line items) per role.
 */
export async function runSpecialistCouncil(
  input: SpecialistInput,
  ctx: SpecialistContext,
): Promise<SpecialistOutput[]> {
  const roles: Array<'DEV' | 'QA' | 'PM' | 'BA'> = ['DEV', 'QA', 'PM', 'BA'];
  return Promise.all(roles.map((role) => runSpecialist(role, input, ctx)));
}

export type { SpecialistOutput };
