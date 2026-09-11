/**
 * The document's parts, in the order they appear on the page. AEH-377.
 *
 * One list, read by three things: the bar pinned at the top of the document
 * (which says where you are and offers to take you elsewhere), the contents
 * card in the rail (which adds a subtotal to each row), and the scroll spy
 * that decides which row the bar is currently naming.
 *
 * One list because a jump list that has drifted from the page is the failure
 * this ticket started from: every section row pointed at `#menucard` and no
 * section carried an id, so the only navigation on the screen was dead below
 * its fourth row. Two hand-maintained copies of the order would get there
 * again, and quietly — a row that scrolls somewhere plausible looks like it
 * works.
 *
 * Pure, so the order and the anchors are assertable without a browser.
 */

export type OutlineRow = {
  /** The element id to jump to, and the id the scroll spy watches. */
  id: string;
  label: string;
  /**
   * A section of the menu card rather than a part of the document. It is
   * indented in Jump to, and it carries the section id a subtotal would be
   * computed from — `null` being the ungrouped bucket, which has no row of its
   * own in the database.
   */
  section?: { id: string | null };
  /**
   * What contains this row, for the bar's breadcrumb. Only a menu-card section
   * has one, and it is always the menu card: the document is two levels deep
   * and no deeper.
   *
   * Here rather than derived in the bar so the label exists once. A breadcrumb
   * whose parent says "Menu card" while the row it points at says something
   * else is the kind of drift that survives review.
   */
  parent?: string;
};

/** The one containing part, named once. */
export const MENU_CARD_LABEL = 'Menu card';

export function documentOutline(args: {
  /** Menu-card sections, already in display order. */
  sections: readonly { id: string; title: string }[];
  /** Whether anything sits outside a section. */
  hasUngrouped: boolean;
  /** No menu card means no ledger to point into. */
  hasMenu: boolean;
  /**
   * Whether the risk section renders at all. Resolved findings still count:
   * the section is there, folded, and worth being able to reach.
   */
  hasRisk: boolean;
}): OutlineRow[] {
  const rows: OutlineRow[] = [
    { id: 'sow', label: 'Statement of work' },
    { id: 'narrative', label: 'Narrative' },
    { id: 'assumptions', label: 'Assumptions' },
  ];

  if (args.hasRisk) rows.push({ id: 'risk', label: 'Flagged risk' });

  if (args.hasMenu) {
    rows.push({ id: 'menucard', label: MENU_CARD_LABEL });
    for (const s of args.sections) {
      rows.push({
        id: `section-${s.id}`,
        label: s.title,
        section: { id: s.id },
        parent: MENU_CARD_LABEL,
      });
    }
    if (args.hasUngrouped) {
      rows.push({
        id: 'section-ungrouped',
        label: 'Ungrouped',
        section: { id: null },
        parent: MENU_CARD_LABEL,
      });
    }
  }

  return rows;
}

/**
 * Which row the reader is in, given where each row's element currently sits.
 *
 * The LAST heading that has passed the line, rather than the first one still
 * visible. Those differ exactly where it matters — deep inside a long section,
 * when its heading is far above the fold and the next is far below — and the
 * first-visible reading answers "what is coming up" instead of "what am I in".
 *
 * Pure, and taking the geometry as a function, because the alternative is
 * untestable: the decision only ever runs inside a scroll handler, and a scroll
 * handler cannot be driven from a unit test or, as it turns out, from a browser
 * tab that is not in the foreground — a hidden tab fires no scroll events and
 * no animation frames at all. Same move as retaxRole. AEH-377.
 *
 * @param topOf viewport offset of a row element, or null when it is not on the
 *   page. Rows must be in document order.
 * @param line the y below which a heading counts as arrived: the bar height
 *   plus a little, so a heading level with its underside reads as here rather
 *   than as still to come.
 */
export function rowInView(
  rows: readonly OutlineRow[],
  topOf: (id: string) => number | null,
  line: number,
): OutlineRow | null {
  let current: OutlineRow | null = null;
  for (const row of rows) {
    const top = topOf(row.id);
    if (top === null) continue;
    if (top <= line) current = row;
  }
  // Above everything: you are at the top of the document, which is its first
  // part. Reporting nothing would blank the bar on first paint.
  return current ?? rows[0] ?? null;
}
