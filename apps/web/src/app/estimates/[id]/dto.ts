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
import { taxedHoursFor } from '@repo/shared';
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
  'id' | 'role' | 'title' | 'baseHours' | 'taxedHours' | 'provenance' | 'touchesFrontend' | 'touchesBackend'
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
  | 'overhead'
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
/**
 * The result of a mutation a person is allowed to be REFUSED, as the editor
 * hears it. Shaped like `ExportOutcome` next door, for the same reason.
 *
 * A returned refusal rather than a thrown one, and that distinction is the
 * whole point of this type. React's Flight client discards the message of any
 * error thrown inside a `'use server'` action in a production build and hands
 * the caller "An error occurred in the Server Components render…" instead — so
 * a refusal that travels as a throw is legible in `next dev` and nowhere a
 * reviewer actually works. Refusals are a normal outcome of asking, not a
 * fault, and they carry text somebody is meant to act on; they are returned.
 *
 * A genuine fault — the row is gone, nobody is signed in — still throws. There
 * is nothing for the reader to do about those and no message worth protecting.
 */
export type MutationOutcome = { kind: 'ok' } | { kind: 'refused'; error: string };

export const OK: MutationOutcome = { kind: 'ok' };

export type SectionDTO = Pick<EstimateSectionRow, 'id' | 'title' | 'order'>;

/**
 * Re-tax one role's line items at a new buffer, across every card.
 *
 * This is the client's optimistic half of `setEstimateTaxPct`, and it lives
 * here as a pure function for two reasons. It has to agree with the server
 * exactly — same `taxedHoursFor`, same role-only scope, same exclusion of
 * overhead cards — and a prediction that disagrees with what gets stored is a
 * total that lies for one round trip and then jumps. Inline in the provider it
 * was reachable only by driving a browser; out here it is directly assertable.
 *
 * Overhead cards are skipped, not re-taxed. Their hours are already a
 * percentage OF taxed hours (injectProcessOverhead), so applying a buffer to
 * one compounds a percentage on a percentage. AEH-335.
 */
export function retaxRole(items: ItemDTO[], role: string, pct: number): ItemDTO[] {
  return items.map((it) =>
    it.overhead
      ? it
      : {
          ...it,
          lineItems: it.lineItems.map((li) =>
            li.role === role ? { ...li, taxedHours: taxedHoursFor(li.baseHours, pct) } : li,
          ),
        },
  );
}
