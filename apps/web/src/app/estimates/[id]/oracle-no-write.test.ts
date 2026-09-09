import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * "No mutation of any estimate is reachable from Oracle" — AEH-259's last
 * acceptance criterion, NARROWED by AEH-238. This file is where that narrowing
 * is written down, because a guarantee that quietly weakens is worse than one
 * that never existed.
 *
 * What AEH-259 asserted, and why: Oracle is a comprehension aid. It reads a
 * client's brief and everything derived from it and changes nothing, so an
 * estimator can argue with it, tell it things and ask it to reword a card
 * knowing that none of it moved a number in a document going to a client. The
 * original comment here said the moment ONE write path exists the guarantee is
 * gone and no prompt wording restores it.
 *
 * What AEH-238 changed, deliberately and with the reporter's agreement: Oracle
 * proposes assumptions, and retyping one by hand was friction with no purpose.
 * It may now append an assumption — one sentence, added to a list, and only
 * when a person clicks. It still cannot touch an hour, a line item, a card or
 * the estimate row itself.
 *
 * So the guarantee this file now enforces is the half that was protecting
 * anybody: NO NUMBER A CLIENT SEES CAN MOVE BECAUSE OF ORACLE. That is
 * checkable, and the cases below check it precisely — the allowed write is
 * named, it is confined to one module, and that module is asserted to be one
 * function wide. Anything else still fails.
 *
 * A grep is a blunt instrument and deliberately so: it cannot be argued with in
 * review, it costs nothing, and it still fails loudly the day somebody adds a
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
  // The one module Oracle may reach that writes anything. In the list so its
  // contents are checked, not exempt from checking.
  'apps/web/src/app/estimates/[id]/statement-actions.ts',
  'apps/web/src/app/admin/oracle/page.tsx',
  'apps/web/src/app/admin/oracle/[threadId]/page.tsx',
];

/**
 * Everything Oracle may write.
 *
 * The first two are its own. `estimateStatement` is AEH-238's one addition, and
 * it is the narrowest write in the system: a sentence appended to a list, which
 * changes no hours, no cards and no totals. Note what is NOT here and must
 * never be — `menuItem`, `roleLineItem`, `estimate`, `ledgerEdit`.
 */
const OWN_MODELS = new Set(['oracleThread', 'oracleMessage', 'estimateStatement']);

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

  it('keeps the one allowed write to a single function in a single module', () => {
    // The narrowing is only safe while it stays narrow. A second export here,
    // or a write to anything but EstimateStatement, is the thing this catches.
    const path = 'apps/web/src/app/estimates/[id]/statement-actions.ts';
    const source = readFileSync(join(ROOT, path), 'utf8');

    const exported = [...source.matchAll(/export async function (\w+)/g)].map((m) => m[1]!);
    expect(exported).toEqual(['recordSuggestedAssumption']);

    // It may read the estimate to check it is not finalised; it may write only
    // a statement. `appendStatement` is the @repo/db helper it goes through.
    const writes = [...source.matchAll(WRITE)].map((m) => `${m[1]}.${m[2]}`);
    expect(writes).toEqual([]);
    expect(source).toContain('appendStatement');
    expect(source).toContain("kind: 'ASSUMPTION'");
  });

  it('does not let Oracle reach any OTHER server-action module', () => {
    // `actions` is checked above by name; this is the general form, so a new
    // `card-actions` or `scope-actions` cannot be imported quietly.
    const allowed = new Set(['./statement-actions', './oracle-actions', './oracle-dto']);
    const offences: string[] = [];
    for (const { path, source } of present()) {
      for (const m of source.matchAll(/from\s+'(\.\/[a-z-]*actions)'/g)) {
        if (!allowed.has(m[1]!)) offences.push(`${path}: ${m[1]}`);
      }
    }
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
