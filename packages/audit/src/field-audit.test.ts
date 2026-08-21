import { beforeAll, describe, expect, it } from 'vitest';
import { findRepoRoot } from './repo-root.js';
import { formatReport, runFieldAudit, type FieldAuditReport } from './field-audit.js';

/**
 * CI GATE 1 of AEH-228 — the orphan-field audit.
 *
 * A field or capability that exists on the backend must have a frontend
 * implementation, unless it is explicitly recorded as backend-only. This gate is
 * what makes that rule enforceable instead of aspirational.
 *
 * Run `pnpm audit:fields` for the full readable report when this fails.
 */
describe('AEH-228 gate 1: orphan-field audit', () => {
  let report: FieldAuditReport;

  beforeAll(() => {
    // Builds a ts.Program over ~114 files; the root vitest config sets no
    // testTimeout, so the 5s default would flake this.
    report = runFieldAudit({ repoRoot: findRepoRoot() });
  }, 180_000);

  it('parsed every line of schema.prisma', () => {
    // A field the parser skipped is a field this gate never checked.
    expect(report.diagnostics.unparsedSchemaLines).toEqual([]);
  });

  // The next two are canaries, and they matter as much as the assertion below.
  // If module resolution breaks, every receiver type becomes `any`, attribution
  // fails open for everything, and the gate reports zero orphans — passing
  // silently forever. That is the exact failure mode this ticket exists to stop,
  // so the audit's own health is asserted, not assumed.
  it('analysed the whole audited scope', () => {
    expect(report.diagnostics.filesAnalysed).toBeGreaterThan(100);
    expect(report.audited).toBeGreaterThan(80);
    expect(report.diagnostics.candidateReads).toBeGreaterThan(500);
  });

  it('resolved receiver types for nearly every candidate read', () => {
    expect(report.diagnostics.attributionResolvedRatio).toBeGreaterThan(0.8);
  });

  it('discovered the persisted keys of every written Json column', () => {
    const byId = new Map(
      report.diagnostics.jsonKeySources.map((s) => [s.id, s.keys] as const),
    );
    // The ticket's headline orphan lives inside MenuItem.meta, so a column-level
    // audit would miss it entirely. These two key sets are the proof that the
    // Json layer is actually being enumerated.
    expect(byId.get('MenuItem.meta')).toEqual([
      'notSafelyRemovable',
      'requirementIds',
      'thinSlice',
      'toggleable',
    ]);
    expect(byId.get('RoleLineItem.meta')).toEqual([
      'aiAssistApplied',
      'anchorPresetIds',
      'complexity',
      'dependsOn',
      'id',
      'requirementId',
    ]);
  });

  it('has no orphaned persisted fields and no stale exemptions', () => {
    expect(report.findings.map((f) => f.message)).toEqual([]);
  });

  it.skip('full report (unskip locally to read it)', () => {
    process.stdout.write(formatReport(report));
  });
});
