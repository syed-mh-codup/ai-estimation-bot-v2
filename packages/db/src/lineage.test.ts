import { describe, expect, it } from 'vitest';

import { familiesOf, familyIds, projectNameOf, rootOf } from './lineage';

/**
 * AEH-236. Grouping estimates into projects.
 *
 * Pure functions over a list, so the dashboard's whole grouping rule is pinned
 * here without a database. The cases that matter are the damaged ones: a parent
 * deleted out from under a child, a family whose root is gone, and a cycle that
 * only a bad UPDATE could create — because those are what turn a grouping bug
 * into a hung dashboard rather than a slightly odd row.
 */

const n = (id: string, parentId: string | null, title = id, projectName: string | null = null) => ({
  id,
  parentId,
  title,
  projectName,
});

describe('rootOf', () => {
  it('is the estimate itself when nothing was forked', () => {
    const nodes = [n('a', null)];
    expect(rootOf(nodes, 'a')?.id).toBe('a');
  });

  it('walks a chain to its start', () => {
    const nodes = [n('a', null), n('b', 'a'), n('c', 'b')];
    expect(rootOf(nodes, 'c')?.id).toBe('a');
  });

  it('stops at a parent that is not in the list', () => {
    // Honest rather than clever: claiming a family whose members are not here
    // would produce a dashboard row for estimates the viewer cannot see.
    const nodes = [n('b', 'gone')];
    expect(rootOf(nodes, 'b')?.id).toBe('b');
  });

  it('terminates on a cycle instead of hanging', () => {
    // Unreachable through the UI — a fork's parent always predates it — but
    // `parentId` is an ordinary column, and a hung dashboard is a far worse
    // failure than an odd grouping.
    const nodes = [n('a', 'b'), n('b', 'a')];
    expect(rootOf(nodes, 'a')).toBeDefined();
  });

  it('returns undefined for an id that is not there', () => {
    expect(rootOf([n('a', null)], 'nope')).toBeUndefined();
  });
});

describe('familiesOf', () => {
  it('puts unrelated estimates in families of their own', () => {
    const nodes = [n('a', null), n('b', null)];
    const families = familiesOf(nodes);
    expect(families.size).toBe(2);
    expect(families.get('a')?.map((x) => x.id)).toEqual(['a']);
  });

  it('gathers a root and its descendants under the root', () => {
    const nodes = [n('a', null), n('b', 'a'), n('c', 'a'), n('d', 'b')];
    const families = familiesOf(nodes);
    expect(families.size).toBe(1);
    expect(families.get('a')?.map((x) => x.id).sort()).toEqual(['a', 'b', 'c', 'd']);
  });

  it('keeps the order the caller supplied', () => {
    // The dashboard sorts by due date before grouping; a second, invisible
    // order imposed here would silently override it.
    const nodes = [n('c', 'a'), n('a', null), n('b', 'a')];
    expect(familiesOf(nodes).get('a')?.map((x) => x.id)).toEqual(['c', 'a', 'b']);
  });

  it('re-roots the survivors when a parent is deleted', () => {
    // SetNull, so a deleted root leaves its children as originals. They become
    // separate projects, which is the truthful reading: nothing links them any
    // more.
    const nodes = [n('b', null), n('c', null)];
    expect(familiesOf(nodes).size).toBe(2);
  });
});

describe('projectNameOf', () => {
  it("falls back to the root's own title before anyone names the project", () => {
    const root = n('a', null, 'Acme CRM — round 1');
    expect(projectNameOf([root], root)).toBe('Acme CRM — round 1');
  });

  it('prefers an explicit name over the title', () => {
    const root = n('a', null, 'Acme CRM — round 1', 'Acme CRM');
    expect(projectNameOf([root], root)).toBe('Acme CRM');
  });

  it('survives the root being deleted, by reading any member', () => {
    // The whole reason the name is denormalised onto every estimate rather than
    // held on the root: deleting round 1 must not scatter the rest of the
    // family into unrelated dashboard rows.
    const child = n('b', null, 'Acme CRM — September', 'Acme CRM');
    expect(projectNameOf([child], child)).toBe('Acme CRM');
  });

  it('ignores an empty name rather than showing a blank row', () => {
    const root = n('a', null, 'Acme CRM — round 1', '');
    expect(projectNameOf([root], root)).toBe('Acme CRM — round 1');
  });
});

describe('familyIds', () => {
  it('is what a rename has to write', () => {
    const nodes = [n('a', null), n('b', 'a'), n('c', 'b'), n('x', null)];
    expect(familyIds(nodes, 'c').sort()).toEqual(['a', 'b', 'c']);
  });

  it('includes the estimate itself when it is alone', () => {
    expect(familyIds([n('a', null)], 'a')).toEqual(['a']);
  });

  it('returns just the id for an estimate that is not in the list', () => {
    expect(familyIds([n('a', null)], 'nope')).toEqual(['nope']);
  });
});
