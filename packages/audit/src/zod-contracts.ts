import ts from 'typescript';
import { repoRelative, type SourceSet } from './source-set.js';
import type { OccurrenceIndex } from './occurrences.js';

/**
 * Contract-field audit: zod schema fields that exist and are referenced nowhere.
 *
 * Why this is a third check rather than part of the Prisma field audit: AEH-228
 * item 3 (`SupervisorInput.mode`, `changedMenuItemIds`) has no column behind it.
 * It is declared in `packages/shared/src/schemas.ts` and nothing persists it, so
 * the column audit can never see it, and knip will not report it while
 * `SupervisorInputSchema` still has a non-test importer. It was the one item of
 * the original eight that neither of the first two checks could catch.
 *
 * ── Why the rule here is deliberately much stricter ────────────────────────────
 *
 * A field is flagged ONLY if the identifier appears nowhere in the audited source
 * set outside its own declaration.
 *
 * The Prisma audit can afford to ask "is there a semantic READ of this field",
 * because a DB column is always accessed field-by-field. Zod schemas here are
 * mostly LLM I/O contracts, and an input schema is routinely serialised whole
 * (`JSON.stringify(input)`) into a prompt — so "no property access" emphatically
 * does not mean "dead", and applying the read-classification rules would flag
 * dozens of fields that the model genuinely consumes.
 *
 * Zero references anywhere is unambiguous regardless of how the schema is
 * serialised. It under-reports on purpose: the goal is no false positives in a
 * check whose whole value is that people trust it.
 */

export interface ZodField {
  /** 'SupervisorInputSchema.changedMenuItemIds' */
  id: string;
  schema: string;
  field: string;
  file: string;
  line: number;
  exemption: { kind: string; reason: string; ticket: string | null; malformed: boolean } | null;
}

export interface ContractFinding {
  id: string;
  kind: 'orphan-contract-field' | 'stale-contract-exemption' | 'malformed-contract-annotation';
  file: string;
  line: number;
  message: string;
}

const TAG_RE = /@(backend-only|orphan-todo)\s+(.*)/;
const TICKET_RE = /\bAEH-\d+\b/;
const MIN_REASON_LENGTH = 12;

/**
 * Fields on schemas that describe someone else's payload, not ours.
 *
 * A field an LLM is instructed to return, or that mirrors an external API, is
 * not orphaned by having no reader in our tree — the contract is the point.
 * Kept as an explicit, short list rather than a heuristic.
 */
const SKIP_SCHEMAS = new Set<string>();

function jsDocExemption(node: ts.Node): ZodField['exemption'] {
  for (const jd of ts.getJSDocCommentsAndTags(node)) {
    const text = jd.getFullText();
    const m = TAG_RE.exec(text);
    if (!m) continue;
    const kind = m[1] ?? '';
    const rest = m[2] ?? '';
    const ticket = TICKET_RE.exec(rest)?.[0] ?? null;
    const reason = (kind === 'orphan-todo' ? rest.replace(TICKET_RE, '') : rest).trim();
    return {
      kind,
      reason,
      ticket,
      malformed: reason.length < MIN_REASON_LENGTH || (kind === 'orphan-todo' && !ticket),
    };
  }
  return null;
}

/** Nearest enclosing `const X = …` name, which is how every schema here is declared. */
function enclosingSchemaName(node: ts.Node): string | null {
  let cur: ts.Node | undefined = node;
  while (cur) {
    if (ts.isVariableDeclaration(cur) && ts.isIdentifier(cur.name)) return cur.name.text;
    cur = cur.parent;
  }
  return null;
}

function isZodObjectCall(node: ts.Node): node is ts.CallExpression {
  if (!ts.isCallExpression(node)) return false;
  const callee = node.expression;
  return (
    ts.isPropertyAccessExpression(callee) &&
    callee.name.text === 'object' &&
    ts.isIdentifier(callee.expression) &&
    callee.expression.text === 'z'
  );
}

export function discoverZodFields(src: SourceSet): ZodField[] {
  const out: ZodField[] = [];
  for (const sf of src.files) {
    const file = repoRelative(src.repoRoot, sf.fileName);
    const visit = (node: ts.Node): void => {
      if (isZodObjectCall(node)) {
        const arg = node.arguments[0];
        const schema = enclosingSchemaName(node);
        if (arg && ts.isObjectLiteralExpression(arg) && schema && !SKIP_SCHEMAS.has(schema)) {
          for (const p of arg.properties) {
            if (!ts.isPropertyAssignment(p) || !ts.isIdentifier(p.name)) continue;
            out.push({
              id: `${schema}.${p.name.text}`,
              schema,
              field: p.name.text,
              file,
              line: sf.getLineAndCharacterOfPosition(p.getStart(sf)).line + 1,
              exemption: jsDocExemption(p),
            });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return out;
}

export function auditContractFields(
  fields: ZodField[],
  index: OccurrenceIndex,
): ContractFinding[] {
  // Every declaration site of every name, so a field declared in two schemas
  // isn't kept alive by the other's declaration.
  const declSites = new Map<string, Set<string>>();
  for (const f of fields) {
    const set = declSites.get(f.field) ?? new Set<string>();
    set.add(`${f.file}:${f.line}`);
    declSites.set(f.field, set);
  }

  const findings: ContractFinding[] = [];
  for (const f of fields) {
    const decls = declSites.get(f.field) ?? new Set<string>();
    const elsewhere = (index.byName.get(f.field) ?? []).filter(
      (o) => !decls.has(`${o.file}:${o.line}`),
    );
    const referenced = elsewhere.length > 0;

    if (f.exemption?.malformed) {
      findings.push({
        id: f.id,
        kind: 'malformed-contract-annotation',
        file: f.file,
        line: f.line,
        message:
          `malformed-contract-annotation: ${f.id} (${f.file}:${f.line}) — ` +
          (f.exemption.kind === 'orphan-todo' && !f.exemption.ticket
            ? 'an @orphan-todo must name a ticket (AEH-###).'
            : 'the reason must be at least 12 characters and say why.'),
      });
      continue;
    }

    if (f.exemption) {
      if (referenced) {
        findings.push({
          id: f.id,
          kind: 'stale-contract-exemption',
          file: f.file,
          line: f.line,
          message:
            `stale-contract-exemption: ${f.id} (${f.file}:${f.line}) — annotated as ` +
            `${f.exemption.kind} but now referenced at ${elsewhere[0]?.file}:${elsewhere[0]?.line}. ` +
            `Delete the annotation.`,
        });
      }
      continue;
    }

    if (!referenced) {
      findings.push({
        id: f.id,
        kind: 'orphan-contract-field',
        file: f.file,
        line: f.line,
        message:
          `orphan-contract-field: ${f.id} (${f.file}:${f.line}) — declared in a zod ` +
          `contract and referenced nowhere else in the audited source set. Nothing ` +
          `writes it and nothing reads it.\n` +
          `    Delete it, wire it up, or record the intent in a JSDoc comment on the field:\n` +
          `      /** @backend-only <why this is deliberately unreferenced> */\n` +
          `      /** @orphan-todo AEH-### <what is missing> */`,
      });
    }
  }

  findings.sort((a, b) => a.id.localeCompare(b.id));
  return findings;
}
