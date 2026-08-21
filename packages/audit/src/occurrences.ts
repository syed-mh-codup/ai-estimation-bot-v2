import ts from 'typescript';
import type { Family } from './prisma-schema.js';
import { repoRelative, type SourceSet } from './source-set.js';

/**
 * Occurrence index and classifiers for the orphan-field audit.
 *
 * The audit does not count references — counting is a false-green machine here.
 * Measured against `apps/web/src`: `TaxonomyNodeVersion.active` has 125 hits in a
 * model the web app never queries, `TaxonomyNode.key` has 54 (React `key=`
 * props), `MenuItem.meta` has 4 (all an unrelated `CollapsibleSection` prop), and
 * `id` has 394. A plain reference check catches 2 of AEH-228's 8 recorded
 * orphans. So every occurrence is classified by HOW it uses the field, and only
 * some verdicts count as consumption.
 */

export type Verdict =
  /** A genuine consumer. */
  | 'read'
  /** Queried BY (where/orderBy) or named in raw SQL. Also a consumer. */
  | 'query-read'
  /** An object-literal property name. Never a read. */
  | 'write'
  /** A read whose only destination is a same-named property: a copy, not a use. */
  | 'carry-forward'
  /** Read off a local `const X = {…}` map, not off a DB row. */
  | 'const-object'
  /** Read only to seed a form control that writes the same field back. */
  | 'form-echo'
  /** A `select`/`include` key: fetching is not consuming. */
  | 'projection'
  /** A type/interface/zod member declaration. */
  | 'type-decl'
  | 'other';

/** Verdicts that satisfy "this field has a consumer". */
const CONSUMING: ReadonlySet<Verdict> = new Set<Verdict>(['read', 'query-read']);

export function isConsuming(v: Verdict): boolean {
  return CONSUMING.has(v);
}

export interface Occurrence {
  name: string;
  file: string;
  line: number;
  verdict: Verdict;
  /** Target ids this occurrence could belong to, e.g. ['RoleLineItem']. */
  attributedTo: string[];
  /** False when the receiver type had no properties — attribution failed open. */
  resolved: boolean;
  snippet: string;
}

export interface AttributionTarget {
  /** 'PresetVersion' or 'MenuItem.meta' for a Json pseudo-model. */
  id: string;
  fieldNames: Set<string>;
  families: Map<string, Family>;
}

export interface OccurrenceIndex {
  byName: Map<string, Occurrence[]>;
  stats: {
    filesAnalysed: number;
    candidateReads: number;
    resolvedReads: number;
    attributionResolvedRatio: number;
  };
}

/** Prisma argument keys where naming a column means querying BY it. */
const QUERY_KEYS = new Set(['where', 'orderBy', 'having', 'distinct', 'by', 'cursor']);
/** Prisma argument keys where naming a column only fetches it. */
const PROJECTION_KEYS = new Set(['select', 'include', 'omit', '_max', '_min', '_sum', '_avg', '_count']);

const RAW_SQL_CALLEE = /\$(queryRaw|queryRawUnsafe|executeRaw|executeRawUnsafe)$/;

function lineOf(sf: ts.SourceFile, node: ts.Node): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
}

function snippetOf(sf: ts.SourceFile, node: ts.Node): string {
  const start = sf.getLineStarts()[lineOf(sf, node) - 1] ?? node.getStart(sf);
  const text = sf.text.slice(start, sf.text.indexOf('\n', start) === -1 ? undefined : sf.text.indexOf('\n', start));
  return text.trim().slice(0, 110);
}

function propertyNameText(name: ts.PropertyName | ts.BindingName): string | null {
  if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name)) return name.text;
  if (ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return null;
}

/**
 * R3 — carry-forward. Walk up from a candidate read; if it lands in a property
 * assignment of the SAME name before crossing an object-literal boundary, the
 * read's only destination is a same-named field, i.e. a copy.
 *
 * Deliberately wider than "identity copy" (`k: x.k`). These are all copies and a
 * narrower rule leaks every one of them:
 *   notes: carry?.notes ?? ''                              (writeback.ts)
 *   notes: (formData.get('notes') as string) ?? active.notes  (admin preset page)
 *   notes: tweak.newNotes ?? li.notes                      (refinement.ts)
 */
