import { beforeAll, describe, expect, it } from 'vitest';
import { findRepoRoot } from './repo-root.js';
import {
  formatEstimateReadReport,
  runEstimateReadAudit,
  type EstimateReadAudit,
} from './estimate-reads.js';

/**
 * AEH-375 gate — no read of Estimate forgets that estimates can be deleted.
 *
 * Soft delete's only real failure is a read path nobody remembered. There is
 * no exception, no failing test and no error log; a deleted estimate simply
 * keeps showing up somewhere, and the first person to notice is the one who
 * deleted it. This gate enumerates the call sites so that a new one has to be
 * decided rather than merely written.
 *
 * Run `pnpm audit:deleted` for the readable report when this fails.
 */
describe('AEH-375 gate: estimate reads exclude deleted rows', () => {
  let audit: EstimateReadAudit;

  beforeAll(() => {
    audit = runEstimateReadAudit({ repoRoot: findRepoRoot() });
  }, 120_000);

  // ── Canaries. ──────────────────────────────────────────────────────────────
  //
  // These matter as much as the assertion below, and the field audit learned it
  // the hard way: a scanner that silently stops finding anything reports zero
  // problems and passes forever. Every number here is a floor the scanner has
  // to clear before its verdict means anything.

  it('scanned the repo and found the estimate reads', () => {
    expect(audit.diagnostics.filesScanned).toBeGreaterThan(150);
    expect(audit.reads.length).toBeGreaterThan(35);
  });

  it('recognised both ways a read can be accounted for', () => {
    // If either of these hit zero the classifier has broken in one direction
    // and the gate is measuring nothing.
    expect(audit.reads.filter((r) => r.filtered).length).toBeGreaterThan(15);
    expect(audit.reads.filter((r) => !r.filtered && r.excused).length).toBeGreaterThan(10);
  });

  it('sees nested relation reads, not just top-level queries', () => {
    // `include: { children: {…} }` is a second read of Estimate inside an
    // Estimate query, and it is how a deleted fork nearly stayed in the forks
    // rail. A scanner blind to it would have passed that leak.
    expect(audit.diagnostics.nestedReads).toBeGreaterThan(0);
  });

  it('reads the where clause, not merely the call', () => {
    // A positive control on three sites that MUST be filtered. If the `where`
    // parser breaks these flip to unfiltered and the gate fails loudly, rather
    // than every read looking excused because the text went missing.
    const filteredIn = (needle: string): boolean =>
      audit.reads.some((r) => r.file.includes(needle) && r.filtered);
    expect(filteredIn('app/dashboard/page.tsx')).toBe(true);
    expect(filteredIn('lib/reminders.ts')).toBe(true);
    expect(filteredIn('lineage-actions.ts')).toBe(true);
  });

  it('reads the excuse tag, not merely the absence of a filter', () => {
    // The counterpart control: recovery has to see deleted estimates, and says
    // so. An excuse with no reason after it is a tag somebody pasted.
    const recovery = audit.reads.filter(
      (r) => r.file.includes('delete-actions.ts') && r.excused,
    );
    expect(recovery.length).toBeGreaterThan(0);
    for (const r of recovery) expect(r.reason.length).toBeGreaterThan(10);
  });

  // ── The gate. ──────────────────────────────────────────────────────────────

  it('every read either excludes deleted estimates or says why not', () => {
    expect(audit.unguarded, formatEstimateReadReport(audit)).toEqual([]);
  });

  it('every excused read gives a reason', () => {
    const silent = audit.reads
      .filter((r) => r.excused && r.reason.length < 10)
      .map((r) => `${r.file}:${r.line}`);
    expect(silent, 'a @deleted-ok with no reason after it explains nothing').toEqual([]);
  });
});
