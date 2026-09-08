import { describe, it, expect } from 'vitest';

import { assemblePartialArtifact, type PartialSectionRow } from './artifact-partial';

/**
 * AEH-326. Reading a document that is still being written.
 *
 * The claim the whole feature rests on is that `assembleArtifact` does not need
 * the complete set — that the sections written so far assemble into a document
 * with working tabs. That is asserted here rather than taken on faith, because
 * the assembler lives in another package and nothing else would notice if a
 * future change to it started depending on the full outline.
 *
 * The other half is the part a reader could be misled by: a half-written
 * document must say so in its own footer, since a screenshot or a saved page
 * leaves the surrounding UI behind.
 */

const row = (n: number, html?: string): PartialSectionRow => ({
  sectionId: `sec-${n}`,
  title: `Section ${n}`,
  html: html ?? `<h2>Section ${n}</h2><p>Body ${n}.</p>`,
});

const base = {
  title: 'Proposal for Northwind',
  estimateTitle: 'Northwind rebuild',
  typeName: 'Client proposal',
};

describe('assemblePartialArtifact', () => {
  it('returns nothing to read before the first section lands', () => {
    const out = assemblePartialArtifact({ ...base, planned: 9, rows: [] });

    // Null, not an empty shell: a masthead with no body reads as a document
    // that came out blank rather than one that has not started.
    expect(out.html).toBeNull();
    expect(out.written).toBe(0);
    expect(out.planned).toBe(9);
  });

  it('assembles a single written section into a valid document', () => {
    const out = assemblePartialArtifact({ ...base, planned: 9, rows: [row(1)] });

    expect(out.html).toContain('<!doctype html>');
    expect(out.html).toContain('Body 1.');
    expect(out.written).toBe(1);
    // One section gets no tab strip — same rule the finished document follows.
    expect(out.html).not.toContain('role="tablist"');
  });

  it('gives every written section a working tab, first one selected', () => {
    const out = assemblePartialArtifact({
      ...base,
      planned: 9,
      rows: [row(1), row(2), row(3)],
    });
    const html = out.html ?? '';

    expect(html).toContain('role="tablist"');
    expect(html.match(/role="tab"/g)).toHaveLength(3);
    expect(html).toContain('data-target="panel-sec-1" aria-selected="true"');
    expect(html).toContain('data-target="panel-sec-2" aria-selected="false"');

    // Three panels, and only the first is visible — the tabs have something to
    // switch between, which is what makes a partial document readable rather
    // than just present.
    expect(html.match(/role="tabpanel"/g)).toHaveLength(3);
    expect(html).toContain('data-section="sec-1" role="tabpanel">');
    expect(html).toContain('data-section="sec-2" role="tabpanel" hidden>');
    expect(out.written).toBe(3);
  });

  it('passes section markup through verbatim', () => {
    const out = assemblePartialArtifact({
      ...base,
      planned: 2,
      rows: [row(1, '<table><tr><td>1,200</td></tr></table>')],
    });

    // Section HTML is markup by definition and is contained by the CSP and the
    // sandbox, not by escaping. Escaping it here would show a client tags.
    expect(out.html).toContain('<table><tr><td>1,200</td></tr></table>');
  });

  it('escapes the parts the shell writes', () => {
    // Two rows, because a tab label is only rendered when there is a tab strip
    // to render it into — with one section there is deliberately none.
    const out = assemblePartialArtifact({
      ...base,
      title: 'Proposal <script>alert(1)</script>',
      planned: 4,
      rows: [
        { sectionId: 's1', title: 'Cost & scope', html: '<p>x</p>' },
        { sectionId: 's2', title: 'Risks', html: '<p>y</p>' },
      ],
    });
    const html = out.html ?? '';

    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('Cost &amp; scope');
  });

  it('states in the footer that it is a draft, and how far along', () => {
    const out = assemblePartialArtifact({
      ...base,
      planned: 9,
      rows: [row(1), row(2), row(3)],
    });
    const html = out.html ?? '';

    expect(html).toContain('DRAFT');
    expect(html).toContain('3 of 9 sections written so far');
    expect(html).toContain('not the finished document');
  });

  it('counts the planned total, not the written one, when pluralising', () => {
    const out = assemblePartialArtifact({ ...base, planned: 2, rows: [row(1)] });

    // "1 of 2 section written" is what reads out of a naive plural on `written`.
    expect(out.html).toContain('1 of 2 sections written so far');
  });

  it('says only how many are written before the outline has run', () => {
    const out = assemblePartialArtifact({ ...base, planned: 0, rows: [row(1)] });

    // planned 0 means planning has not finished, so "1 of 0" would be a lie.
    expect(out.html).toContain('1 section written so far');
    expect(out.html).not.toContain('of 0');
    expect(out.planned).toBe(0);
  });

  it('carries the artifact title and estimate name, like the finished one', () => {
    const out = assemblePartialArtifact({ ...base, planned: 4, rows: [row(1)] });
    const html = out.html ?? '';

    expect(html).toContain('<title>Proposal for Northwind</title>');
    expect(html).toContain('Northwind rebuild');
  });
});
