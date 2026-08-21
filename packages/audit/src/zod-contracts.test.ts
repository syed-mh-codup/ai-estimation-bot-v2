import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import { indexOccurrences } from './occurrences.js';
import type { SourceSet } from './source-set.js';
import { auditContractFields, discoverZodFields } from './zod-contracts.js';

/**
 * Contract-field audit, on synthetic sources.
 *
 * The rule under test is deliberately strict — "referenced nowhere outside its
 * own declaration" — because zod schemas here are LLM I/O contracts that get
 * serialised whole into prompts, so a per-field read check would flag dozens of
 * fields the model genuinely consumes. These fixtures pin both halves: the clean
 * orphan IS caught, and a field referenced in any way is NOT.
 */

const ROOT = '/repo';

function sourceSetOf(files: Record<string, string>): SourceSet {
  const host = ts.createCompilerHost({}, true);
  const virtual = new Map(Object.entries(files).map(([k, v]) => [`${ROOT}/${k}`, v]));
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
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

function audit(files: Record<string, string>) {
  const src = sourceSetOf(files);
  const fields = discoverZodFields(src);
  const index = indexOccurrences(src, new Set(fields.map((f) => f.field)), []);
  return { fields, findings: auditContractFields(fields, index) };
}

const SCHEMA = `import { z } from 'zod';
export const InputSchema = z.object({
  used: z.string(),
  neverReferenced: z.array(z.string()).optional(),
});
`;
const ZOD_STUB = {
  'zod.ts': 'export const z = { object: (s: unknown) => s, string: () => 0, array: (x: unknown) => x, number: () => 0 } as never;',
};

describe('AEH-228 gate 3: contract-field audit', () => {
  it('discovers zod object fields with their schema name', () => {
    const { fields } = audit({ 'schemas.ts': SCHEMA, ...ZOD_STUB });
    expect(fields.map((f) => f.id).sort()).toEqual([
      'InputSchema.neverReferenced',
      'InputSchema.used',
    ]);
  });

  it('flags a field referenced nowhere outside its declaration', () => {
    const { findings } = audit({
      'schemas.ts': SCHEMA,
      'app.ts': `import type {} from './schemas.js'; declare const i: { used: string }; export const v = i.used;`,
      ...ZOD_STUB,
    });
    expect(findings.map((f) => f.id)).toEqual(['InputSchema.neverReferenced']);
  });

  it('does NOT flag a field referenced anywhere at all', () => {
    // The rule under-reports on purpose: a schema serialised whole into a prompt
    // has no per-field read, so any reference is treated as enough.
    const { findings } = audit({
      'schemas.ts': SCHEMA,
      'app.ts': `export const payload = { neverReferenced: ['x'], used: 'y' };`,
      ...ZOD_STUB,
    });
    expect(findings).toEqual([]);
  });

  it('a @backend-only JSDoc on the field suppresses the finding', () => {
    const { findings } = audit({
      'schemas.ts': `import { z } from 'zod';
export const S = z.object({
  /** @backend-only shape the model returns, never read by us */
  ghost: z.string(),
});
`,
      ...ZOD_STUB,
    });
    expect(findings).toEqual([]);
  });

  it('an @orphan-todo with no ticket is malformed', () => {
    const { findings } = audit({
      'schemas.ts': `import { z } from 'zod';
export const S = z.object({
  /** @orphan-todo we will wire this up later on */
  ghost: z.string(),
});
`,
      ...ZOD_STUB,
    });
    expect(findings.map((f) => f.kind)).toEqual(['malformed-contract-annotation']);
  });

  it('an annotation on a field that IS referenced is stale', () => {
    const { findings } = audit({
      'schemas.ts': `import { z } from 'zod';
export const S = z.object({
  /** @backend-only shape the model returns, never read by us */
  ghost: z.string(),
});
`,
      'app.ts': `export const p = { ghost: 'now used' };`,
      ...ZOD_STUB,
    });
    expect(findings.map((f) => f.kind)).toEqual(['stale-contract-exemption']);
  });

  it('a field declared in two schemas is not kept alive by the other declaration', () => {
    const { findings } = audit({
      'schemas.ts': `import { z } from 'zod';
export const A = z.object({ shared: z.string() });
export const B = z.object({ shared: z.string() });
`,
      ...ZOD_STUB,
    });
    expect(findings.map((f) => f.id).sort()).toEqual(['A.shared', 'B.shared']);
  });
});
