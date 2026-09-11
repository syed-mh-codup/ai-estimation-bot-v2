import { readFileSync } from 'node:fs';
import ts from 'typescript';

import { collectSourceFilePaths, repoRelative } from './source-set.js';

/**
 * Every read of the Estimate model, and whether it excludes deleted rows.
 * AEH-375.
 *
 * Soft delete has exactly one failure mode and it is not subtle: a read path
 * nobody remembered, and a deleted estimate still sitting on somebody's
 * screen. There is no runtime error to catch it, no test that fails by
 * accident, and the miss is invisible until the person who deleted the thing
 * sees it again. The only defence that scales is a gate that enumerates the
 * call sites itself.
 *
 * So this walks the AST for `<anything>.estimate.<read>()` and asks one
 * question of each: does its `where` mention `deletedAt`? A read that does not
 * must carry a `@deleted-ok` comment saying why — the same opt-out convention
 * the orphan-field audit uses with `@backend-only`, and for the same reason.
 * Plenty of these reads SHOULD see deleted rows; what is not acceptable is a
 * read that sees them because nobody thought about it.
 *
 * Text-matching the `where`, not type-checking it. A `deletedAt` mentioned
 * anywhere in the filter counts, which admits `deletedAt: null`,
 * `deletedAt: { not: null }` and a spread of either. That is deliberate: the
 * point is to force a decision at every site, not to police the shape of it.
 * The decision itself is what the reviewer reads.
 *
 * Nested relation reads are checked too, because `include: { children: {…} }`
 * on an estimate query is a second read of the same model and leaks exactly
 * the same way — it is how a deleted fork nearly stayed in the forks rail.
 * Only `children` can be filtered; `parent` is to-one and Prisma takes no
 * `where` on it, so a deleted parent has to be handled where it renders.
 */

/** Prisma reads. Writes are not audited: writing to a deleted row is fine. */
const READ_METHODS: ReadonlySet<string> = new Set([
  'findMany',
  'findFirst',
  'findFirstOrThrow',
  'findUnique',
  'findUniqueOrThrow',
  'count',
  'aggregate',
  'groupBy',
]);

/** The opt-out tag, mirroring the field audit's `@backend-only`. */
export const DELETED_OK = '@deleted-ok';

export interface EstimateRead {
  file: string;
  line: number;
  /** `findMany`, `count`, … or `include.children` for a nested relation read. */
  method: string;
  /** Its `where` mentions `deletedAt`. */
  filtered: boolean;
  /** It carries a `@deleted-ok` comment. */
  excused: boolean;
  /** The reason given after the tag, for the readable report. */
  reason: string;
}

export interface EstimateReadAudit {
  reads: EstimateRead[];
  /** Reads that neither filter nor say why not. The gate asserts this is empty. */
  unguarded: EstimateRead[];
  diagnostics: { filesScanned: number; nestedReads: number };
}

/** The `where` property's source text, or '' when the call has no `where`. */
function whereText(call: ts.CallExpression): string {
  const arg = call.arguments[0];
  if (!arg || !ts.isObjectLiteralExpression(arg)) return '';
  return propText(arg, 'where');
}

function propText(obj: ts.ObjectLiteralExpression, name: string): string {
  for (const prop of obj.properties) {
    if (!ts.isPropertyAssignment(prop)) continue;
    const key = prop.name.getText();
    if (key === name || key === `'${name}'`) return prop.initializer.getText();
  }
  return '';
}

/**
 * Comments attached to this node, plus the call's own text.
 *
 * Both, because the tag reads naturally in either place — above the statement
 * for a whole query, or inline beside the `where` it excuses — and requiring
 * one position would only make people fight the tool.
 */
function excuseFor(node: ts.Node, file: ts.SourceFile): { excused: boolean; reason: string } {
  const full = node.getFullText(file);
  const own = node.getText(file);
  // Leading trivia plus the node itself. A statement's trivia carries the
  // block comment above it, which is where most of these belong.
  const statement = enclosingStatement(node);
  const haystack = `${statement ? statement.getFullText(file) : full}\n${own}`;
  const at = haystack.indexOf(DELETED_OK);
  if (at === -1) return { excused: false, reason: '' };
  const rest = haystack.slice(at + DELETED_OK.length);
  const reason = (rest.split('\n')[0] ?? '').replace(/^[:\s—-]+/, '').trim();
  return { excused: true, reason };
}

