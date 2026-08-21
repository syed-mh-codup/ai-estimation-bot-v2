import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import { indexOccurrences, type AttributionTarget, type Verdict } from './occurrences.js';
import type { SourceSet } from './source-set.js';

/**
 * Classifier tests on synthetic in-memory sources.
 *
 * Deliberately NOT assertions against the real repo. The real-repo orphans are
 * about to be fixed by the AEH-228 follow-up work, and a permanent test must not
 * depend on a bug continuing to exist. These fixtures reproduce each rule's
 * shape, copied from the real site it was written for, so they keep testing the
 * detector after the codebase is clean.
 */

const ROOT = '/repo';

function sourceSetOf(files: Record<string, string>): SourceSet {
  const host = ts.createCompilerHost({}, true);
  const virtual = new Map(Object.entries(files).map(([k, v]) => [`${ROOT}/${k}`, v]));
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.ReactJSX,
    strict: true,
    skipLibCheck: true,
    noEmit: true,
  };
  const customHost: ts.CompilerHost = {
    ...host,
    fileExists: (f) => virtual.has(f) || host.fileExists(f),
    readFile: (f) => virtual.get(f) ?? host.readFile(f),
    getSourceFile: (f, lang, onError, shouldCreate) => {
      const text = virtual.get(f);
      if (text !== undefined) return ts.createSourceFile(f, text, lang, true);
      return host.getSourceFile(f, lang, onError, shouldCreate);
    },
  };
  const program = ts.createProgram([...virtual.keys()], options, customHost);
  const wanted = new Set(virtual.keys());
  return {
    program,
    checker: program.getTypeChecker(),
    files: program.getSourceFiles().filter((f) => wanted.has(f.fileName)),
    repoRoot: ROOT,
  };
}

/** The two colliding models that make attribution necessary. */
const TARGETS: AttributionTarget[] = [
  {
    id: 'PresetVersion',
    fieldNames: new Set(['id', 'name', 'notes', 'devHours', 'canParallel', 'userStoryTags', 'taxonomyKey']),
    families: new Map([
      ['notes', 'string'],
      ['canParallel', 'boolean'],
      ['userStoryTags', 'string'],
    ]),
  },
  {
    id: 'RoleLineItem',
    fieldNames: new Set(['id', 'menuItemId', 'title', 'baseHours', 'taxedHours', 'notes', 'edited']),
    families: new Map([['notes', 'string']]),
  },
];

/**
 * Verdicts for a field, excluding `type-decl`.
 *
 * The fixtures declare their receivers inline (`declare const x: { notes: string }`),
 * and those type members are legitimately recorded as `type-decl`. Filtering them
 * keeps each test about the rule it names; `type-decl` has its own test below.
 */
function verdicts(files: Record<string, string>, field: string): Verdict[] {
  const idx = indexOccurrences(sourceSetOf(files), new Set([field]), TARGETS);
  return (idx.byName.get(field) ?? [])
    .map((o) => o.verdict)
    .filter((v) => v !== 'type-decl');
}

function allVerdicts(files: Record<string, string>, field: string): Verdict[] {
  const idx = indexOccurrences(sourceSetOf(files), new Set([field]), TARGETS);
  return (idx.byName.get(field) ?? []).map((o) => o.verdict);
}

function only(files: Record<string, string>, field: string): Verdict | undefined {
  const v = verdicts(files, field);
  return v.length === 1 ? v[0] : undefined;
}

