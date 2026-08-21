/**
 * Line parser for `packages/db/prisma/schema.prisma`.
 *
 * A regex/line parser rather than `@prisma/internals` because the schema is
 * small and deliberately plain: 417 lines, no `@map`/`@@map` anywhere (so Prisma
 * field names ARE the column names), no composite `type` blocks, no `@@ignore`,
 * and no multi-line field declarations. Pulling in `@prisma/internals` to read
 * it would add a heavy dependency for no accuracy.
 *
 * The parser deliberately records every line inside a model block that it does
 * NOT recognise (`unparsedLines`). A silently-skipped field is an unaudited
 * field, which is the exact class of failure AEH-228 exists to prevent, so the
 * audit asserts that list is empty rather than trusting the regexes.
 */

export type PrismaFieldKind = 'scalar' | 'relation' | 'unsupported' | 'unknown';

export type Family =
  | 'string'
  | 'number'
  | 'boolean'
  | 'date'
  | 'json'
  | 'bytes'
  | 'enum'
  | 'unknown';

/** `@backend-only` = permanent by design. `@orphan-todo` = known debt with a ticket. */
export type ExemptionKind = 'backend-only' | 'orphan-todo';

export interface Exemption {
  kind: ExemptionKind;
  /** Set when the tag targets one key inside a Json column (`@backend-only:thinSlice`). */
  jsonKey: string | null;
  /** Required for `orphan-todo`; always null for `backend-only`. */
  ticket: string | null;
  reason: string;
  line: number;
  /** True when the tag is syntactically present but unusable (short reason, missing ticket). */
  malformed: boolean;
  raw: string;
}

export interface PrismaField {
  model: string;
  name: string;
  /** Raw type token, e.g. `String[]`, `Json?`, `Unsupported("vector(1536)")?`. */
  type: string;
  kind: PrismaFieldKind;
  family: Family;
  isId: boolean;
  isList: boolean;
  isOptional: boolean;
  /** Scalar named in some `@relation(fields: [...])` on this model. */
  isForeignKey: boolean;
  attributes: string;
  docLines: string[];
  exemptions: Exemption[];
  line: number;
}

export interface PrismaSchema {
  models: Map<string, PrismaField[]>;
  enums: Set<string>;
  unparsedLines: { line: number; text: string }[];
}

const SCALAR_TYPES = new Set([
  'String',
  'Int',
  'Float',
  'Boolean',
  'DateTime',
  'Json',
  'Bytes',
  'Decimal',
  'BigInt',
]);

const FAMILY_BY_SCALAR: Record<string, Family> = {
  String: 'string',
  Int: 'number',
  Float: 'number',
  Decimal: 'number',
  BigInt: 'number',
  Boolean: 'boolean',
  DateTime: 'date',
  Json: 'json',
  Bytes: 'bytes',
};

