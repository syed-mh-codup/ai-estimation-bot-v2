/**
 * Local triage entry point for both AEH-228 gates.
 *
 *   pnpm audit:fields    # orphan-field audit report
 *   pnpm audit:exports   # zero-caller export report
 *   pnpm audit           # both
 *
 * The gates themselves are vitest tests (field-audit.test.ts,
 * knip-baseline.test.ts) so they block CI through the existing `pnpm test` step
 * with no workflow change. This CLI exists because a failing gate needs a
 * readable full report, which a test assertion is a poor place to render.
 */
import { findRepoRoot } from './repo-root.js';
import { formatReport, runFieldAudit } from './field-audit.js';
import { diffBaseline, formatKnipDiff, loadBaseline, runKnip } from './knip-baseline.js';

function fields(repoRoot: string): number {
  const report = runFieldAudit({ repoRoot });
  process.stdout.write(formatReport(report));
  return report.findings.length > 0 ? 1 : 0;
}

function exports_(repoRoot: string): number {
  const diff = diffBaseline(runKnip(repoRoot), loadBaseline(repoRoot));
  const text = formatKnipDiff(diff);
  process.stdout.write(
    text.trim().length > 0 ? `zero-caller export check\n\n${text}\n` : 'zero-caller export check: clean\n',
  );
  return diff.added.length + diff.stale.length + diff.malformed.length > 0 ? 1 : 0;
}

const mode = process.argv[2] ?? 'all';
const repoRoot = findRepoRoot();
let code = 0;
if (mode === 'fields') code = fields(repoRoot);
else if (mode === 'exports') code = exports_(repoRoot);
else if (mode === 'all') {
  code = fields(repoRoot);
  process.stdout.write('\n');
  code = exports_(repoRoot) || code;
} else {
  process.stderr.write(`usage: cli.ts [fields|exports|all]\n`);
  code = 2;
}
process.exit(code);
