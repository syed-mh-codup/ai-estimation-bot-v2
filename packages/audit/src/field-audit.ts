import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import {
  auditableFields,
  jsonFields,
  parsePrismaSchema,
  type Exemption,
  type Family,
  type PrismaSchema,
} from './prisma-schema.js';
import {
  indexOccurrences,
  isConsuming,
  type AttributionTarget,
  type Occurrence,
  type OccurrenceIndex,
} from './occurrences.js';
import { createSourceSet, repoRelative, type SourceSet } from './source-set.js';

export type FindingKind =
  | 'orphan'
  | 'stale-exemption-consumed'
  | 'stale-exemption-missing-key'
  | 'misplaced-annotation'
  | 'malformed-annotation'
  | 'duplicate-annotation';

export interface Finding {
  /** 'PresetVersion.canParallel' or 'MenuItem.meta.thinSlice'. */
  id: string;
  kind: FindingKind;
  schemaLine: number;
  message: string;
}

export interface JsonKeySource {
  id: string;
  file: string;
  line: number;
  keys: string[];
}

export interface FieldAuditReport {
  audited: number;
  exempt: number;
  consumed: number;
  findings: Finding[];
  diagnostics: {
    unparsedSchemaLines: { line: number; text: string }[];
    filesAnalysed: number;
    candidateReads: number;
    attributionResolvedRatio: number;
    jsonKeySources: JsonKeySource[];
  };
}

const SCHEMA_PATH = 'packages/db/prisma/schema.prisma';

/** One auditable thing: a column, or a single key inside a Json column. */
interface Target {
  id: string;
  /** Attribution target id — the model, or 'Model.jsonColumn' for a Json key. */
  attributionId: string;
  fieldName: string;
  schemaLine: number;
  exemptions: Exemption[];
  isJsonKey: boolean;
  /** For a Json key: the owning column, so its read-status can be checked. */
  jsonColumn: { model: string; name: string } | null;
}

/**
 * Discover which keys are actually persisted into each Json column.
 *
 * The write-site object literal is the source of truth, not a zod schema:
 * `MenuItemSchema`/`RoleLineItemSchema` are supersets, and what lands in the
 * column is a projection of them. Attribution fingerprints the CONTAINING
 * literal's own property names, rather than pattern-matching Prisma call shapes,
 * which would be brittle. Verified unambiguous on both write sites in
 * run-estimate.ts: the MenuItem literal shares 9 names with MenuItem and 2 with
 * RoleLineItem; the line-item literal shares 8 with RoleLineItem and 2 with
 * MenuItem.
 */
