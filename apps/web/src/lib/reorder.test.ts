import { describe, it, expect } from 'vitest';
import { moveInList } from './reorder';

describe('moveInList', () => {
  it('moves an item later', () => {
    expect(moveInList(['a', 'b', 'c'], 0, 1)).toEqual(['b', 'a', 'c']);
  });

  it('moves an item earlier', () => {
    expect(moveInList(['a', 'b', 'c'], 2, -1)).toEqual(['a', 'c', 'b']);
  });

  it('returns the SAME array when the move would go off either end', () => {
    // Identity, not just equality: the form holds this in React state, and a
    // fresh array would re-render the list for a move that did not happen.
    const list = ['a', 'b', 'c'];
    expect(moveInList(list, 0, -1)).toBe(list);
    expect(moveInList(list, 2, 1)).toBe(list);
  });

  it('returns the same array for a zero move and an out-of-range source', () => {
    const list = ['a', 'b'];
    expect(moveInList(list, 1, 0)).toBe(list);
    expect(moveInList(list, 5, -1)).toBe(list);
    expect(moveInList(list, -1, 1)).toBe(list);
  });

  it('never drops or duplicates an item', () => {
    // The list this backs is the set of documents about to be uploaded, so a
    // lost entry is lost client material rather than a cosmetic bug.
    const list = ['a', 'b', 'c', 'd', 'e'];
    for (let from = 0; from < list.length; from += 1) {
      for (const delta of [-2, -1, 1, 2]) {
        const out = moveInList(list, from, delta);
        expect([...out].sort()).toEqual([...list].sort());
        expect(out).toHaveLength(list.length);
      }
    }
  });

  it('leaves the input untouched', () => {
    const list = ['a', 'b', 'c'];
    moveInList(list, 0, 2);
    expect(list).toEqual(['a', 'b', 'c']);
  });

  it('moves across more than one position', () => {
    expect(moveInList(['a', 'b', 'c', 'd'], 0, 3)).toEqual(['b', 'c', 'd', 'a']);
  });
});