function isCarryForward(node: ts.Node, field: string): boolean {
  let cur: ts.Node | undefined = node.parent;
  while (cur) {
    if (ts.isObjectLiteralExpression(cur)) return false;
    if (ts.isPropertyAssignment(cur)) {
      return propertyNameText(cur.name) === field;
    }
    if (ts.isShorthandPropertyAssignment(cur)) return cur.name.text === field;
    // Don't walk out of the enclosing expression into unrelated statements.
    if (ts.isStatement(cur) || ts.isFunctionLike(cur)) return false;
    cur = cur.parent;
  }
  return false;
}

/**
 * R4 — the receiver is a local `const X = {…}` (optionally `as const`), not a DB
 * row. `packages/db/src/seed-presets.ts` has `const COL = {…} as const`, so
 * `COL.userStoryTags` and five siblings would otherwise read as live consumers
 * and silently clear AEH-228 items 2, 5 and 6.
 */
function isConstObjectReceiver(checker: ts.TypeChecker, receiver: ts.Expression): boolean {
  if (!ts.isIdentifier(receiver)) return false;
  const sym = checker.getSymbolAtLocation(receiver);
  for (const decl of sym?.getDeclarations() ?? []) {
    if (!ts.isVariableDeclaration(decl) || !decl.initializer) continue;
    let init: ts.Expression = decl.initializer;
    while (ts.isAsExpression(init) || ts.isTypeAssertionExpression(init) || ts.isParenthesizedExpression(init)) {
      init = init.expression;
    }
    if (ts.isObjectLiteralExpression(init)) return true;
  }
  return false;
}

/**
 * R5 — form echo. `<Textarea name="notes" defaultValue={active.notes}>` and
 * `<input name="canParallel" defaultChecked={active.canParallel}>` are the ONLY
 * reads of those two fields. A value read solely to seed a control that writes
 * the same field straight back is a round-trip, not a consumer. Without this
 * rule AEH-228 item 5 (`preset.notes`) goes unflagged.
 */
function isFormEcho(node: ts.Node, field: string): boolean {
  let cur: ts.Node | undefined = node.parent;
  while (cur && !ts.isJsxAttribute(cur)) {
    if (ts.isStatement(cur) || ts.isFunctionLike(cur)) return false;
    cur = cur.parent;
  }
  if (!cur) return false;
  const attrs = cur.parent;
  if (!ts.isJsxAttributes(attrs)) return false;
  for (const a of attrs.properties) {
    if (!ts.isJsxAttribute(a) || !a.initializer) continue;
    const an = ts.isIdentifier(a.name) ? a.name.text : null;
    if (an !== 'name' && an !== 'id') continue;
    if (ts.isStringLiteral(a.initializer) && a.initializer.text === field) return true;
  }
  return false;
}

/**
 * R6 — is this object-literal key inside a `where`/`orderBy` (querying BY the
 * column, a real consumer) or a `select`/`include` (merely fetching it)?
 * `PresetVersion.sourceMenuItemId`'s only non-write occurrence is
 * `where: { sourceEstimateId, sourceMenuItemId: item.id }` in writeback.ts —
 * without R6 the promotion idempotency key reads as an orphan.
 */
function prismaArgRole(node: ts.Node): 'query' | 'projection' | null {
  let cur: ts.Node | undefined = node.parent;
  while (cur) {
    if (ts.isPropertyAssignment(cur)) {
      const key = propertyNameText(cur.name);
      if (key && QUERY_KEYS.has(key)) return 'query';
      if (key && PROJECTION_KEYS.has(key)) return 'projection';
    }
    if (ts.isCallExpression(cur) || ts.isStatement(cur) || ts.isFunctionLike(cur)) return null;
    cur = cur.parent;
  }
  return null;
}

function familyOfType(checker: ts.TypeChecker, t: ts.Type): Family {
  const f = t.getFlags();
  if (f & ts.TypeFlags.StringLike) return 'string';
  if (f & ts.TypeFlags.NumberLike) return 'number';
  if (f & ts.TypeFlags.BooleanLike) return 'boolean';
  if (checker.typeToString(t).includes('Date')) return 'date';
  return 'unknown';
}

