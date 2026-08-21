import { beforeAll, describe, expect, it } from 'vitest';
import { findRepoRoot } from './repo-root.js';
import {
  diffBaseline,
  keyOf,
  loadBaseline,
  parseKnipJson,
  runKnip,
  type BaselineDiff,
} from './knip-baseline.js';

/**
 * CI GATE 2 of AEH-228 — the zero-caller export check.
 *
 * `promoteMenuItemsToPresets` sat in the tree as a complete, unit-tested feedback
 * loop with no production caller for months. This gate is what would have said so
 * on day one.
 *
 * Run `pnpm audit:exports` for the readable report when this fails.
 */
describe('AEH-228 gate 2: zero-caller export check', () => {
  let diff: BaselineDiff;

  beforeAll(() => {
    const repoRoot = findRepoRoot();
    // Throws rather than skipping if knip is missing or crashes: a check that
    // quietly disables itself is worse than no check.
    diff = diffBaseline(runKnip(repoRoot), loadBaseline(repoRoot));
  }, 300_000);

  it('every baseline entry carries a real reason and a well-formed ticket', () => {
    expect(diff.malformed.map(keyOf)).toEqual([]);
  });

  it('has no exports without a non-test caller', () => {
    expect(diff.added.map(keyOf)).toEqual([]);
  });

  it('has no stale baseline entries (now called, or deleted)', () => {
    // Anti-rot: an exemption that is no longer needed must fail just as loudly
    // as a new orphan, or the baseline slowly becomes a lie.
    expect(diff.stale.map(keyOf)).toEqual([]);
  });
});

/**
 * Format canary for knip's JSON output.
 *
 * The live gate above guards the CONFIG; this guards the PARSER. A knip upgrade
 * that changes the payload shape would otherwise make the gate silently report
 * zero findings.
 */
describe('knip JSON parser', () => {
  const FIXTURE = JSON.stringify({
    issues: [
      {
        file: 'packages/x/src/a.ts',
        exports: [{ name: 'foo', line: 3, col: 1, pos: 40 }],
        types: [{ name: 'Bar', line: 9, col: 1, pos: 120 }],
        nsExports: [],
      },
    ],
  });

  it('flattens exports and types, and drops line/col/pos', () => {
    // Positions are discarded on purpose: baseline keys must survive unrelated
    // edits, or every refactor churns the baseline file.
    expect(parseKnipJson(FIXTURE)).toEqual([
      { file: 'packages/x/src/a.ts', type: 'exports', name: 'foo' },
      { file: 'packages/x/src/a.ts', type: 'types', name: 'Bar' },
    ]);
  });

  it('tolerates the preamble knip prints before the JSON', () => {
    // knip writes a line like:
    //   ◇ injected env (12) from apps/web/.env.local // tip: … { path: '…/.env' }
    // whose own unquoted brace defeats "slice from the first {".
    const noisy = `◇ injected env (12) from apps/web/.env.local // tip: { path: '/x/.env' }\n${FIXTURE}`;
    expect(parseKnipJson(noisy)).toHaveLength(2);
  });

  it('throws on a shape it does not recognise', () => {
    expect(() => parseKnipJson('{"results":[]}')).toThrow(/unrecognised knip output/i);
    expect(() => parseKnipJson('not json at all')).toThrow(/unrecognised knip output/i);
  });
});
