/**
 * The one mapping between a persisted card and the domain shape (AEH-227).
 *
 * Before this, three read paths and one write path each hand-wrote the same
 * translation, and the three read paths silently disagreed with the write path:
 * `run-estimate` packed seven fields into `MenuItem.meta` / `RoleLineItem.meta`,
 * and every reader hardcoded `requirementIds: []`, `toggleable: true`,
 * `notSafelyRemovable: false`, `thinSlice: false`, `aiAssistApplied: false`,
 * `dependsOn: []`, `anchorPresetIds: []` instead of reading them back. Nothing
 * in the repo read either `meta` column at all — `@repo/audit` asserts this as
 * AEH-228's headline finding — so the Architect's `notSafelyRemovable` and
 * `thinSlice` were computed, stored, and thrown away on every read.
 *
 * Two rules make that unrepeatable:
 *
 *   1. Columns are authoritative; `meta` supplies only what has no column. The
 *      readers spread `meta` FIRST so a column always wins a name collision.
 *   2. Every field of the domain shape must be claimed by either the column set
 *      or the meta key list, enforced at compile time below. Add a field to
 *      `MenuItemSchema` or `RoleLineItemSchema` and this file stops compiling
 *      until you say where it is persisted.
 *
 * Rule 2 is the point. A `.default()` on a new zod field would otherwise let
 * `parse` invent a value on read and let the writer drop it, which is exactly
 * how the seven fields above rotted -- and exactly what made `4271478`'s 47
 * typecheck errors invisible until CI was repaired.
 */
import {
  MenuItemSchema,
  RoleLineItemSchema,
  type MenuItem,
  type RoleLineItem,
} from '@repo/shared';
import type {
  MenuItem as MenuItemRow,
  RoleLineItem as RoleLineItemRow,
  Prisma,
} from './generated/client/index.js';

/** A card row with its line items — what every read path selects. */
export type MenuItemRowWithLineItems = MenuItemRow & { lineItems: RoleLineItemRow[] };

// ─── Compile-time exhaustiveness ─────────────────────────────────────────────

/** Domain fields carried by a real `MenuItem` column. */
type MenuItemColumnKey =
  | 'id'
  | 'taxonomyKey'
  | 'category'
  | 'phase'
  | 'sourcePresetId'
  | 'matchScore'
  | 'title'
  | 'enabled'
  | 'injected'
  | 'lineItems';

/** Domain fields with no column, carried in `MenuItem.meta`. */
type MenuItemMetaKey = 'requirementIds' | 'toggleable' | 'notSafelyRemovable' | 'thinSlice';

/** Domain fields carried by a real `RoleLineItem` column. */
type LineItemColumnKey =
  | 'role'
  | 'title'
  | 'baseHours'
  | 'taxedHours'
  | 'notes'
  | 'edited'
  | 'touchesFrontend'
  | 'touchesBackend';

/**
 * Domain fields with no column, carried in `RoleLineItem.meta`.
 *
 * `id` is here rather than in the column set on purpose. The row's `id` column
 * is a cuid; the domain `id` is the Specialist's `<ROLE>-<REQ###>-<NN>`, which
 * `dependsOn` and `anchorPresetIds` reference by name. Reading the cuid into
 * `id` would leave `dependsOn` pointing at ids matching nothing in the set, so
 * the semantic id is what round-trips. Nothing in production reads a line
 * item's cuid off a domain object — the editor reads it off the row directly
 * through its own Prisma-derived DTO.
 */
type LineItemMetaKey =
  | 'id'
  | 'requirementId'
  | 'complexity'
  | 'aiAssistApplied'
  | 'dependsOn'
  | 'anchorPresetIds';

/** Fails to compile unless `T` is `never`. */
type AssertNever<T extends never> = T;

/**
 * If either alias errors, a field was added to a schema without deciding how it
 * persists. Put its name in that shape's column key union (and add the column)
 * or in its meta key union — do not delete the assertion.
 *
 * Never referenced by design: their only job is to fail compilation, which is
 * exactly what `no-unused-vars` objects to. Hence the scoped disable rather
 * than a fake use.
 */
/* eslint-disable @typescript-eslint/no-unused-vars */
type _MenuItemFieldsAllClaimed = AssertNever<
  Exclude<keyof MenuItem, MenuItemColumnKey | MenuItemMetaKey>
>;
type _LineItemFieldsAllClaimed = AssertNever<
  Exclude<keyof RoleLineItem, LineItemColumnKey | LineItemMetaKey>
>;
/* eslint-enable @typescript-eslint/no-unused-vars */

// ─── Read: row -> domain ─────────────────────────────────────────────────────

/**
 * `run-estimate` writes `?? null` into `meta` where the schema expects an
 * absent key (`id`, `requirementId`, `complexity` are all `.optional()`, which
 * rejects an explicit null). Dropping nulls turns those back into absences.
 */