describe('AEH-228 classifiers', () => {
  it('R1: a bare identifier is never a read', () => {
    // architect.ts computes `notSafelyRemovable` as a local and then writes it.
    // Identifier scanning would call the write a read and lose ticket item 1.
    expect(
      verdicts({ 'a.ts': 'const canParallel = true; export const o = { canParallel: !canParallel };' }, 'canParallel'),
    ).toEqual(['write']);
  });

  it('R2: an object-literal property name is a write, even with a computed value', () => {
    expect(only({ 'a.ts': 'declare const x: boolean; export const o = { canParallel: !x };' }, 'canParallel')).toBe('write');
  });

  it('R2: a type/zod member declaration is a declaration, not a read', () => {
    expect(allVerdicts({ 'a.ts': 'export interface I { notes: string }' }, 'notes')).toEqual(['type-decl']);
  });

  it('R3: carry-forward — the plain identity copy', () => {
    expect(
      verdicts({ 'a.ts': 'declare const carry: { notes?: string }; export const o = { notes: carry?.notes ?? "" };' }, 'notes'),
    ).toEqual(['write', 'carry-forward']);
  });

  it('R3: carry-forward — form value falling back to the stored value', () => {
    // admin/presets/[id]/page.tsx: notes: (formData.get('notes') as string) ?? active.notes
    expect(
      verdicts(
        { 'a.ts': 'declare const active: { notes: string }; declare const f: { get(k: string): unknown }; export const o = { notes: (f.get("notes") as string) ?? active.notes };' },
        'notes',
      ),
    ).toEqual(['write', 'carry-forward']);
  });

  it('R3: carry-forward — a different source field falling back to the same one', () => {
    // refinement.ts: notes: tweak.newNotes ?? li.notes
    expect(
      verdicts(
        { 'a.ts': 'declare const tweak: { newNotes?: string }; declare const li: { notes: string }; export const o = { notes: tweak.newNotes ?? li.notes };' },
        'notes',
      ),
    ).toEqual(['write', 'carry-forward']);
  });

  it('R3: does NOT fire when the value goes somewhere other than a same-named field', () => {
    // sheets-export.ts: rows.push([… li.notes ?? ''])
    expect(
      verdicts({ 'a.ts': 'declare const li: { notes: string }; declare const rows: string[][]; rows.push([li.notes ?? ""]);' }, 'notes'),
    ).toEqual(['read']);
  });

  it('R4: reading off a local const object map is not consuming the column', () => {
    // seed-presets.ts: const COL = {…} as const; row[COL.userStoryTags]
    expect(
      verdicts({ 'a.ts': 'const COL = { userStoryTags: 10 } as const; export const v = COL.userStoryTags;' }, 'userStoryTags'),
    ).toEqual(['write', 'const-object']);
  });

  it('R5: form echo — a value read only to seed a control that writes it back', () => {
    expect(
      verdicts(
        { 'a.tsx': 'declare const active: { notes: string }; export const E = () => <textarea name="notes" defaultValue={active.notes} />;' },
        'notes',
      ),
    ).toEqual(['form-echo']);
  });

  it('R5: form echo also matches on id=', () => {
    expect(
      verdicts(
        { 'a.tsx': 'declare const a: { canParallel: boolean }; export const E = () => <input id="canParallel" defaultChecked={a.canParallel} />;' },
        'canParallel',
      ),
    ).toEqual(['form-echo']);
  });

  it('R5: a value rendered as content is a real read, not an echo', () => {
    expect(
      verdicts({ 'a.tsx': 'declare const a: { notes: string }; export const E = () => <p>{a.notes}</p>;' }, 'notes'),
    ).toEqual(['read']);
  });

  it('R6: a where key is a consumer, a select key is not', () => {
    expect(
      only({ 'a.ts': 'declare const db: { f(a: unknown): void }; db.f({ where: { notes: "x" } });' }, 'notes'),
    ).toBe('query-read');
    expect(
      only({ 'a.ts': 'declare const db: { f(a: unknown): void }; db.f({ select: { notes: true } });' }, 'notes'),
    ).toBe('projection');
  });

  it('R7: a column named in raw SQL is a consumer', () => {
    expect(
      verdicts({ 'a.ts': 'declare const db: { $queryRaw(s: string): void }; db.$queryRaw(`SELECT "notes" FROM "PresetVersion"`);' }, 'notes'),
    ).toContain('query-read');
  });

  it('destructuring is a read', () => {
    expect(
      verdicts({ 'a.ts': 'declare const row: { notes: string }; const { notes } = row; export { notes };' }, 'notes'),
    ).toEqual(['read']);
  });

  describe('attribution resolves same-named fields on different models', () => {
    it('picks the model the receiver structurally matches', () => {
      const files = {
        'a.ts':
          'declare const li: { menuItemId: string; title: string; baseHours: number; taxedHours: number; notes: string };' +
          'declare const rows: string[][]; rows.push([li.notes]);',
      };
      const idx = indexOccurrences(sourceSetOf(files), new Set(['notes']), TARGETS);
      const occ = (idx.byName.get('notes') ?? []).find((o) => o.verdict !== 'type-decl');
      expect(occ?.verdict).toBe('read');
      expect(occ?.attributedTo).toEqual(['RoleLineItem']);
    });

    it('reports full resolution when receiver types are known', () => {
      const files = { 'a.ts': 'declare const li: { notes: string; menuItemId: string; title: string; baseHours: number }; export const v = li.notes;' };
      const idx = indexOccurrences(sourceSetOf(files), new Set(['notes']), TARGETS);
      expect(idx.stats.attributionResolvedRatio).toBe(1);
    });
  });
});
