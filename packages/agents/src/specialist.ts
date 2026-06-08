import { z } from 'zod';
import type { IModelProvider } from '@repo/providers';
import type {
  SpecialistOutput,
  SpecialistInput,
  RoleLineItem,
  MenuItemStub,
  ArchivistMatch,
  DetectiveFinding,
} from '@repo/shared';
import { SpecialistOutputSchema } from '@repo/shared';

export type SpecialistContext = {
  modelProvider: IModelProvider;
  modelString: string;
  instructions: Record<'DEV' | 'QA' | 'PM' | 'BA', string>;
};

const LLMSpecialistSchema = z.object({
  baseHours: z.number().min(0),
  rationale: z.string(),
  assumptions: z.array(z.string()),
});

/**
 * Compute the multiplier to apply to base hours based on complexity and risk.
 */
function computeMultiplier(
  complexityScore: number,
  risk: 'LOW' | 'MEDIUM' | 'HIGH',
  perItemMultiplier = 1.0,
): number {
  const complexityFactor = 1.0 + (complexityScore - 1) * 0.1; // 1.0 at score=1, 1.4 at score=5
  const riskFactor = risk === 'HIGH' ? 1.3 : risk === 'MEDIUM' ? 1.15 : 1.0;
  return perItemMultiplier * complexityFactor * riskFactor;
}

/**
 * Call LLM to estimate hours for a specific role.
 */
async function estimateRoleHours(
  role: 'DEV' | 'QA' | 'PM' | 'BA',
  input: SpecialistInput,
  ctx: SpecialistContext,
  anchorHours: number,
): Promise<z.infer<typeof LLMSpecialistSchema>> {
  const { menuItem, archivistMatch, detectiveFindings, complexityScore } = input;

  const riskFlags = [...new Set(detectiveFindings.flatMap((f) => f.riskFlags))];
  const matchSummary = archivistMatch
    ? `Preset match: BE=${archivistMatch.beHours}h, FE=${archivistMatch.feHours}h, risk=${archivistMatch.risk}, aiAssist=${archivistMatch.aiAssist}`
    : 'No preset match found';

  const rawResponse = await ctx.modelProvider.chat({
    model: ctx.modelString,
    messages: [
      { role: 'system', content: ctx.instructions[role] },
      {
        role: 'user',
        content: `Estimate hours for role: ${role}

Menu item: ${menuItem.title} [${menuItem.taxonomyKey}]
Complexity score: ${complexityScore}/5
${matchSummary}
Risk flags: ${riskFlags.length > 0 ? riskFlags.join(', ') : 'none'}
Anchor hours (adjusted): ${anchorHours}h

Provide your estimate as JSON:
{"baseHours": <number>, "rationale": "<brief reason>", "assumptions": ["<assumption>", ...]}`,
      },
    ],
    temperature: 0,
  });

  const jsonMatch = rawResponse.match(/\{[\s\S]*\}/);
  if (!jsonMatch?.[0]) {
    // Fallback: return anchor hours
    return { baseHours: anchorHours, rationale: 'LLM fallback', assumptions: [] };
  }

  const parsed = LLMSpecialistSchema.safeParse(JSON.parse(jsonMatch[0]));
  if (!parsed.success) {
    return { baseHours: anchorHours, rationale: 'Parse fallback', assumptions: [] };
  }
  return parsed.data;
}

/**
 * Compute anchor hours for a role from the archivist match + complexity multiplier.
 */
function computeAnchorHours(
  role: 'DEV' | 'QA' | 'PM' | 'BA',
  match: ArchivistMatch | undefined,
  complexityScore: number,
): number {
  const risk = match?.risk ?? 'LOW';
  const multiplier = computeMultiplier(complexityScore, risk);

  if (role === 'DEV') {
    const baseHours = (match?.beHours ?? 20) + (match?.feHours ?? 10);
    return Math.round(baseHours * multiplier);
  }
  if (role === 'QA') {
    // QA is derived from Dev scope: ~30-40% of Dev hours
    const devHours = (match?.beHours ?? 20) + (match?.feHours ?? 10);
    return Math.round(devHours * 0.35 * multiplier);
  }
  if (role === 'PM') {
    // PM: ~15% of Dev hours for coordination
    const devHours = (match?.beHours ?? 20) + (match?.feHours ?? 10);
    return Math.round(devHours * 0.15 * multiplier);
  }
  // BA: ~20% of Dev hours for analysis/acceptance criteria
  const devHours = (match?.beHours ?? 20) + (match?.feHours ?? 10);
  return Math.round(devHours * 0.20 * multiplier);
}

/**
 * Run a single specialist (DEV, QA, PM, or BA) for a menu item.
 */
export async function runSpecialist(
  role: 'DEV' | 'QA' | 'PM' | 'BA',
  input: SpecialistInput,
  ctx: SpecialistContext,
): Promise<SpecialistOutput> {
  const anchorHours = computeAnchorHours(role, input.archivistMatch, input.complexityScore);
  const llmResult = await estimateRoleHours(role, input, ctx, anchorHours);

  return SpecialistOutputSchema.parse({
    role,
    baseHours: llmResult.baseHours,
    rationale: llmResult.rationale,
    assumptions: llmResult.assumptions,
  });
}

/**
 * Run all 4 specialists (DEV, QA, PM, BA) independently for a menu item.
 * Returns one SpecialistOutput per role.
 */
export async function runSpecialistCouncil(
  input: SpecialistInput,
  ctx: SpecialistContext,
): Promise<SpecialistOutput[]> {
  const roles: Array<'DEV' | 'QA' | 'PM' | 'BA'> = ['DEV', 'QA', 'PM', 'BA'];
  return Promise.all(roles.map((role) => runSpecialist(role, input, ctx)));
}

/**
 * Default instruction templates for each specialist role.
 */
export const DEFAULT_SPECIALIST_INSTRUCTIONS: Record<'DEV' | 'QA' | 'PM' | 'BA', string> = {
  DEV: 'You are a Senior Developer specialist. Anchor on the preset BE+FE hours, adjust for complexity and Detective risk flags, apply AI-assist discount where flagged.',
  QA: 'You are a QA specialist. Derive test-design and execution effort from Dev scope and detected risk flags. Stay independent of Dev hours.',
  PM: 'You are a Project Manager specialist. Estimate coordination, planning, and stakeholder communication effort per menu item.',
  BA: 'You are a Business Analyst specialist. Estimate requirements analysis, acceptance criteria writing, and stakeholder workshops effort.',
};

export type { SpecialistOutput };