function metaObject(meta: unknown): Record<string, unknown> {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta as Record<string, unknown>)) {
    if (v !== null) out[k] = v;
  }
  return out;
}

/** One persisted line item as the pipeline's `RoleLineItem`. */
export function toLineItem(row: RoleLineItemRow): RoleLineItem {
  return RoleLineItemSchema.parse({
    // meta first: a column always wins a name collision (see rule 1).
    ...metaObject(row.meta),
    role: row.role,
    title: row.title ?? undefined,
    baseHours: row.baseHours,
    taxedHours: row.taxedHours,
    notes: row.notes ?? undefined,
    edited: row.edited,
    touchesFrontend: row.touchesFrontend,
    touchesBackend: row.touchesBackend,
  });
}

/** One persisted card as the pipeline's `MenuItem`. */
export function toMenuItem(row: MenuItemRowWithLineItems): MenuItem {
  return MenuItemSchema.parse({
    ...metaObject(row.meta),
    // The row's cuid, not the Architect's MC-<DOMAIN>-<SLUG>: `run-estimate`
    // never persists the latter. Promotion keys `sourceMenuItemId` on this.
    id: row.id,
    taxonomyKey: row.taxonomyKey,
    category: row.category ?? undefined,
    phase: row.phase ?? undefined,
    sourcePresetId: row.sourcePresetId ?? undefined,
    matchScore: row.matchScore ?? undefined,
    title: row.title,
    enabled: row.enabled,
    injected: row.injected,
    lineItems: row.lineItems.map(toLineItem),
  });
}

// ─── Write: domain -> row ────────────────────────────────────────────────────

/**
 * A meta blob: every key of the list, required, with `null` standing in for
 * absent (Prisma's Json columns take null, not undefined). `-?` strips
 * optionality, so omitting a key is a compile error.
 *
 * The blobs are written INLINE at the write sites below, not built here by a
 * helper or a loop. That is deliberate and load-bearing: `@repo/audit`
 * discovers which keys a Json column actually persists by reading the write
 * site's object literal (`discoverJsonKeys` requires an object-literal
 * initializer and fingerprints the sibling property names to attribute the
 * model). A helper call or a loop makes the column look like it stores nothing,
 * which silently blinds AEH-228's gate 1 — verified: it reported
 * `MenuItem.meta` keys as `undefined`. `satisfies` supplies the exhaustiveness
 * a loop would have given, without hiding the keys.
 */
type MetaBlob<T, K extends keyof T> = { [P in K]-?: T[P] | null };

/**
 * Prisma's own create input types `meta` as `InputJsonValue`, which accepts any
 * object and therefore checks nothing. Narrowing it to `MetaBlob` in the return
 * type is what forces the inline literal to carry every meta key — a bare
 * literal the audit can still read, with the exhaustiveness a `satisfies`
 * clause would have provided. (`satisfies` cannot be used: it wraps the node in
 * a SatisfiesExpression, and `discoverJsonKeys` tests
 * `ts.isObjectLiteralExpression` on the initializer — verified, it goes blind.)
 */
type CreateDataWithMeta<TCreate, TDomain, K extends keyof TDomain> = Omit<TCreate, 'meta'> & {
  meta: MetaBlob<TDomain, K>;
};

/** One `RoleLineItem` as nested-create data under its card. */
export function toLineItemCreateData(
  li: RoleLineItem,
): CreateDataWithMeta<
  Prisma.RoleLineItemCreateWithoutMenuItemInput,
  RoleLineItem,
  LineItemMetaKey
> {
  return {
    role: li.role,
    title: li.title ?? null,
    baseHours: li.baseHours,
    taxedHours: li.taxedHours,
    notes: li.notes ?? null,
    edited: li.edited,
    touchesFrontend: li.touchesFrontend,
    touchesBackend: li.touchesBackend,
    meta: {
      id: li.id ?? null,
      requirementId: li.requirementId ?? null,
      complexity: li.complexity ?? null,
      aiAssistApplied: li.aiAssistApplied,
      dependsOn: li.dependsOn,
      anchorPresetIds: li.anchorPresetIds,
    },
  };
}

/** One `MenuItem` as create data, line items nested. */
export function toMenuItemCreateData(
  item: MenuItem,
  estimateId: string,
): CreateDataWithMeta<Prisma.MenuItemUncheckedCreateInput, MenuItem, MenuItemMetaKey> {
  return {
    estimateId,
    taxonomyKey: item.taxonomyKey,
    category: item.category ?? null,
    phase: item.phase ?? null,
    title: item.title,
    enabled: item.enabled,
    injected: item.injected,
    sourcePresetId: item.sourcePresetId ?? null,
    matchScore: item.matchScore ?? null,
    meta: {
      requirementIds: item.requirementIds,
      toggleable: item.toggleable,
      notSafelyRemovable: item.notSafelyRemovable,
      thinSlice: item.thinSlice,
    },
    lineItems: { create: item.lineItems.map(toLineItemCreateData) },
  };
}
