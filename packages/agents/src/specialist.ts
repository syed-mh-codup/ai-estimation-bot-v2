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
  hours: z.number().min(0.25).max(FOUR_HOUR_CAP),
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
HARD CAP: no item's "hours" may exceed 4.0. If a unit of work needs more, split it into multiple items.`;
}

function snapToQuarterHour(hours: number): number {
  return Math.max(0.25, Math.min(FOUR_HOUR_CAP, Math.round(hours * 4) / 4));
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
  const lineItems: SpecialistLineItem[] = rawLineItems.map((li, i) => ({
    id: idOf(i),
    requirementId: input.requirement.id,
    menuCardId: input.menuCardId,
    description: li.description,
    hours: snapToQuarterHour(li.hours),
    complexity: li.complexity,
    aiAssistApplied: li.aiAssistApplied,
    dependsOn: li.dependsOn
      .filter((idx: number) => idx >= 0 && idx < llmResult.lineItems.length && idx !== i)
      .map(idOf),
    anchorPresetIds: input.archivistMatch?.presetId ? [input.archivistMatch.presetId] : [],
  }));

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
