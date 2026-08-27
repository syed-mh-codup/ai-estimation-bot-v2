/**
 * The editor's data-transfer shapes, and the two pure mappers that build them.
 *
 * These live here rather than beside the server actions that use them for a
 * hard reason: `actions.ts` carries `'use server'`, and in such a module EVERY
 * export must be an async function. A synchronous `cardFlags` there compiles
 * under `tsc` and passes unit tests — vitest imports the module without the
 * directive's semantics — and then fails the Next.js build, taking down every
 * route that imports anything from the file. Only `next build` catches it.
 */
import type {
  MenuItem as MenuItemRow,
  RoleLineItem as RoleLineItemRow,
  EstimateSection as EstimateSectionRow,
} from '@repo/db';

/**
 * The editor's DTOs, derived from the Prisma row types rather than declared
 * fresh (AEH-227). Every field either of them carries IS a column — the editor
 * edits columns, so the row type is its honest contract, and adding a column
 * the editor should show now propagates here instead of needing a hand edit.
 * That is how `touchesFrontend`/`touchesBackend` reached the editor in the
 * first place.
 *
 * Deliberately NOT derived from `@repo/shared`'s `RoleLineItem`/`MenuItem`:
 * those carry envelope fields the editor never renders, and `sectionId`/`order`
 * are columns that the pipeline shapes do not have at all — so a `Pick` over
 * them would need a hand-written intersection, re-introducing exactly the
 * field list this removes.
 */
export type LineItemDTO = Pick<
  RoleLineItemRow,
  'id' | 'role' | 'title' | 'baseHours' | 'taxedHours' | 'edited' | 'touchesFrontend' | 'touchesBackend'
> & { envelope: LineEnvelope };

/**
 * What the Specialist council recorded about a line item beyond its hours.
 *
 * Nested for the same reason `CardFlags` is — see the note there. Flattening
 * `complexity` onto `LineItemDTO` would be worse than a missed clear: every
 * existing read of `baseHours`/`taxedHours`/`role` on this DTO would
 * re-attribute to the `RoleLineItem.meta` pseudo-model, orphaning three columns
 * that are consumed today.
 */
export type LineEnvelope = {
  /** The tier the Specialist priced at: base | elevated | high. */
  complexity: string | null;
  /** The Specialist discounted these hours for AI-assisted delivery. */
  aiAssistApplied: boolean;
  /** Historical presets the Specialist anchored the number to. */
  anchorPresetIds: string[];
};

export const EMPTY_ENVELOPE: LineEnvelope = {
  complexity: null,
  aiAssistApplied: false,
  anchorPresetIds: [],
};

/**
 * Read the Specialist's envelope off a persisted line item.
 *
 * Permissive like `cardFlags`: a hand-added row has no council judgment behind
 * it, and saying so plainly beats inventing a tier for it.
 */
export function lineEnvelope(meta: RoleLineItemRow['meta']): LineEnvelope {
  const m = (meta ?? {}) as Partial<LineEnvelope>;
  return {
    complexity: typeof m.complexity === 'string' ? m.complexity : null,
    aiAssistApplied: m.aiAssistApplied === true,
    anchorPresetIds: Array.isArray(m.anchorPresetIds) ? m.anchorPresetIds : [],
  };
}
export type ItemDTO = Pick<
  MenuItemRow,
  | 'id'
  | 'title'
  | 'enabled'
  | 'taxonomyKey'
  | 'sectionId'
  | 'order'
  | 'injected'
  | 'category'
  | 'phase'
  | 'sourcePresetId'
  | 'matchScore'
> & { flags: CardFlags; lineItems: LineItemDTO[] };

/**
 * The Architect's per-card judgment, which lives in `MenuItem.meta` rather than
 * in columns of its own.
 *
 * Kept as a NESTED object rather than flattened onto `ItemDTO`, and that is not
 * a style choice. The field audit attributes a property read by structural
 * overlap against each model's field set, and it builds a pseudo-model for each
 * Json column whose fields are `model columns UNION discovered keys` — a strict
 * superset of the model. Mixing `toggleable`/`thinSlice` into the same
 * top-level shape as `category`/`phase` would make that pseudo-model outscore
 * `MenuItem` on every read of this DTO, silently re-attributing the column
 * reads below and orphaning columns that are consumed today. Nested, the two
 * shapes are scored separately and both resolve correctly. See AEH-253.
 */
export type CardFlags = {
  /** False when the Architect says this card is not the estimator's to switch off. */
  toggleable: boolean;
  /** Another requirement declares a Requires-edge onto this card's work. */
  notSafelyRemovable: boolean;
  /** Part of the earliest demoable path through the estimate. */
  thinSlice: boolean;
};

/**
 * Read the flags out of a persisted card, permissively.
 *
 * Absent meta means an ordinary card, never a locked one: rows predating the
 * envelope, and the e2e fixtures, are created with no `meta` at all, and the
 * safe reading of "the Architect never said" is "the estimator decides".
 */
export function cardFlags(meta: MenuItemRow['meta']): CardFlags {
  const m = (meta ?? {}) as Partial<CardFlags>;
  return {
    toggleable: m.toggleable !== false,
    notSafelyRemovable: m.notSafelyRemovable === true,
    thinSlice: m.thinSlice === true,
  };
}
export type SectionDTO = Pick<EstimateSectionRow, 'id' | 'title' | 'order'>;