export function discoverJsonKeys(
  src: SourceSet,
  schema: PrismaSchema,
): Map<string, JsonKeySource[]> {
  const jsonCols = jsonFields(schema);
  const jsonNames = new Set(jsonCols.map((f) => f.name));
  const modelFieldSets = new Map<string, Set<string>>();
  for (const [model, fields] of schema.models) {
    modelFieldSets.set(model, new Set(fields.map((f) => f.name)));
  }

  const out = new Map<string, JsonKeySource[]>();

  for (const sf of src.files) {
    const visit = (node: ts.Node): void => {
      if (
        ts.isPropertyAssignment(node) &&
        ts.isIdentifier(node.name) &&
        jsonNames.has(node.name.text) &&
        ts.isObjectLiteralExpression(node.initializer)
      ) {
        const colName = node.name.text;
        const keys = node.initializer.properties
          .map((p) =>
            (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) &&
            ts.isIdentifier(p.name)
              ? p.name.text
              : null,
          )
          .filter((k): k is string => k !== null);
        if (keys.length === 0) return;

        // Fingerprint the containing literal to decide which model owns it.
        const container = node.parent;
        const siblingNames = new Set<string>();
        if (ts.isObjectLiteralExpression(container)) {
          for (const p of container.properties) {
            if (p.name && ts.isIdentifier(p.name)) siblingNames.add(p.name.text);
          }
        }
        let bestModel: string | null = null;
        let bestScore = -1;
        for (const f of jsonCols) {
          if (f.name !== colName) continue;
          const fields = modelFieldSets.get(f.model);
          if (!fields) continue;
          let score = 0;
          for (const n of siblingNames) if (fields.has(n)) score++;
          if (score > bestScore) {
            bestScore = score;
            bestModel = f.model;
          }
        }
        if (bestModel) {
          const id = `${bestModel}.${colName}`;
          const entry: JsonKeySource = {
            id,
            file: repoRelative(src.repoRoot, sf.fileName),
            line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
            keys: keys.sort(),
          };
          const list = out.get(id);
          if (list) list.push(entry);
          else out.set(id, [entry]);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }

  return out;
}

function buildTargets(
  schema: PrismaSchema,
  jsonKeys: Map<string, JsonKeySource[]>,
): { targets: Target[]; attribution: AttributionTarget[]; interest: Set<string> } {
  const targets: Target[] = [];
  const interest = new Set<string>();

  for (const f of auditableFields(schema)) {
    targets.push({
      id: `${f.model}.${f.name}`,
      attributionId: f.model,
      fieldName: f.name,
      schemaLine: f.line,
      exemptions: f.exemptions,
      isJsonKey: false,
      jsonColumn: null,
    });
    interest.add(f.name);
  }

  for (const jf of jsonFields(schema)) {
    const id = `${jf.model}.${jf.name}`;
    const sources = jsonKeys.get(id);
    interest.add(jf.name);

    // No discoverable keys — the column is written as `{}`, or through a
    // variable rather than an inline literal. Audit it as a plain column rather
    // than skipping it: silently dropping a column would be a coverage hole in
    // the very detector that exists to stop silent failures. Today this covers
    // Estimate.taxonomyVersionsPinned / promptVersionsPinned / modelConfig, all
    // written as `{}` at ingest-create and read as property accesses in
    // packages/agents/src/cache.ts.
    if (!sources || sources.length === 0) {
      targets.push({
        id,
        attributionId: jf.model,
        fieldName: jf.name,
        schemaLine: jf.line,
        exemptions: jf.exemptions.filter((e) => e.jsonKey === null),
        isJsonKey: false,
        jsonColumn: null,
      });
      continue;
    }

    // A column WITH discovered keys is audited per key only, never also as a
    // column — otherwise MenuItem.meta (zero `.meta` reads anywhere) would be
    // reported alongside all four of its keys.
    const keys = new Set(sources.flatMap((s) => s.keys));
    for (const key of keys) {
      targets.push({
        id: `${id}.${key}`,
        attributionId: id,
        fieldName: key,
        schemaLine: jf.line,
        exemptions: jf.exemptions.filter((e) => e.jsonKey === key),
        isJsonKey: true,
        jsonColumn: { model: jf.model, name: jf.name },
      });
      interest.add(key);
    }
  }

  // Attribution targets: one per model, plus a pseudo-model per Json column
  // whose field set is the model's own fields plus the discovered keys (which is
  // exactly the shape of the DTOs that would read them).
  const attribution: AttributionTarget[] = [];
  for (const [model, fields] of schema.models) {
    attribution.push({
      id: model,
      fieldNames: new Set(fields.map((f) => f.name)),
      families: new Map(fields.map((f) => [f.name, f.family] as [string, Family])),
    });
  }
  for (const [id, sources] of jsonKeys) {
    const model = id.split('.')[0] ?? '';
    const fields = schema.models.get(model) ?? [];
    const names = new Set(fields.map((f) => f.name));
    for (const k of sources.flatMap((s) => s.keys)) names.add(k);
    attribution.push({
      id,
      fieldNames: names,
      families: new Map(fields.map((f) => [f.name, f.family] as [string, Family])),
    });
  }

  return { targets, attribution, interest };
}

function consumersOf(target: Target, index: OccurrenceIndex): Occurrence[] {
  const all = index.byName.get(target.fieldName) ?? [];
  return all.filter((o) => isConsuming(o.verdict) && o.attributedTo.includes(target.attributionId));
}

/**
 * Is the Json column itself ever read back out of the database?
 *
 * This gates every key inside it, and it is the rule that makes Json auditing
 * actually correct. A key's own name being read somewhere is NOT evidence the
 * persisted key is consumed: the pipeline reads `requirementIds` and `dependsOn`
 * off in-flight zod objects (MenuItemSchema / RoleLineItemSchema) whose shape is
 * deliberately near-identical to the DB row's, so structural attribution cannot
 * tell "read the value we stored" from "read the value before storing it".
 *
 * Reading the column is a precondition for reading any key in it. Nothing in the
 * repo reads `MenuItem.meta` or `RoleLineItem.meta` at all — `grep -rn '\.meta\b'`
 * over the audited scope returns zero — so every key in them is write-only, which
 * is precisely AEH-228's headline finding.
 */
function jsonColumnIsRead(
  col: { model: string; name: string },
  index: OccurrenceIndex,
): boolean {
  const all = index.byName.get(col.name) ?? [];
  return all.some((o) => isConsuming(o.verdict) && o.attributedTo.includes(col.model));
}

function evidenceTable(target: Target, index: OccurrenceIndex): string {
  const all = (index.byName.get(target.fieldName) ?? []).filter((o) =>
    o.attributedTo.includes(target.attributionId),
  );
  if (all.length === 0) return '    (no occurrences anywhere in the audited source set)';
  return all
    .slice(0, 8)
    .map((o) => `    ${o.file}:${o.line}  [${o.verdict}]  ${o.snippet}`)
    .join('\n');
}

const FIX_HINT = [
  '    Fix it, or record the intent in schema.prisma above the field:',
  '      /// @backend-only <why this is deliberately never surfaced>',
  '      /// @orphan-todo AEH-### <what is missing>',
].join('\n');

export function runFieldAudit(opts: { repoRoot: string }): FieldAuditReport {
  const { repoRoot } = opts;
  const schema = parsePrismaSchema(readFileSync(join(repoRoot, SCHEMA_PATH), 'utf8'));
  const src = createSourceSet(repoRoot);
  const jsonKeys = discoverJsonKeys(src, schema);
  const { targets, attribution, interest } = buildTargets(schema, jsonKeys);
  const index = indexOccurrences(src, interest, attribution);

  const findings: Finding[] = [];
  let exempt = 0;
  let consumed = 0;

  // Exemptions on fields the audit never looks at are dead weight that reads as
  // protection. Flag them so they can't accumulate.
  const auditedIds = new Set(targets.map((t) => t.id));
  for (const f of [...schema.models.values()].flat()) {
    for (const ex of f.exemptions) {
      const id = ex.jsonKey ? `${f.model}.${f.name}.${ex.jsonKey}` : `${f.model}.${f.name}`;
      if (auditedIds.has(id)) continue;
      const isJsonCol = f.family === 'json';
      findings.push({
        id,
        kind: isJsonCol && ex.jsonKey ? 'stale-exemption-missing-key' : 'misplaced-annotation',
        schemaLine: ex.line,
        message:
          isJsonCol && ex.jsonKey
            ? `stale-exemption-missing-key: ${id} (${SCHEMA_PATH}:${ex.line}) — no Json write site persists this key any more. Delete the annotation.\n      ${ex.raw}`
            : `misplaced-annotation: ${id} (${SCHEMA_PATH}:${ex.line}) — not an audited field (relation, @id, foreign key, Unsupported, createdAt/updatedAt, or a Json column with no discovered keys). The annotation protects nothing.\n      ${ex.raw}`,
      });
    }
  }

  for (const t of targets) {
    // A key inside a Json column nothing ever reads back is write-only, whatever
    // its name does elsewhere in the pipeline.
    const columnDead = t.jsonColumn !== null && !jsonColumnIsRead(t.jsonColumn, index);
    const consumers = columnDead ? [] : consumersOf(t, index);
    const hasConsumer = consumers.length > 0;
    if (hasConsumer) consumed++;

    if (t.exemptions.length > 1) {
      findings.push({
        id: t.id,
        kind: 'duplicate-annotation',
        schemaLine: t.schemaLine,
        message: `duplicate-annotation: ${t.id} (${SCHEMA_PATH}:${t.schemaLine}) — ${t.exemptions.length} annotations on one field. Keep exactly one.`,
      });
      continue;
    }

    const ex = t.exemptions[0];

    if (ex?.malformed) {
      findings.push({
        id: t.id,
        kind: 'malformed-annotation',
        schemaLine: ex.line,
        message: `malformed-annotation: ${t.id} (${SCHEMA_PATH}:${ex.line}) — ${
          ex.kind === 'orphan-todo' && !ex.ticket
            ? 'an @orphan-todo must name a ticket (AEH-###).'
            : 'the reason must be at least 12 characters and say why.'
        }\n      ${ex.raw}`,
      });
      continue;
    }

    if (ex) {
      exempt++;
      if (hasConsumer) {
        const first = consumers[0];
        findings.push({
          id: t.id,
          kind: 'stale-exemption-consumed',
          schemaLine: ex.line,
          message:
            `stale-exemption-consumed: ${t.id} (${SCHEMA_PATH}:${ex.line}) — annotated as ` +
            `${ex.kind} but now has a real consumer at ${first?.file}:${first?.line}. ` +
            `Delete the annotation.\n      ${ex.raw}`,
        });
      }
      continue;
    }

    if (!hasConsumer) {
      const all = (index.byName.get(t.fieldName) ?? []).filter((o) =>
        o.attributedTo.includes(t.attributionId),
      );
      const why = columnDead
        ? `persisted into ${t.jsonColumn?.model}.${t.jsonColumn?.name}, which nothing ever reads back out of the database — so every key in it is write-only.`
        : 'persisted but nothing consumes it.';
      findings.push({
        id: t.id,
        kind: 'orphan',
        schemaLine: t.schemaLine,
        message:
          `orphan: ${t.id} (${SCHEMA_PATH}:${t.schemaLine}) — ${why}\n` +
          `    ${all.length} occurrence(s), none a consumer:\n${evidenceTable(t, index)}\n${FIX_HINT}`,
      });
    }
  }

  findings.sort((a, b) => a.id.localeCompare(b.id));

  return {
    audited: targets.length,
    exempt,
    consumed,
    findings,
    diagnostics: {
      unparsedSchemaLines: schema.unparsedLines,
      filesAnalysed: index.stats.filesAnalysed,
      candidateReads: index.stats.candidateReads,
      attributionResolvedRatio: index.stats.attributionResolvedRatio,
      jsonKeySources: [...jsonKeys.values()].flat(),
    },
  };
}

export function formatReport(r: FieldAuditReport): string {
  const lines: string[] = [];
  lines.push(
    `orphan-field audit: ${r.audited} audited, ${r.consumed} consumed, ${r.exempt} exempt, ${r.findings.length} finding(s)`,
  );
  lines.push(
    `  files=${r.diagnostics.filesAnalysed} candidateReads=${r.diagnostics.candidateReads} ` +
      `attributionResolved=${(r.diagnostics.attributionResolvedRatio * 100).toFixed(1)}%`,
  );
  if (r.diagnostics.unparsedSchemaLines.length > 0) {
    lines.push(`  !! ${r.diagnostics.unparsedSchemaLines.length} unparsed schema line(s)`);
    for (const u of r.diagnostics.unparsedSchemaLines) lines.push(`     ${u.line}: ${u.text}`);
  }
  lines.push('');
  for (const f of r.findings) lines.push(f.message, '');
  return lines.join('\n');
}
