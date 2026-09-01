import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * The secrets these scripts need live in different files (DATABASE_URL in
 * packages/db/.env, the API keys and Google credentials in
 * apps/web/.env.local), and tsx loads neither. Read both, never overwriting
 * anything already in the environment.
 */
export function loadEnvFiles(): void {
  const repoRoot = path.resolve(__dirname, '../../../..');
  const files = [path.join(repoRoot, 'packages/db/.env'), path.join(repoRoot, 'apps/web/.env.local')];
  for (const file of files) {
    let contents: string;
    try {
      contents = readFileSync(file, 'utf8');
    } catch {
      continue; // Missing is fine — each script reports what's actually absent.
    }
    for (const line of contents.split('\n')) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!m?.[1]) continue;
      const value = m[2]!.replace(/^["']|["']$/g, '');
      // A blank assignment is a placeholder, not a value (the repo root .env
      // deliberately blanks OPENROUTER_API_KEY and the Google credentials).
      if (value && !process.env[m[1]]) process.env[m[1]] = value;
    }
  }
}
