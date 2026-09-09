import { z } from 'zod';
import type { IModelProvider } from '@repo/providers';
import type { UsageRecorder } from './usage-recorder';
import { CALL_TIMEOUTS, callTuning, type ModelCallLevers } from './model-call';
import type { SpecialistOutput, SpecialistInput, SpecialistLineItem } from '@repo/shared';
import { SpecialistOutputSchema, ComplexityTierSchema, FOUR_HOUR_CAP } from '@repo/shared';
import { chatJSON } from './llm-json';
import { withRetry } from './step-error';

export type SpecialistContext = {
  modelProvider: IModelProvider;
  modelString: string;
  instructions: Record<'DEV' | 'QA' | 'PM' | 'BA', string>;
  recorder: UsageRecorder;
  /**
   * Reasoning effort and provider routing, per role. Keyed the same way as
   * `instructions` because each role is its own prompt row: turning thinking
   * down on DEV must not turn it down on QA, PM and BA. See model-call.ts.
   */
  levers?: Partial<Record<'DEV' | 'QA' | 'PM' | 'BA', ModelCallLevers | undefined>>;
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
  // DEV only, and optional: a missing tag stays untagged rather than failing
  // the run. Never used to divide `hours` — see side-tagging note below.
  side: z.enum(['frontend', 'backend', 'both']).optional(),
});

const LLMSpecialistSchema = z.object({
  lineItems: z.array(LLMLineItemSchema).min(1),
  assumptions: z.array(z.string()).default([]),
  /**
   * Which of the risk flags shown in the prompt these hours actually account
   * for. Filtered against the input before it is trusted — see runSpecialist.
   */
  coversRiskFlags: z.array(z.string()).default([]),
});

/**
 * Render the Archivist's match as the prompt block the specialist actually
 * reads. Exported because this is the last point at which the anchor is still
 * a number the WBS/preset round trip can assert on — past here an LLM
 * re-derives every figure, so nothing downstream is checkable.
 */
