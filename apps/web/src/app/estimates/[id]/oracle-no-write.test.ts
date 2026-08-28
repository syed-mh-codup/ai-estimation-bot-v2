import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * "No mutation of any estimate is reachable from Oracle" — AEH-259's last
 * acceptance criterion, which the ticket asks be asserted rather than trusted
 * to review. This is that assertion.
 *
 * The boundary is the feature. Oracle is a comprehension aid: it reads a
 * client's brief and everything derived from it, and it changes nothing. An
 * estimator has to be able to argue with it, tell it things, ask it to reword a
 * card — and know for certain that none of that moved a number in a document
 * going to a client. The moment one write path exists, that guarantee is gone
 * and no amount of prompt wording restores it.
 *
 * A grep is a blunt instrument and deliberately so: it cannot be argued with in
 * review, it costs nothing, and it fails loudly the day somebody adds a
 * convenient `prisma.menuItem.update` to "just fix this one thing".
 */

const HERE = dirname(fileURLToPath(import.meta.url));

function repoRoot(): string {
  let dir = HERE;
  for (let i = 0; i < 12; i += 1) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    dir = resolve(dir, '..');
  }
  throw new Error('Could not locate the repo root from the test file');
}

const ROOT = repoRoot();

/** Every file that is part of Oracle and could hold a write. */
const ORACLE_SOURCES = [
  'packages/agents/src/oracle.ts',
  'apps/web/src/lib/oracle-access.ts',
  'apps/web/src/lib/oracle-provider.ts',
  'apps/web/src/app/api/estimates/[id]/oracle/route.ts',
  'apps/web/src/app/estimates/[id]/oracle-actions.ts',
  'apps/web/src/app/estimates/[id]/oracle-dto.ts',
  'apps/web/src/app/estimates/[id]/Oracle.tsx',
  'apps/web/src/app/estimates/[id]/OracleAdminPanel.tsx',
  'apps/web/src/app/admin/oracle/page.tsx',
  'apps/web/src/app/admin/oracle/[threadId]/page.tsx',
];

/** The only two tables Oracle may write, and they are its own. */
const OWN_MODELS = new Set(['oracleThread', 'oracleMessage']);

const WRITE = /\b(?:prisma|db|tx)\.([A-Za-z]\w*)\.(create|createMany|update|updateMany|upsert|delete|deleteMany|executeRaw|executeRawUnsafe)\b/g;

function present(): { path: string; source: string }[] {
  return ORACLE_SOURCES.filter((p) => existsSync(join(ROOT, p))).map((path) => ({
    path,
    source: readFileSync(join(ROOT, path), 'utf8'),
  }));
}

describe('Oracle cannot mutate an estimate', () => {
  it('finds the files it is supposed to be checking', () => {
    // Guards the guard: a renamed file would silently empty this whole suite
    // and it would still pass.
    const found = present().map((f) => f.path);
    expect(found).toContain('packages/agents/src/oracle.ts');
    expect(found).toContain('apps/web/src/app/api/estimates/[id]/oracle/route.ts');
    expect(found.length).toBeGreaterThanOrEqual(6);
  });

  it('writes to nothing but its own thread and message tables', () => {
    const offences: string[] = [];

    for (const { path, source } of present()) {
      for (const match of source.matchAll(WRITE)) {
        const [, model, method] = match;
        if (!OWN_MODELS.has(model!)) offences.push(`${path}: ${model}.${method}`);
      }
    }

    expect(offences).toEqual([]);
  });

  it('does not import the estimate mutation actions', () => {
    // The other route to a write: calling the menu-card editor's server
    // actions instead of touching prisma directly.
    const offences = present()
      .filter(({ source }) => /from\s+'(?:\.{1,2}\/)*actions'/.test(source))
      .map((f) => f.path);

    expect(offences).toEqual([]);
  });

  it('exposes no estimate-mutating export from the Oracle action module', () => {
    const source = readFileSync(
      join(ROOT, 'apps/web/src/app/estimates/[id]/oracle-actions.ts'),
      'utf8',
    );
    const exported = [...source.matchAll(/export async function (\w+)/g)].map((m) => m[1]!);

    expect(exported.length).toBeGreaterThan(0);
    // Everything Oracle may do is to a thread of its own.
    for (const name of exported) expect(name).toMatch(/Thread/);
  });
});
