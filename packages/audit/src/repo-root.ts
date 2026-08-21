import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * Walk up to the workspace root.
 *
 * Necessary because cwd differs by runner: the repo root under root-level
 * vitest, but packages/audit under `pnpm --filter`. Deliberately avoids
 * `__dirname`/`import.meta.url`, since these files run under both esbuild-ESM
 * (vitest) and tsx.
 */
export function findRepoRoot(start: string = process.cwd()): string {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(`could not find pnpm-workspace.yaml above ${start}`);
    }
    dir = parent;
  }
}