/**
 * Which target(s) does `receiver.field` belong to?
 *
 * Score by structural overlap between the receiver's property names and each
 * target's field set, NOT by matching the type's symbol name: Prisma's
 * `findMany` returns anonymous mapped types (`GetFindResult<…>`) whose symbol
 * name is useless, and half the real readers are hand-written DTOs anyway.
 *
 * This is what separates the dead `PresetVersion.notes` from the live
 * `RoleLineItem.notes` among ~13 `notes` occurrences. Verified: the receiver of
 * `li.notes` in sheets-export.ts exposes
 * {baseHours, enabled, lineItemId, menuItemId, menuItemTitle, notes, taxedHours,
 *  taxonomyKey, title} — 5 shared with RoleLineItem, 2 with PresetVersion.
 *
 * Unresolved receivers fail OPEN (attributed to every candidate) so the audit
 * prefers a false negative over a false orphan. The audit guards that with an
 * `attributionResolvedRatio` canary, because a wholesale resolution failure
 * would otherwise make the gate silently pass forever.
 */
function attribute(
  checker: ts.TypeChecker,
  receiver: ts.Expression,
  field: string,
  targets: AttributionTarget[],
): { ids: string[]; resolved: boolean } {
  const candidates = targets.filter((t) => t.fieldNames.has(field));
  if (candidates.length <= 1) {
    return { ids: candidates.map((c) => c.id), resolved: true };
  }

  const type = checker.getTypeAtLocation(receiver).getNonNullableType();
  const props = new Set<string>();
  const constituents = type.isUnion() ? type.types : [type];
  for (const c of constituents) {
    for (const p of checker.getPropertiesOfType(c)) props.add(p.name);
  }
  if (props.size === 0) {
    return { ids: candidates.map((c) => c.id), resolved: false };
  }

  // Family gate: a `number` COL index can't be the `string[]` column it names.
  let filtered = candidates;
  const sym = [...constituents]
    .map((c) => checker.getPropertyOfType(c, field))
    .find((s): s is ts.Symbol => Boolean(s));
  if (sym) {
    const fam = familyOfType(checker, checker.getTypeOfSymbolAtLocation(sym, receiver));
    if (fam !== 'unknown') {
      const gated = candidates.filter((c) => {
        const want = c.families.get(field);
        return !want || want === 'unknown' || want === fam || (want === 'enum' && fam === 'string');
      });
      if (gated.length > 0) filtered = gated;
    }
  }

  let best = -1;
  let winners: AttributionTarget[] = [];
  for (const c of filtered) {
    let score = 0;
    for (const n of c.fieldNames) if (props.has(n)) score++;
    if (score > best) {
      best = score;
      winners = [c];
    } else if (score === best) {
      winners.push(c);
    }
  }
  // Too little signal to discriminate — keep every candidate rather than guess.
  if (best < 2) return { ids: filtered.map((c) => c.id), resolved: true };
  return { ids: winners.map((c) => c.id), resolved: true };
}

