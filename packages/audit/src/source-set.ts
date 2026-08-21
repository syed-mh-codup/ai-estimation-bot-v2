import { readdirSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import ts from 'typescript';

/**
 * The TypeScript program the field audit reasons over.
 *
 * Scope is `apps/web/src` + `packages/<pkg>/src`, NOT `apps/web/src` alone as
 * AEH-228's text says. Measured reason: `PresetVersion.sourceMenuItemId` has
 * zero hits in apps/web but is the live promotion idempotency key in
 * packages/agents/src/writeback.ts, `TaxonomyNode.parentKey` is used only in
 * packages/db/src/seed-taxonomy.ts, and all 15 TaxonomyNode/TaxonomyNodeVersion
 * columns are backend-live (there is no admin taxonomy UI). Auditing against
 * apps/web alone would report those as orphans and push live fields onto the
 * exemption list — hiding the exact bug class the check exists to find.
 */
export interface SourceSet {
  program: ts.Program;
  checker: ts.TypeChecker;
  files: ts.SourceFile[];
  repoRoot: string;
}

const SKIP_DIRS = new Set([
  'node_modules',
  'generated',
  'dist',
  '.next',
  '.git',
  'e2e',
]);

function walk(dir: string, out: string[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      walk(full, out);
      continue;
    }
    if (!/\.tsx?$/.test(entry)) continue;
    if (/\.test\.tsx?$/.test(entry)) continue;
    if (/\.d\.ts$/.test(entry)) continue;
    out.push(full);
  }
}

export function collectSourceFilePaths(repoRoot: string): string[] {
  const roots = [join(repoRoot, 'apps', 'web', 'src')];
  const pkgDir = join(repoRoot, 'packages');
  for (const pkg of readdirSync(pkgDir)) {
    // The audit does not audit itself: its own fixtures name real field names.
    if (pkg === 'audit') continue;
    roots.push(join(pkgDir, pkg, 'src'));
  }
  const out: string[] = [];
  for (const r of roots) walk(r, out);
  return out.sort();
}

export function createSourceSet(repoRoot: string): SourceSet {
  const filePaths = collectSourceFilePaths(repoRoot);

  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    // Bundler resolution is the single choice that makes this repo's import
    // graph resolvable in one pass: extensionless `./foo`, `.js`-suffixed
    // specifiers that actually point at `.ts` files (packages/shared/src/index.ts
    // does this), and package `main` fields — without NodeNext's ESM strictness,
    // which would reject most of the above.
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    jsx: ts.JsxEmit.ReactJSX,
    strict: true,
    skipLibCheck: true,
    noEmit: true,
    esModuleInterop: true,
    allowJs: false,
    baseUrl: repoRoot,
    // Mirrors apps/web/tsconfig.json so `@/…` and `@repo/*` resolve.
    paths: {
      '@/*': ['apps/web/src/*'],
      '@repo/*': ['packages/*/src/index.ts'],
    },
    types: [],
  };

  const program = ts.createProgram(filePaths, options);
  const wanted = new Set(filePaths.map((p) => p.replace(/\\/g, '/')));
  const files = program
    .getSourceFiles()
    .filter((f) => wanted.has(f.fileName.replace(/\\/g, '/')));

  return { program, checker: program.getTypeChecker(), files, repoRoot };
}

export function repoRelative(repoRoot: string, fileName: string): string {
  return relative(repoRoot, fileName).split(sep).join('/');
}