export function describeCoverage(input: SpecialistInput): string {
  const m = input.archivistMatch;
  if (!m || m.coverage === 'none') {
    return 'Coverage: none — no historical preset analogue. Build this up from first principles, item by item, and note the absence of an anchor in assumptions.';
  }
  // ONE dev figure. The preset's side flags are passed through as context only —
  // they say what the historical work covered, never how to divide the hours.
  const sides = [m.touchesBackend ? 'backend' : null, m.touchesFrontend ? 'frontend' : null]
    .filter(Boolean)
    .join(' + ');
  const anchor = `DEV=${m.devHours ?? 0}h${sides ? ` (historically ${sides})` : ''}`;
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

/**
 * Only DEV is asked which side of the stack an item touches — QA/PM/BA work
 * isn't frontend or backend, and asking would invite meaningless answers.
 */
function sideFieldSpec(role: 'DEV' | 'QA' | 'PM' | 'BA'): string {
  return role === 'DEV' ? ',\n      "side": "frontend" | "backend" | "both"' : '';
}

function sideGuidance(role: 'DEV' | 'QA' | 'PM' | 'BA'): string {
  if (role !== 'DEV') return '';
  // The hours stay one number. This is a label on the work, not a division of
  // it — stated explicitly because a model told to think about FE and BE
  // separately will otherwise try to give two figures.
  return `
SIDE: tag every item with the side of the stack it touches. Report ONE hours figure per item — "side" describes what that figure covers, it does NOT split it.
Prefer "frontend" or "backend". At this granularity (<=4h atomic units) most work is clearly one or the other: schema, API, jobs, integrations and data migration are backend; components, views, state, styling and client-side validation are frontend.
Use "both" only when a unit genuinely cannot be separated. If an item would be "both" simply because it spans a feature end to end, split it into a frontend item and a backend item instead — that is more faithful to the four-hour rule anyway.`;
}

/**
 * The revision blocks — omitted entirely on a normal run. AEH-238.
 *
 * Rendered as one function rather than three so the ORDER is fixed and
 * readable: what else exists, then what this slice says today, then what the
 * person asked for. The instruction lands last because it is the thing the
 * council must weigh everything else against.
 *
 * Every block is absent when its input is, so a plain run's message is
 * byte-identical to what it was before steering existed. That matters more than
 * it looks: the prompts are admin-authored and versioned, and a run whose user
 * message silently gained empty sections would re-price differently for no
 * recorded reason.
 */
function buildRevisionBlocks(role: 'DEV' | 'QA' | 'PM' | 'BA', input: SpecialistInput): string {
  const { steer, ledgerContext } = input;
  const existing = input.existing ?? [];
  // An EMPTY STRING, and it is worth saying why, because a code review read
  // this as a bug and it is not one.
  //
  // The template interpolates on its own line — `${riskText}`, newline,
  // `${buildRevisionBlocks(...)}`, newline, `Respond with JSON only` — so the
  // newline AFTER the interpolation is already in the template. Returning ''
  // therefore yields `${riskText}\n\nRespond`, exactly what the template said
  // before steering existed. Returning '\n' would add a THIRD newline and be
  // the drift this comment is about.
  //
  // Pinned by `specialist-prompt.test.ts`, which asserts both halves: a blank
  // line before "Respond", and not two.
  if (!steer && existing.length === 0 && !ledgerContext) return '';

  const parts: string[] = [];

  if (ledgerContext) {
    parts.push(
      `The rest of this estimate, for context. You are NOT pricing any of it — it is here so you do not re-invent work that already exists somewhere else on the list:
${ledgerContext}`,
    );
  }

  if (existing.length > 0) {
    const rows = existing
      .map(
        (e) =>
          `- ${e.hours}h — ${e.description}${
            e.provenance === 'HUMAN' ? ' (a person set these hours by hand)' : ''
          }`,
      )
      .join('\n');
    parts.push(
      `What ${role} on this card says TODAY, which you are revising rather than replacing blind:
${rows}

Treat these as the current answer, not as a draft to ignore. Where a line is right, keep it — reproduce it with the same description and the same hours. Where it is wrong, change it, drop it, or split it. Hours a person set by hand are marked; you may still change them, but the instruction below has to actually call for it.`,
    );
  }

  if (steer) {
    parts.push(
      `The estimator's instruction for THIS card's ${role} work, in their words:

${steer}

This constrains this slice and nothing else. It is not a statement about how the rest of the project should be planned, and you are not pricing the rest of the project. If the instruction cannot be honoured — it contradicts the requirement, or it asks for work this role does not do — say so in "assumptions" and price what the requirement actually supports rather than inventing a number to match the request.`,
    );
  }

  return `\n${parts.join('\n\n')}\n`;
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
${buildRevisionBlocks(role, input)}
Respond with JSON only, matching exactly this shape:
{
  "lineItems": [
    {
      "description": "specific atomic unit of work",
      "hours": <number, 0.25-4.0, granularity 0.25>,
      "complexity": "base" | "elevated" | "high",
      "aiAssistApplied": true | false,
      "dependsOn": [<0-based indices of other items in THIS list this depends on>]${sideFieldSpec(role)}
    }
  ],
  "assumptions": ["..."],
  "coversRiskFlags": [<risk flags from the list above whose work these hours genuinely include — [] if none>]
}
HARD CAP: no item's "hours" may exceed 4.0. If a unit of work needs more, split it into multiple items.
If a category of work genuinely isn't needed for this requirement (e.g. no integration to test), OMIT it from "lineItems" entirely — do not include a 0-hour placeholder item.
Only list a flag in "coversRiskFlags" if your line items above actually include the work it implies. A flag you leave out is not lost — it is raised for a human to cost or dismiss deliberately, which is the right outcome when you have not costed it. Claiming a flag you did not cost is the one thing that makes real work disappear.${sideGuidance(role)}`;
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
        // Two attempts per step, so half the budget each. See CALL_TIMEOUTS.
        ...callTuning(ctx.levers?.[role], CALL_TIMEOUTS.retried),
      },
      LLMSpecialistSchema,
      `Specialist(${role})`,
      { kind: step, recorder: ctx.recorder },
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
    side?: 'frontend' | 'backend' | 'both';
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
    side?: 'frontend' | 'backend' | 'both';
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
        // Splitting an oversized item doesn't change which side it touches.
        ...(li.side ? { side: li.side } : {}),
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
      // Untagged (both false) when the model omitted `side`. Non-DEV roles are
      // forced untagged even if the model volunteers one: QA/PM/BA work has no
      // side, the UI never surfaces it there, and writeback only sums DEV — so
      // storing it would be invisible, meaningless state.
      touchesFrontend: role === 'DEV' && (item.side === 'frontend' || item.side === 'both'),
      touchesBackend: role === 'DEV' && (item.side === 'backend' || item.side === 'both'),
    };
  });

  // Only flags this specialist was actually SHOWN can be claimed. A hallucinated
  // claim is uniquely damaging here: it would mark a genuine risk as covered and
  // suppress the finding, which is the silent-omission failure the whole stage
  // exists to prevent. Filtering makes over-claiming impossible rather than
  // merely discouraged by the prompt.
  const offered = new Set(input.riskFindings.flatMap((f) => f.riskFlags));
  const claimed = llmResult.coversRiskFlags ?? [];
  const coversRiskFlags = [...new Set(claimed.filter((f) => offered.has(f)))];

  return SpecialistOutputSchema.parse({
    role,
    lineItems,
    assumptions: llmResult.assumptions,
    coversRiskFlags,
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
