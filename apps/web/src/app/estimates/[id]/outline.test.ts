import { describe, it, expect } from 'vitest';
import { documentOutline, rowInView } from './outline';

const SECTIONS = [
  { id: 's1', title: 'Front of house' },
  { id: 's2', title: 'Back office' },
];

describe('documentOutline', () => {
  it('always opens with the crew’s three readings of the brief, in that order', () => {
    const rows = documentOutline({
      sections: [],
      hasUngrouped: false,
      hasMenu: false,
      hasRisk: false,
    });
    expect(rows.map((r) => r.id)).toEqual(['sow', 'narrative', 'assumptions']);
  });

  it('puts risk after assumptions and before the ledger', () => {
    const rows = documentOutline({
      sections: SECTIONS,
      hasUngrouped: false,
      hasMenu: true,
      hasRisk: true,
    });
    expect(rows.map((r) => r.id)).toEqual([
      'sow',
      'narrative',
      'assumptions',
      'risk',
      'menucard',
      'section-s1',
      'section-s2',
    ]);
  });

  /**
   * The bug this file exists to prevent a second time: a section row has to
   * point at the section, not at the menu card. Every one of them pointed at
   * `#menucard` before AEH-377, so the jump list was dead below its fourth row.
   */
  it('anchors each section at itself', () => {
    const rows = documentOutline({
      sections: SECTIONS,
      hasUngrouped: false,
      hasMenu: true,
      hasRisk: false,
    });
    const sections = rows.filter((r) => r.section !== undefined);
    expect(sections.map((r) => r.id)).toEqual(['section-s1', 'section-s2']);
    expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
  });

  it('carries the section id each subtotal is computed from', () => {
    const rows = documentOutline({
      sections: SECTIONS,
      hasUngrouped: true,
      hasMenu: true,
      hasRisk: false,
    });
    expect(rows.filter((r) => r.section).map((r) => r.section!.id)).toEqual(['s1', 's2', null]);
  });

  it('offers nothing inside the ledger when there is no ledger', () => {
    const rows = documentOutline({
      sections: SECTIONS,
      hasUngrouped: true,
      hasMenu: false,
      hasRisk: true,
    });
    expect(rows.map((r) => r.id)).toEqual(['sow', 'narrative', 'assumptions', 'risk']);
  });

  it('leaves the ungrouped bucket out when nothing is in it', () => {
    const rows = documentOutline({
      sections: SECTIONS,
      hasUngrouped: false,
      hasMenu: true,
      hasRisk: false,
    });
    expect(rows.map((r) => r.id)).not.toContain('section-ungrouped');
  });
});

describe('rowInView', () => {
  const ROWS = documentOutline({
    sections: SECTIONS,
    hasUngrouped: false,
    hasMenu: true,
    hasRisk: true,
  });
  const LINE = 56;
  /** Headings 400px apart, the first at `first` from the top of the viewport. */
  const laidOut = (first: number) => (id: string) =>
    first + ROWS.findIndex((r) => r.id === id) * 400;

  it('names the first part before anything has scrolled past', () => {
    expect(rowInView(ROWS, laidOut(200), LINE)?.id).toBe('sow');
  });

  /**
   * The case the whole function is for: deep inside the statement of work, its
   * own heading is far above the fold and Narrative is far below. The answer is
   * the statement of work, not the thing coming up next.
   */
  it('names the last heading passed, not the first one visible', () => {
    // sow at -600, narrative at -200, assumptions at 200.
    expect(rowInView(ROWS, laidOut(-600), LINE)?.id).toBe('narrative');
  });

  it('moves on the frame a heading crosses the line', () => {
    const atLine = (id: string) => (id === 'narrative' ? LINE : id === 'sow' ? -400 : 500);
    expect(rowInView(ROWS, atLine, LINE)?.id).toBe('narrative');
    const justBelow = (id: string) => (id === 'narrative' ? LINE + 1 : id === 'sow' ? -400 : 500);
    expect(rowInView(ROWS, justBelow, LINE)?.id).toBe('sow');
  });

  it('skips rows whose element is not on the page', () => {
    const missingRisk = (id: string) => (id === 'risk' ? null : laidOut(-1200)(id));
    // Without risk, the last one passed is assumptions rather than risk.
    expect(rowInView(ROWS, missingRisk, LINE)?.id).toBe('assumptions');
  });

  it('reports nothing only when there is nothing to report', () => {
    expect(rowInView([], () => null, LINE)).toBeNull();
  });
});
