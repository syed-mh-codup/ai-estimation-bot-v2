import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

/**
 * Zero-caller export check: runs knip and diffs it against a checked-in baseline.
 *
 * A baseline rather than knip's own `tags`/ignore features, because those can
 * suppress a finding but cannot fail when the suppression goes stale — and
 * "a stale exemption must also fail the build" is half of what AEH-228 asks for.
 *
 * knip MUST be run in production mode. See knip.jsonc for why in full; the short
 * version is that test files otherwise count as callers and no `project`
 * negation or `ignore` entry removes them from the import graph.
 */

export interface KnipEntry {
  file: string;
  /** 'exports' | 'types' | 'nsExports' | 'nsTypes' | 'enumMembers' */
  type: string;
  name: string;
}

export interface BaselineEntry extends KnipEntry {
  reason?: string;
  ticket?: string;
}

/** Issue types knip reports per file that this check tracks. */
const ISSUE_TYPES = ['exports', 'types', 'nsExports', 'nsTypes', 'enumMembers'] as const;

const MIN_REASON_LENGTH = 12;
const TICKET_RE = /^AEH-\d+$/;

export const BASELINE_PATH = 'packages/audit/knip-baseline.json';

export function keyOf(e: KnipEntry): string {
  return `${e.type} ${e.file}#${e.name}`;
}

/**
 * knip prints a preamble to stdout before the JSON, and that preamble itself
 * contains an unquoted brace:
 *   ◇ injected env (12) from apps/web/.env.local // tip: … { path: '…/.env' }
 * so slicing from the first `{` does NOT work. Anchor on the payload key.
 *
 * Line/col/pos are deliberately discarded: baseline keys must survive unrelated
 * edits, or every refactor churns the file.
 */
export function parseKnipJson(raw: string): KnipEntry[] {
  const at = raw.indexOf('{"issues":');
  if (at === -1) {
    throw new Error(
      `unrecognised knip output: no {"issues":…} payload found. First 200 chars: ${raw.slice(0, 200)}`,
    );
  }
  const parsed: unknown = JSON.parse(raw.slice(at));
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !Array.isArray((parsed as { issues?: unknown }).issues)
  ) {
    throw new Error('unrecognised knip output: `issues` is not an array');
  }
  const issues = (parsed as { issues: unknown[] }).issues;
  const out: KnipEntry[] = [];
  for (const issue of issues) {
    if (typeof issue !== 'object' || issue === null) continue;
    const rec = issue as Record<string, unknown>;
    const file = typeof rec['file'] === 'string' ? rec['file'] : null;
    if (!file) continue;
    for (const type of ISSUE_TYPES) {
      const items = rec[type];
      if (!Array.isArray(items)) continue;
      for (const item of items) {
        const name =
          typeof item === 'string'
            ? item
            : typeof (item as { name?: unknown })?.name === 'string'
              ? (item as { name: string }).name
              : null;
        if (name) out.push({ file: file.replace(/\\/g, '/'), type, name });
      }
    }
  }
  return out;
}

export function runKnip(repoRoot: string): KnipEntry[] {
  const bin = join(repoRoot, 'node_modules', '.bin', 'knip');
  // Throw, never skip. A check that quietly disables itself is the exact
  // failure mode this ticket exists to prevent.
  if (!existsSync(bin)) {
    throw new Error(`knip is not installed at ${bin} — run \`pnpm install\``);
  }
  const res = spawnSync(bin, ['--production', '--reporter', 'json', '--no-progress'], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, NO_COLOR: '1', CI: '1' },
  });
  // knip exits 1 when it has findings; the gate is the comparator, not the code.
  if (res.status !== 0 && res.status !== 1) {
    throw new Error(
      `knip failed (status=${String(res.status)}, signal=${String(res.signal)}):\n${res.stderr ?? ''}`,
    );
  }
  return parseKnipJson(res.stdout ?? '');
}

export function loadBaseline(repoRoot: string): BaselineEntry[] {
  const path = join(repoRoot, BASELINE_PATH);
  if (!existsSync(path)) return [];
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  const entries = (parsed as { entries?: unknown })?.entries;
  return Array.isArray(entries) ? (entries as BaselineEntry[]) : [];
}

export interface BaselineDiff {
  /** knip reports it, the baseline does not: a new zero-caller export. */
  added: KnipEntry[];
  /** The baseline lists it, knip no longer reports it: now called, or deleted. */
  stale: BaselineEntry[];
  /** Baseline entry without a usable reason or ticket. */
  malformed: BaselineEntry[];
}

export function diffBaseline(found: KnipEntry[], baseline: BaselineEntry[]): BaselineDiff {
  const foundKeys = new Set(found.map(keyOf));
  const baseKeys = new Set(baseline.map(keyOf));
  return {
    added: found.filter((e) => !baseKeys.has(keyOf(e))),
    stale: baseline.filter((e) => !foundKeys.has(keyOf(e))),
    malformed: baseline.filter(
      (e) =>
        (e.reason ?? '').trim().length < MIN_REASON_LENGTH ||
        (e.ticket !== undefined && !TICKET_RE.test(e.ticket)),
    ),
  };
}

export function formatKnipDiff(d: BaselineDiff): string {
  const lines: string[] = [];
  if (d.malformed.length > 0) {
    lines.push(`${d.malformed.length} baseline entry/entries without a usable reason or ticket:`);
    for (const e of d.malformed) lines.push(`  ${keyOf(e)}  reason=${JSON.stringify(e.reason ?? null)}`);
    lines.push('');
  }
  if (d.added.length > 0) {
    lines.push(`${d.added.length} export(s) with no non-test caller and no baseline entry:`);
    for (const e of d.added) lines.push(`  ${keyOf(e)}`);
    lines.push(
      '',
      '  Either delete the export, wire it to a real caller, or add it to',
      `  ${BASELINE_PATH} with a reason (and a ticket, if it is debt).`,
      '',
    );
  }
  if (d.stale.length > 0) {
    lines.push(`${d.stale.length} stale baseline entry/entries (now called, or deleted):`);
    for (const e of d.stale) lines.push(`  ${keyOf(e)}`);
    lines.push('', `  Remove them from ${BASELINE_PATH}.`, '');
  }
  return lines.join('\n');
}
