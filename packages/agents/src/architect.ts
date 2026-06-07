import { z } from 'zod';
import type { IModelProvider } from '@repo/providers';
import type {
  ArchitectOutput,
  MenuItem,
  RoleLineItem,
  ArchivistMatch,
  Requirement,
  SpecialistOutput,
} from '@repo/shared';
import { ArchitectOutputSchema } from '@repo/shared';

export type ArchitectContext = {
  modelProvider: IModelProvider;
  modelString: string;
  instructions: string;
};

const LLMNarrativeSchema = z.object({
  narrative: z.array(z.string()),
  assumptions: z.array(z.string()),
});

// ─── WS16-01: Narrative array generation ─────────────────────────────────────

/**
 * Generate one narrative sentence per enabled menu item.
 * Sentences must reference real item titles/taxonomy.
 */
export async function generateNarrative(
  enabledItems: MenuItem[],
  requirements: Requirement[],
  ctx: ArchitectContext,
): Promise<string[]> {
  if (enabledItems.length === 0) return [];

  const itemList = enabledItems
    .map((m) => `- ${m.title} [${m.taxonomyKey}]`)
    .join('\n');

  const rawResponse = await ctx.modelProvider.chat({
    model: ctx.modelString,
    messages: [
      { role: 'system', content: ctx.instructions },
      {
        role: 'user',
        content: `Write one approach sentence per menu item for this project estimate.
Each sentence must reference the item's title and describe the development approach.

Menu items:
${itemList}

Project context: ${requirements.map((r) => r.text).join('; ')}

Respond with JSON: {"narrative": ["sentence for item 1", "sentence for item 2", ...]}`,
      },
    ],
    temperature: 0,
  });

  const jsonMatch = rawResponse.match(/\{[\s\S]*\}/);
  if (!jsonMatch?.[0]) return enabledItems.map((m) => `Implement ${m.title}.`);

  const parsed = LLMNarrativeSchema.safeParse(JSON.parse(jsonMatch[0]));
  if (!parsed.success) return enabledItems.map((m) => `Implement ${m.title}.`);

  return parsed.data.narrative;
}

// ─── WS16-02: Deterministic Assumption Set ───────────────────────────────────

/**
 * Deduplicate and collate specialist assumptions.
 * Returns a stable-ordered, deduplicated list.
 */
export function collateAssumptions(specialistOutputs: SpecialistOutput[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const output of specialistOutputs) {
    for (const assumption of output.assumptions) {
      const key = assumption.trim().toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        result.push(assumption.trim());
      }
    }
  }

  return result.sort(); // stable alphabetical ordering
}

// ─── WS16-03: Menu Card assembly with parent/child mapping ────────────────────

/**
 * Assemble menu items with parent/child relationships from preset requires/blocks.
 * A child item's parentItemId is set to the parent that requires/blocks it.
 */
export function assembleMenuCard(
  items: MenuItem[],
  archivistMatches: ArchivistMatch[],
): MenuItem[] {
  // Build a map from taxonomyKey to menu item
  const byTaxKey = new Map(items.map((m) => [m.taxonomyKey, m]));

  // For each match, if the preset has requires, link child items to parents
  // (In this implementation, requires/blocks are stored in preset metadata;
  //  we approximate parent-child by taxonomyKey prefix matching)
  const result = items.map((item) => {
    // Check if this item is required by another (parent)
    const parent = items.find(
      (other) =>
        other.id !== item.id &&
        item.taxonomyKey.startsWith(other.taxonomyKey + '.'),
    );

    if (parent && !item.parentItemId) {
      return { ...item, parentItemId: parent.id };
    }
    return item;
  });

  return result;
}

/**
 * Check if disabling a parent item affects its child items.
 * Returns child items that would be orphaned/blocked.
 */
export function getAffectedChildren(
  menuItems: MenuItem[],
  parentItemId: string,
): MenuItem[] {
  return menuItems.filter((m) => m.parentItemId === parentItemId);
}

// ─── Full Architect pipeline ───────────────────────────────────────────────────

export type ArchitectDeps = {
  ctx: ArchitectContext;
  requirements: Requirement[];
  archivistMatches: ArchivistMatch[];
  specialistOutputs: SpecialistOutput[];
  menuItems: MenuItem[];
};

/**
 * Run the Architect synthesis: narrative + assumptions + menu card assembly.
 */
export async function runArchitect(deps: ArchitectDeps): Promise<ArchitectOutput> {
  const { ctx, requirements, archivistMatches, specialistOutputs, menuItems } = deps;

  const enabledItems = menuItems.filter((m) => m.enabled);

  const [narrative, assumptions, assembled] = await Promise.all([
    generateNarrative(enabledItems, requirements, ctx),
    Promise.resolve(collateAssumptions(specialistOutputs)),
    Promise.resolve(assembleMenuCard(menuItems, archivistMatches)),
  ]);

  return ArchitectOutputSchema.parse({ narrative, assumptions, menuItems: assembled });
}
