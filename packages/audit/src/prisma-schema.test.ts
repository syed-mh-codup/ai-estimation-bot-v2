import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findRepoRoot } from './repo-root.js';
import {
  auditableFields,
  isAuditableField,
  jsonFields,
  parsePrismaSchema,
  type PrismaSchema,
} from './prisma-schema.js';

const repoRoot = findRepoRoot();
const schema: PrismaSchema = parsePrismaSchema(
  readFileSync(join(repoRoot, 'packages/db/prisma/schema.prisma'), 'utf8'),
);

describe('AEH-228: prisma schema parser', () => {
  it('reads every line of every model block', () => {
    // Not a smoke test. A field the parser silently skips is a field the audit
    // never checks, which is the failure class AEH-228 exists to prevent.
    expect(schema.unparsedLines).toEqual([]);
  });

  it('finds all models and enums', () => {
    // 17 models / 13 enums since AEH-259 added OracleThread, OracleMessage and
    // OracleRole on top of AEH-263's HiddenWorkFinding, HiddenWorkOutcome and
    // TaxonomyStatus.
    expect(schema.models.size).toBe(17);
    expect(schema.enums.size).toBe(13);
  });

  it('classifies relations, foreign keys and scalars apart', () => {
    const est = schema.models.get('Estimate') ?? [];
    const owner = est.find((f) => f.name === 'owner');
    const ownerId = est.find((f) => f.name === 'ownerId');
    expect(owner?.kind).toBe('relation');
    expect(isAuditableField(owner!)).toBe(false);
    expect(ownerId?.kind).toBe('scalar');
    expect(ownerId?.isForeignKey).toBe(true);
    expect(isAuditableField(ownerId!)).toBe(false);
  });

  it('excludes the Unsupported vector column', () => {
    const embedding = schema.models
      .get('PresetVersion')
      ?.find((f) => f.name === 'embedding');
    expect(embedding?.kind).toBe('unsupported');
    expect(isAuditableField(embedding!)).toBe(false);
  });

  it('finds every Json column and excludes them from column-level auditing', () => {
    const ids = jsonFields(schema).map((f) => `${f.model}.${f.name}`);
    expect(ids).toEqual([
      'EstimationConfig.complexityRules',
      'EstimationConfig.infraBaseline',
      'Estimate.agentState',
      'MenuItem.meta',
      'RoleLineItem.meta',
    ]);
    for (const f of jsonFields(schema)) expect(isAuditableField(f)).toBe(false);
  });

  it('keeps ordinary scalars auditable, including enums and lists', () => {
    const pv = schema.models.get('PresetVersion') ?? [];
    const notes = pv.find((f) => f.name === 'notes');
    const keywords = pv.find((f) => f.name === 'keywords');
    const phase = pv.find((f) => f.name === 'phase');
    expect([notes?.family, keywords?.isList, phase?.family]).toEqual(['string', true, 'enum']);
    for (const f of [notes, keywords, phase]) expect(isAuditableField(f!)).toBe(true);
    expect(auditableFields(schema).length).toBeGreaterThan(80);
  });

  describe('exemption grammar', () => {
    const parse = (doc: string) => {
      const s = parsePrismaSchema(`model M {\n${doc}\n  x String\n}\n`);
      return s.models.get('M')?.find((f) => f.name === 'x')?.exemptions ?? [];
    };

    it('accepts a well-formed @backend-only', () => {
      const [ex] = parse('  /// @backend-only pgvector column, raw SQL only');
      expect(ex).toMatchObject({
        kind: 'backend-only',
        jsonKey: null,
        malformed: false,
      });
    });

    it('accepts a well-formed @orphan-todo and extracts its ticket', () => {
      const [ex] = parse('  /// @orphan-todo AEH-999 never wired to the editor DTO');
      expect(ex).toMatchObject({ kind: 'orphan-todo', ticket: 'AEH-999', malformed: false });
    });

    it('rejects an @orphan-todo with no ticket', () => {
      expect(parse('  /// @orphan-todo never wired to the editor')[0]?.malformed).toBe(true);
    });

    it('rejects a rubber-stamp reason', () => {
      expect(parse('  /// @backend-only wip')[0]?.malformed).toBe(true);
    });

    it('targets a single Json key', () => {
      expect(parse('  /// @backend-only:thinSlice pipeline-internal marker')[0]).toMatchObject({
        jsonKey: 'thinSlice',
        malformed: false,
      });
    });

    it('does not let a blank line or plain comment carry an annotation onto the next field', () => {
      expect(parse('  /// @backend-only a perfectly good reason\n  // plain comment')).toEqual([]);
      expect(parse('  /// @backend-only a perfectly good reason\n')).toEqual([]);
    });

    it('ignores prose doc comments', () => {
      expect(parse('  /// LEGACY, nullable, no longer written.')).toEqual([]);
    });
  });
});
