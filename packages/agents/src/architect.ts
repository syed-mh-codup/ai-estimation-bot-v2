import { z } from 'zod';
import type { IModelProvider } from '@repo/providers';
import type {
  ArchitectOutput,
  MenuItem,
  RoleLineItem,
  ArchivistMatch,
  Requirement,
  SpecialistOutput,
  Category,
} from '@repo/shared';
import { ArchitectOutputSchema, FOUR_HOUR_CAP, MenuItemSchema, PhaseSchema } from '@repo/shared';
import { chatJSON } from './llm-json';

export type ArchitectContext = {
  modelProvider: IModelProvider;
  modelString: string;
  instructions: string;
};

/** MC-B2B-PRICING -> "B2B Pricing" (short all-caps segments are treated as acronyms). */
function titleFromMenuCardId(id: string): string {
  const body = id.replace(/^MC-/, '');
  return body
    .split('-')
    .map((seg) => (seg.length <= 3 && seg === seg.toUpperCase() ? seg : seg.charAt(0) + seg.slice(1).toLowerCase()))
    .join(' ');
}

// ─── Deterministic assembly: group specialist line items into menu cards ────

type CardDraft = {
  id: string;
  category: Category;
  requirementIds: string[];
  lineItems: RoleLineItem[];
};

/**
 * Build the menu-card spine from the Librarian's candidate_menu_card_id (each
 * specialist line item already carries the menuCardId it belongs to). This is
 * deterministic — the LLM only supplies phase/thinSlice/narrative judgment on
 * top, not the card membership itself.
 */
export function assembleCardsFromSpecialists(
  requirements: Requirement[],
  specialistOutputs: SpecialistOutput[],
): CardDraft[] {
  const requirementById = new Map(requirements.map((r) => [r.id, r]));
  const cards = new Map<string, CardDraft>();
  const reqIdSets = new Map<string, Set<string>>();

  for (const output of specialistOutputs) {
    for (const li of output.lineItems) {
      const req = requirementById.get(li.requirementId);
      let card = cards.get(li.menuCardId);
      if (!card) {
        card = { id: li.menuCardId, category: req?.category ?? 'Dev Environment', requirementIds: [], lineItems: [] };
        cards.set(li.menuCardId, card);
        reqIdSets.set(li.menuCardId, new Set());
      }
      reqIdSets.get(li.menuCardId)!.add(li.requirementId);
      card.lineItems.push({
        id: li.id,
        role: output.role,
        title: li.description,
        requirementId: li.requirementId,
        baseHours: li.hours,
        taxedHours: li.hours, // taxation is applied downstream over the assembled card
        complexity: li.complexity,
        aiAssistApplied: li.aiAssistApplied,
        dependsOn: li.dependsOn,
        anchorPresetIds: li.anchorPresetIds,
        touchesFrontend: li.touchesFrontend,
        touchesBackend: li.touchesBackend,
        edited: false,
      });
    }
  }

  for (const [id, card] of cards) {
    card.requirementIds = Array.from(reqIdSets.get(id)!);
  }

  return Array.from(cards.values());
}

/** Requirements some other requirement's sequencing.requires depends on — their card can't be safely removed. */
function computeRequiredRequirementIds(archivistMatches: ArchivistMatch[]): Set<string> {
  const required = new Set<string>();
  for (const m of archivistMatches) {
    for (const r of m.sequencing.requires) required.add(r);
  }
  return required;
}

/**
 * A card can span several requirements, each with its own Archivist match —
 * surface the strongest non-`none` match as the card's anchor preset (same
 * preset the Specialists already anchored their line items to via
 * `anchorPresetIds`). Undefined when nothing on the card matched anything.
 */
function bestMatchForCard(card: CardDraft, archivistMatches: ArchivistMatch[]): ArchivistMatch | undefined {
  let best: ArchivistMatch | undefined;
  for (const reqId of card.requirementIds) {
    const m = archivistMatches.find((am) => am.requirementId === reqId && am.coverage !== 'none' && am.presetId);
    if (m && (best === undefined || (m.score ?? 0) > (best.score ?? 0))) best = m;
  }
  return best;
}

/** Line items over the four-hour cap or cards with no line items — should be structurally impossible, checked defensively. */
function computeConsistencyFlags(cards: CardDraft[]): string[] {
  const flags: string[] = [];
  for (const card of cards) {
    if (card.lineItems.length === 0) {
      flags.push(`Menu card ${card.id} has no line items.`);
      continue;
    }
    for (const li of card.lineItems) {
      if (li.baseHours > FOUR_HOUR_CAP) {
        flags.push(`Line item ${li.id ?? '(unknown)'} on ${card.id} is ${li.baseHours}h, over the four-hour cap.`);
      }
    }
  }
  return flags;
}

// ─── WS16-02: Deterministic Assumption Set ───────────────────────────────────