export function indexOccurrences(
  src: SourceSet,
  interest: ReadonlySet<string>,
  targets: AttributionTarget[],
): OccurrenceIndex {
  const byName = new Map<string, Occurrence[]>();
  let candidateReads = 0;
  let resolvedReads = 0;

  const push = (o: Occurrence): void => {
    const list = byName.get(o.name);
    if (list) list.push(o);
    else byName.set(o.name, [o]);
  };

  for (const sf of src.files) {
    const file = repoRelative(src.repoRoot, sf.fileName);

    const record = (
      node: ts.Node,
      name: string,
      verdict: Verdict,
      ids: string[],
      resolved: boolean,
    ): void => {
      push({
        name,
        file,
        line: lineOf(sf, node),
        verdict,
        attributedTo: ids,
        resolved,
        snippet: snippetOf(sf, node),
      });
    };

    /** Classify a candidate read (R3 → R4 → R5, else a genuine read). */
    const classifyRead = (node: ts.Node, receiver: ts.Expression, name: string): void => {
      candidateReads++;
      const { ids, resolved } = attribute(src.checker, receiver, name, targets);
      if (resolved) resolvedReads++;
      let verdict: Verdict = 'read';
      if (isCarryForward(node, name)) verdict = 'carry-forward';
      else if (isConstObjectReceiver(src.checker, receiver)) verdict = 'const-object';
      else if (isFormEcho(node, name)) verdict = 'form-echo';
      record(node, name, verdict, ids, resolved);
    };

    const visit = (node: ts.Node): void => {
      // ── R1: the only three shapes that can be a read ──────────────────────
      if (ts.isPropertyAccessExpression(node) && interest.has(node.name.text)) {
        classifyRead(node, node.expression, node.name.text);
      } else if (
        ts.isElementAccessExpression(node) &&
        node.argumentExpression &&
        ts.isStringLiteral(node.argumentExpression) &&
        interest.has(node.argumentExpression.text)
      ) {
        classifyRead(node, node.expression, node.argumentExpression.text);
      } else if (ts.isBindingElement(node)) {
        const name = propertyNameText(node.propertyName ?? node.name);
        const pattern = node.parent;
        if (name && interest.has(name) && ts.isObjectBindingPattern(pattern)) {
          const decl = pattern.parent;
          const receiver =
            ts.isVariableDeclaration(decl) && decl.initializer ? decl.initializer : null;
          if (receiver) classifyRead(node, receiver, name);
          else record(node, name, 'read', [], false); // destructured parameter
        }
      }

      // ── R2/R6: object-literal property NAMES are writes, never reads ──────
      // This subsumes "constant-write" and also catches non-constant writes
      // like `toggleable: !notSafelyRemovable` (architect.ts), which a
      // literal-value-only rule would misread as a consumer.
      if (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) {
        const name = propertyNameText(node.name);
        if (name && interest.has(name)) {
          const role = prismaArgRole(node);
          const verdict: Verdict =
            role === 'query' ? 'query-read' : role === 'projection' ? 'projection' : 'write';
          const ids = targets.filter((t) => t.fieldNames.has(name)).map((t) => t.id);
          record(node, name, verdict, ids, true);
        }
      }

      // Type/interface/zod member declarations.
      if (
        ts.isPropertySignature(node) ||
        ts.isPropertyDeclaration(node) ||
        ts.isMethodSignature(node)
      ) {
        const name = propertyNameText(node.name);
        if (name && interest.has(name)) {
          const ids = targets.filter((t) => t.fieldNames.has(name)).map((t) => t.id);
          record(node, name, 'type-decl', ids, true);
        }
      }

      // ── R7: raw SQL identifiers ───────────────────────────────────────────
      // packages/db/src/changelog.ts reads changeReason, changeMotivation,
      // createdAt and createdBy ONLY inside $queryRaw templates. Without this,
      // four models sprout false orphans.
      if (ts.isCallExpression(node) || ts.isTaggedTemplateExpression(node)) {
        const calleeText = ts.isCallExpression(node)
          ? node.expression.getText(sf)
          : node.tag.getText(sf);
        if (RAW_SQL_CALLEE.test(calleeText)) {
          const sql = node.getText(sf);
          const model = /(?:FROM|UPDATE|JOIN|INTO)\s+"(\w+)"/i.exec(sql)?.[1] ?? null;
          for (const name of interest) {
            if (!new RegExp(`"${name}"|\\b${name}\\b`).test(sql)) continue;
            const ids = targets
              .filter((t) => t.fieldNames.has(name) && (!model || t.id.split('.')[0] === model))
              .map((t) => t.id);
            if (ids.length > 0) record(node, name, 'query-read', ids, true);
          }
        }
      }

      ts.forEachChild(node, visit);
    };

    visit(sf);
  }

  return {
    byName,
    stats: {
      filesAnalysed: src.files.length,
      candidateReads,
      resolvedReads,
      attributionResolvedRatio: candidateReads === 0 ? 1 : resolvedReads / candidateReads,
    },
  };
}
