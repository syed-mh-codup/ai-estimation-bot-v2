import { z } from 'zod';
import type { IModelProvider } from '@repo/providers';
import type { LibrarianOutput, Requirement } from '@repo/shared';
import {
  LibrarianOutputSchema,
  CategorySchema,
  ReqTypeSchema,
  PlatformSchema,
  ProjectSizeSchema,
  DataVolumeLevelSchema,
  CATEGORY_EXAMPLES,
  REQ_TYPE_EXAMPLES,
  PLATFORM_EXAMPLES,
} from '@repo/shared';
import { chatJSON } from './llm-json';

export type LibrarianContext = {
  modelProvider: IModelProvider;
  modelString: string;
  instructions: string;
};

export type TaxonomyEntry = {
  key: string;
  label: string;
  keywords: string[];
};

/**
 * What the LLM actually emits: everything the METHOD section of the live
 * LIBRARIAN prompt asks for, minus `id` — requirement IDs are assigned
 * deterministically by code (REQ-001, REQ-002, ...) rather than trusted to
 * LLM numbering, since the SUPERVISOR prompt requires reproducibility.
 */
const LLMRequirementSchema = z.object({
  text: z.string(),
  category: CategorySchema,
  reqType: ReqTypeSchema,
  platforms: z.array(PlatformSchema).default([]),
  projectSize: ProjectSizeSchema,
  dataVolume: DataVolumeLevelSchema,
  integrationCount: z.number().min(0).max(10),
  candidateMenuCardId: z.string(),
  taxonomyKey: z.string().nullable(),
  sourceRef: z.string(),
  ambiguities: z.array(z.string()).default([]),
  blocksEstimation: z.boolean().default(false),
});

const LLMResponseSchema = z.object({
  requirements: z.array(LLMRequirementSchema),
});

function buildUserMessage(sowText: string, taxonomy: TaxonomyEntry[]): string {
  const taxList = taxonomy
    .map((t) => `- ${t.key}: ${t.label} [keywords: ${t.keywords.join(', ')}]`)
    .join('\n');

  return `Decompose this SOW into requirements per the METHOD in your system instructions.

## Taxonomy (for the taxonomyKey field — pick the best-fitting key, or null if nothing fits)
${taxList || '(no taxonomy loaded yet)'}

## SOW
${sowText}

Respond with JSON only, matching exactly this shape:
{
  "requirements": [
    {
      "text": "...",
      "category": "<specific, Title Case category genuinely fitting THIS requirement's domain>",
      "reqType": "<specific, Title Case type of work genuinely fitting THIS requirement>",
      "platforms": ["<real platforms/technologies/frameworks THIS requirement actually touches>"],
      "projectSize": "SMB" | "Mid-market" | "Enterprise",
      "dataVolume": "None" | "Low" | "High",
      "integrationCount": <integer 0-10>,
      "candidateMenuCardId": "MC-<DOMAIN>-<SLUG>",
      "taxonomyKey": "key.from.taxonomy" | null,
      "sourceRef": "SOW section/paraphrase this traces back to",
      "ambiguities": ["..."],
      "blocksEstimation": true | false
    }
  ]
}

category/reqType/platforms are OPEN fields, not a fixed list — this system estimates a wide
variety of software work, not just one vertical. Examples from past ecommerce/B2B engagements
(use these ONLY when the requirement is genuinely that kind of work — never force-fit them):
  category examples: ${CATEGORY_EXAMPLES.join(' | ')}
  reqType examples:  ${REQ_TYPE_EXAMPLES.join(' | ')}
  platform examples: ${PLATFORM_EXAMPLES.join(' | ')}
For a requirement outside that vertical, invent equally specific, real, Title Case labels for
its actual domain (e.g. an AI training platform might use category "Conversational AI",
reqType "Simulation Design", platform "LLM Provider" — invent what genuinely fits). Never use
vague placeholders like "Other" or "General" — be as specific as the ecommerce examples are.
Stay internally consistent: reuse the same label across requirements that are genuinely the
same kind of work.

One requirement = one buildable capability. Err toward more, smaller requirements.`;
}

/**
 * Run the Librarian agent: decompose SOW into requirements against the
 * controlled vocabulary + menu-card grouping the live prompt spec demands.
 */
export async function runLibrarian(
  sowText: string,
  taxonomy: TaxonomyEntry[],
  ctx: LibrarianContext,
): Promise<LibrarianOutput> {
  const parsed = await chatJSON(
    ctx.modelProvider,
    {
      model: ctx.modelString,
      messages: [
        { role: 'system', content: ctx.instructions },
        { role: 'user', content: buildUserMessage(sowText, taxonomy) },
      ],
      temperature: 0,
    },
    LLMResponseSchema,
    'Librarian',
  );

  const requirements: Requirement[] = parsed.requirements.map((r, i) => ({
    id: `REQ-${String(i + 1).padStart(3, '0')}`,
    text: r.text,
    category: r.category,
    reqType: r.reqType,
    platforms: r.platforms ?? [],
    projectSize: r.projectSize,
    dataVolume: r.dataVolume,
    integrationCount: r.integrationCount,
    candidateMenuCardId: r.candidateMenuCardId,
    taxonomyKey: r.taxonomyKey,
    sourceRef: r.sourceRef,
    ambiguities: r.ambiguities ?? [],
    blocksEstimation: r.blocksEstimation ?? false,
  }));

  return LibrarianOutputSchema.parse({ requirements });
}

/**
 * RAG retriever: load taxonomy entries from the DB filtered by query similarity.
 * Uses pre-computed embeddings or falls back to keyword match.
 */
export async function loadTaxonomy(db: {
  taxonomyNodeVersion: {
    findMany: (args: { where: { active: boolean }; select: { nodeKey: boolean; label: boolean; keywords: boolean } }) => Promise<Array<{ nodeKey: string; label: string; keywords: string[] }>>;
  };
}): Promise<TaxonomyEntry[]> {
  const nodes = await db.taxonomyNodeVersion.findMany({
    where: { active: true },
    select: { nodeKey: true, label: true, keywords: true },
  });
  return nodes.map((n) => ({ key: n.nodeKey, label: n.label, keywords: n.keywords }));
}