/** Deduplicate and collate specialist assumptions into a stable, alphabetical list. */
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

  return result.sort();
}

// ─── LLM judgment: one cohesive narrative + per-card phase/thin-slice tag ────

const LLMCardMetaSchema = z.object({
  menuCardId: z.string(),
  phase: PhaseSchema,
  thinSlice: z.boolean().default(false),
});

const LLMArchitectSchema = z.object({
  narrative: z.array(z.string()).min(1),
  cards: z.array(LLMCardMetaSchema),
});

function buildUserMessage(cards: CardDraft[], requirements: Requirement[], openQuestions: string[]): string {
  const requirementById = new Map(requirements.map((r) => [r.id, r]));
  const cardSummaries = cards
    .map((c) => {
      const reqTexts = c.requirementIds.map((id) => requirementById.get(id)?.text).filter(Boolean).join('; ');
      const total = c.lineItems.reduce((s, li) => s + li.baseHours, 0);
      return `- ${c.id} [${c.category}]: ${reqTexts} (${total.toFixed(2)}h across ${c.lineItems.length} line items)`;
    })
    .join('\n');

  return `Synthesise the specialists' independent line items into a unified narrative.

Menu cards (id, category, requirements, hours):
${cardSummaries || '(no menu cards)'}

Open questions from Detective (pull through unchanged if any):
${openQuestions.length ? openQuestions.join('\n') : '(none)'}

Respond with JSON only, matching exactly this shape:
{
  "narrative": ["sentence 1", "...", "sentence 8-15"],
  "cards": [{"menuCardId": "...", "phase": "Foundation" | "Core" | "Enhancement", "thinSlice": true | false}]
}
Write ONE cohesive 8-15 sentence narrative: the architecture story, the integration boundaries
driving most of the effort and risk, the sequencing rationale, and the key assumptions and open
questions the estimate rests on. No internal IDs in the narrative — it is customer-facing.
Tag the card(s) forming the thin vertical slice (earliest demoable path) with thinSlice:true.
Assign every card exactly one phase.`;
}

// ─── Full Architect pipeline ───────────────────────────────────────────────────

export type ArchitectDeps = {
  ctx: ArchitectContext;
  requirements: Requirement[];
  archivistMatches: ArchivistMatch[];
  specialistOutputs: SpecialistOutput[];
  /** Pulled through from Detective unchanged (empty until Detective is wired). */
  openQuestions?: string[];
};

/**
 * Run the Architect synthesis: assemble menu cards from the specialists'
 * decomposed line items (deterministic), then ask the LLM for the narrative +
 * per-card phase/thin-slice judgment.
 */
export async function runArchitect(deps: ArchitectDeps): Promise<ArchitectOutput> {
  const { ctx, requirements, archivistMatches, specialistOutputs } = deps;
  const openQuestions = deps.openQuestions ?? [];

  const cards = assembleCardsFromSpecialists(requirements, specialistOutputs);
  const consistencyFlags = computeConsistencyFlags(cards);
  const requiredRequirementIds = computeRequiredRequirementIds(archivistMatches);

  const llmResult =
    cards.length === 0
      ? { narrative: [], cards: [] }
      : await chatJSON(
          ctx.modelProvider,
          {
            model: ctx.modelString,
            messages: [
              { role: 'system', content: ctx.instructions },
              { role: 'user', content: buildUserMessage(cards, requirements, openQuestions) },
            ],
            temperature: 0,
          },
          LLMArchitectSchema,
          'Architect',
        );

  const metaByCardId = new Map(llmResult.cards.map((c) => [c.menuCardId, c]));

  const menuItems: MenuItem[] = cards.map((card) => {
    const meta = metaByCardId.get(card.id);
    const notSafelyRemovable = card.requirementIds.some((id) => requiredRequirementIds.has(id));
    const bestMatch = bestMatchForCard(card, archivistMatches);
    // Parsed, not asserted: the literal is input-shaped, and `MenuItem` is the
    // OUTPUT type, where every `.default()` field is required. Annotating an
    // input literal with the output type is the drift that left 47 errors
    // invisible until CI was repaired (4271478) — and it means real Architect
    // cards get `injected: false` from the schema rather than by hand. AEH-227.
    return MenuItemSchema.parse({
      id: card.id,
      taxonomyKey: card.id,
      category: card.category,
      phase: meta?.phase,
      requirementIds: card.requirementIds,
      sourcePresetId: bestMatch?.presetId,
      matchScore: bestMatch?.score,
      title: titleFromMenuCardId(card.id),
      enabled: true,
      toggleable: !notSafelyRemovable,
      notSafelyRemovable,
      thinSlice: meta?.thinSlice ?? false,
      lineItems: card.lineItems,
    });
  });

  return ArchitectOutputSchema.parse({
    narrative: llmResult.narrative,
    assumptions: collateAssumptions(specialistOutputs),
    openQuestions,
    consistencyFlags,
    menuItems,
  });
}