/** `Unsupported("…")?` first, so its inner quotes can't be mistaken for attributes. */
const FIELD_RE =
  /^\s*(?<name>[A-Za-z_]\w*)\s+(?<type>Unsupported\("[^"]*"\)(?:\[\])?\??|\w+(?:\[\])?\??)(?<attrs>\s.*)?$/;

const BLOCK_RE = /^\s*(?<keyword>model|enum|type|view|generator|datasource)\s+(?<name>\w+)\s*\{/;

const TAG_RE = /^@(backend-only|orphan-todo)(?::([A-Za-z_]\w*))?\s+(.*)$/;

const TICKET_RE = /\bAEH-\d+\b/;

/** Reasons shorter than this are not reasons; they're a rubber stamp. */
const MIN_REASON_LENGTH = 12;

function parseExemption(docLine: string, line: number): Exemption | null {
  const m = TAG_RE.exec(docLine.trim());
  if (!m) return null;
  const [, kindRaw, jsonKey, rest = ''] = m;
  const kind = kindRaw as ExemptionKind;
  const ticket = TICKET_RE.exec(rest)?.[0] ?? null;
  const reason = (kind === 'orphan-todo' ? rest.replace(TICKET_RE, '') : rest).trim();
  const malformed = reason.length < MIN_REASON_LENGTH || (kind === 'orphan-todo' && !ticket);
  return {
    kind,
    jsonKey: jsonKey ?? null,
    ticket,
    reason,
    line,
    malformed,
    raw: docLine.trim(),
  };
}

function familyOf(baseType: string, enums: Set<string>): Family {
  if (enums.has(baseType)) return 'enum';
  return FAMILY_BY_SCALAR[baseType] ?? 'unknown';
}

function kindOf(
  baseType: string,
  rawType: string,
  models: Set<string>,
  enums: Set<string>,
): PrismaFieldKind {
  if (rawType.startsWith('Unsupported(')) return 'unsupported';
  if (models.has(baseType)) return 'relation';
  if (SCALAR_TYPES.has(baseType) || enums.has(baseType)) return 'scalar';
  return 'unknown';
}

/** Collect every scalar named in an `@relation(fields: [...])` on this model. */
function foreignKeysOf(fields: PrismaField[]): Set<string> {
  const fks = new Set<string>();
  for (const f of fields) {
    const m = /@relation\([^)]*fields:\s*\[([^\]]*)\]/.exec(f.attributes);
    if (!m?.[1]) continue;
    for (const raw of m[1].split(',')) {
      const name = raw.trim();
      if (name) fks.add(name);
    }
  }
  return fks;
}

export function parsePrismaSchema(source: string): PrismaSchema {
  const lines = source.split('\n');

  // Pass 1 — block names, so a field's type can be classified as model vs enum.
  const modelNames = new Set<string>();
  const enums = new Set<string>();
  for (const raw of lines) {
    const m = BLOCK_RE.exec(raw);
    if (!m?.groups) continue;
    const { keyword, name } = m.groups as { keyword: string; name: string };
    if (keyword === 'model' || keyword === 'view') modelNames.add(name);
    else if (keyword === 'enum') enums.add(name);
  }

  const models = new Map<string, PrismaField[]>();
  const unparsedLines: { line: number; text: string }[] = [];

  // Pass 2 — walk with a small state machine.
  let currentModel: string | null = null;
  // Non-model blocks (generator/datasource/enum) are skipped wholesale: their
  // bodies are `key = value` pairs or bare identifiers, neither of which is a
  // field, and neither should land in unparsedLines.
  let skippingBlock = false;
  let pendingDoc: { text: string; line: number }[] = [];

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? '';
    const text = raw.trim();
    const lineNo = i + 1;

    const block = BLOCK_RE.exec(raw);
    if (block?.groups) {
      const { keyword, name } = block.groups as { keyword: string; name: string };
      if (keyword === 'model' || keyword === 'view') {
        currentModel = name;
        models.set(name, []);
        skippingBlock = false;
      } else {
        currentModel = null;
        skippingBlock = true;
      }
      pendingDoc = [];
      continue;
    }

    if (text === '}') {
      currentModel = null;
      skippingBlock = false;
      pendingDoc = [];
      continue;
    }

    if (skippingBlock || currentModel === null) {
      pendingDoc = [];
      continue;
    }

    if (text.startsWith('///')) {
      pendingDoc.push({ text: text.slice(3).trim(), line: lineNo });
      continue;
    }
    // A plain `//` comment or a blank line detaches the doc block from whatever
    // follows, so an annotation can't drift onto an unrelated field.
    if (text === '' || text.startsWith('//')) {
      pendingDoc = [];
      continue;
    }
    if (text.startsWith('@@')) {
      pendingDoc = [];
      continue;
    }

    const fm = FIELD_RE.exec(raw);
    if (!fm?.groups) {
      unparsedLines.push({ line: lineNo, text });
      pendingDoc = [];
      continue;
    }

    const { name, type } = fm.groups as { name: string; type: string; attrs?: string };
    const attributes = fm.groups['attrs'] ?? '';
    const isList = type.includes('[]');
    const isOptional = type.endsWith('?');
    const baseType = type.replace('[]', '').replace(/\?$/, '');
    const kind = kindOf(baseType, type, modelNames, enums);

    const exemptions: Exemption[] = [];
    for (const d of pendingDoc) {
      const ex = parseExemption(d.text, d.line);
      if (ex) exemptions.push(ex);
    }

    const field: PrismaField = {
      model: currentModel,
      name,
      type,
      kind,
      family: kind === 'unsupported' ? 'unknown' : familyOf(baseType, enums),
      isId: /@id\b/.test(attributes),
      isList,
      isOptional,
      isForeignKey: false,
      attributes,
      docLines: pendingDoc.map((d) => d.text),
      exemptions,
      line: lineNo,
    };

    if (kind === 'unknown') unparsedLines.push({ line: lineNo, text });
    models.get(currentModel)?.push(field);
    pendingDoc = [];
  }

  // Back-fill isForeignKey now that each model's relation attributes are known.
  for (const fields of models.values()) {
    const fks = foreignKeysOf(fields);
    for (const f of fields) if (fks.has(f.name)) f.isForeignKey = true;
  }

  return { models, enums, unparsedLines };
}

/**
 * Fields the audit holds to the "must have a consumer" rule.
 *
 * Excluded, with reasons:
 * - relations: not columns; audited through their `fields: [...]` scalars.
 * - `@id`: identity, not a feature.
 * - foreign keys: auditable via the relation, and enormous grep noise.
 * - `createdAt`/`updatedAt`: bookkeeping convention. The ONLY name-based skip.
 * - `Unsupported`: absent from the generated client entirely (Prisma cannot
 *   select it), and `PresetVersion.embedding` appears UNQUOTED in raw SQL
 *   (`SET embedding = $1::vector`), so the quoted-identifier rule can't see it
 *   either. Auditing it would be theatre.
 * - Json: audited per discovered key instead, never as a whole column.
 */
export function isAuditableField(f: PrismaField): boolean {
  if (f.kind !== 'scalar') return false;
  if (f.isId || f.isForeignKey) return false;
  if (f.name === 'createdAt' || f.name === 'updatedAt') return false;
  if (f.family === 'json') return false;
  return true;
}

export function jsonFields(schema: PrismaSchema): PrismaField[] {
  return [...schema.models.values()].flat().filter((f) => f.family === 'json');
}

export function auditableFields(schema: PrismaSchema): PrismaField[] {
  return [...schema.models.values()].flat().filter(isAuditableField);
}