function enclosingStatement(node: ts.Node): ts.Node | undefined {
  let cur: ts.Node | undefined = node;
  while (cur && !ts.isStatement(cur)) cur = cur.parent;
  return cur;
}

/** `prisma.estimate.findMany` → 'findMany'. Anything else → undefined. */
function estimateReadMethod(call: ts.CallExpression): string | undefined {
  const callee = call.expression;
  if (!ts.isPropertyAccessExpression(callee)) return undefined;
  const method = callee.name.text;
  if (!READ_METHODS.has(method)) return undefined;
  const receiver = callee.expression;
  if (!ts.isPropertyAccessExpression(receiver)) return undefined;
  // `prisma.estimate`, `db.estimate`, `tx.estimate`, `client.estimate` — the
  // receiver's own name is never checked, only that the model is `estimate`.
  if (receiver.name.text !== 'estimate') return undefined;
  return method;
}

export function runEstimateReadAudit(opts: { repoRoot: string }): EstimateReadAudit {
  const paths = collectSourceFilePaths(opts.repoRoot);
  const reads: EstimateRead[] = [];
  let nestedReads = 0;

  for (const path of paths) {
    const text = readFileSync(path, 'utf8');
    // A cheap gate before parsing: most files never mention the model.
    if (!text.includes('.estimate.') && !text.includes('children:')) continue;

    const file = ts.createSourceFile(path, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
    const rel = repoRelative(opts.repoRoot, path);

    const record = (node: ts.Node, method: string, where: string): void => {
      const { line } = file.getLineAndCharacterOfPosition(node.getStart(file));
      const { excused, reason } = excuseFor(node, file);
      reads.push({
        file: rel,
        line: line + 1,
        method,
        filtered: where.includes('deletedAt'),
        excused,
        reason,
      });
    };

    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const method = estimateReadMethod(node);
        if (method) {
          record(node, method, whereText(node));

          // Nested relation reads inside this query's `include`/`select`. Only
          // `children` — `parent` is to-one and takes no `where`.
          const arg = node.arguments[0];
          if (arg && ts.isObjectLiteralExpression(arg)) {
            for (const key of ['include', 'select'] as const) {
              const container = arg.properties.find(
                (p): p is ts.PropertyAssignment =>
                  ts.isPropertyAssignment(p) && p.name.getText() === key,
              );
              if (!container || !ts.isObjectLiteralExpression(container.initializer)) continue;
              const children = container.initializer.properties.find(
                (p): p is ts.PropertyAssignment =>
                  ts.isPropertyAssignment(p) && p.name.getText() === 'children',
              );
              if (!children || !ts.isObjectLiteralExpression(children.initializer)) continue;
              nestedReads += 1;
              record(children, 'include.children', propText(children.initializer, 'where'));
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }

  reads.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
  return {
    reads,
    unguarded: reads.filter((r) => !r.filtered && !r.excused),
    diagnostics: { filesScanned: paths.length, nestedReads },
  };
}

/** The readable report, for the CLI and for a failing assertion's message. */
export function formatEstimateReadReport(audit: EstimateReadAudit): string {
  const lines: string[] = [];
  lines.push(`Estimate reads: ${audit.reads.length} across ${audit.diagnostics.filesScanned} files`);
  lines.push(`  filtered by deletedAt: ${audit.reads.filter((r) => r.filtered).length}`);
  lines.push(`  excused with ${DELETED_OK}: ${audit.reads.filter((r) => !r.filtered && r.excused).length}`);
  lines.push(`  nested include.children reads: ${audit.diagnostics.nestedReads}`);
  if (audit.unguarded.length === 0) {
    lines.push('\nEvery read either excludes deleted estimates or says why it does not.');
    return lines.join('\n');
  }
  lines.push(`\n${audit.unguarded.length} read(s) neither filter nor explain:`);
  for (const r of audit.unguarded) {
    lines.push(`  ${r.file}:${r.line}  ${r.method}`);
  }
  lines.push(
    `\nAdd \`deletedAt: null\` to the where, or a \`${DELETED_OK} <reason>\` comment saying why this read must see deleted estimates.`,
  );
  return lines.join('\n');
}
