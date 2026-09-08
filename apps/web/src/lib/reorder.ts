/**
 * Move one item within a list, returning a new list.
 *
 * Extracted from the new-estimate form rather than left inline, because the
 * thing worth being sure of is not the splice — it is the boundaries. A move
 * off either end has to be a no-op that returns the SAME array, so React sees
 * no state change and the row does not flicker; and a move must never drop or
 * duplicate an item, because in the form's case the list IS the set of
 * documents about to be uploaded, and losing one silently would lose part of
 * the client's material.
 */
export function moveInList<T>(list: readonly T[], from: number, delta: number): T[] | readonly T[] {
  const to = from + delta;
  if (from < 0 || from >= list.length) return list;
  if (to < 0 || to >= list.length) return list;
  if (delta === 0) return list;
  const next = [...list];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved!);
  return next;
}
