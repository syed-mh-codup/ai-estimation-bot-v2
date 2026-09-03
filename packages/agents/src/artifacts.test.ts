import { describe, expect, it } from 'vitest';

import { assembleArtifact, escapeHtml, CSS_CONTRACT } from './artifact-shell';
import { normaliseSectionId, sectionPrompt, stripFence, uniqueSectionIds } from './artifacts';
import type { ArtifactOutline } from '@repo/shared';

/**
 * AEH-239. The parts of artifact generation that are decidable without a model.
 *
 * These are deliberately the boring-looking ones. Everything here is a failure
 * that would otherwise be discovered by reading a finished, client-facing
 * document and noticing something is wrong — a visible ``` fence at the top of
 * a deliverable, two tabs showing the same panel, a section whose CSS bled into
 * its neighbours. None of those throw, so nothing else would catch them.
 */

describe('normaliseSectionId', () => {
  it('passes a well-formed slug through', () => {
    expect(normaliseSectionId('entity-model', 0)).toBe('entity-model');
  });

  it('slugifies what a model actually returns when asked for a slug', () => {
    // The schema only requires a non-empty string, so this is reachable. Left
    // alone it lands in an id attribute and a CSS selector, where the space and
    // the parens silently break tab switching.
    expect(normaliseSectionId('Entity Model (core)', 0)).toBe('entity-model-core');
  });

  it('falls back to a positional id rather than emitting an empty one', () => {
    // An empty id would produce id="panel-" on every such section — every tab
    // pointing at the same panel. A dull anchor beats that.
    expect(normaliseSectionId('!!!', 3)).toBe('section-4');
  });

  it('never ends in a dash after the length cap', () => {
    const id = normaliseSectionId(`${'a'.repeat(48)} more`, 0);
    expect(id).toBe('a'.repeat(48));
    expect(id.endsWith('-')).toBe(false);
  });
});

describe('uniqueSectionIds', () => {
  it('leaves already-distinct ids alone', () => {
    expect(uniqueSectionIds(['one', 'two'])).toEqual(['one', 'two']);
  });

  it('separates duplicates', () => {
    // Two sections sharing an id means one tab shows the other's panel — a bug
    // that reads as "the model wrote the wrong content" and gets debugged in
    // the prompt for an afternoon.
    expect(uniqueSectionIds(['journeys', 'journeys', 'journeys'])).toEqual([
      'journeys',
      'journeys-2',
      'journeys-3',
    ]);
  });

  it('separates ids that only collide after normalising', () => {
    expect(uniqueSectionIds(['User Journeys', 'user-journeys'])).toEqual([
      'user-journeys',
      'user-journeys-2',
    ]);
  });

  it('separates two ids that both fall back to a positional name', () => {
    expect(uniqueSectionIds(['???', '***'])).toEqual(['section-1', 'section-2']);
  });
});

describe('stripFence', () => {
  it('removes a fence wrapping the whole response', () => {
    expect(stripFence('```html\n<p>hi</p>\n```')).toBe('<p>hi</p>');
  });

  it('removes an unlabelled fence too', () => {
    expect(stripFence('```\n<p>hi</p>\n```')).toBe('<p>hi</p>');
  });

  it('leaves clean HTML untouched', () => {
    expect(stripFence('<p>hi</p>')).toBe('<p>hi</p>');
  });

  it('leaves a fence INSIDE a section alone', () => {
    // A section legitimately showing a code sample contains fences that are
    // content. Only a fence wrapping the entire response is packaging.
    const html = '<h2>Example</h2>\n<pre>```js\nconst a = 1;\n```</pre>';
    expect(stripFence(html)).toBe(html);
  });
});

describe('escapeHtml', () => {
  it('escapes what the shell writes into text and attributes', () => {
    expect(escapeHtml('Tom & "Jerry" <b>')).toBe('Tom &amp; &quot;Jerry&quot; &lt;b&gt;');
  });
});

const outline = (over: Partial<ArtifactOutline> = {}): ArtifactOutline => ({
  title: 'Scope atlas',
  vocabulary: ['Order', 'Fulfilment'],
  sections: [
    { id: 'entities', title: 'Entity model', brief: 'Every logical entity.' },
    { id: 'journeys', title: 'Journeys', brief: 'Every end-to-end journey.' },
    { id: 'tranches', title: 'Tranches', brief: 'The delivery tranches.' },
  ],
  ...over,
});

describe('sectionPrompt', () => {
  it('tells the section which id to scope its CSS under', () => {
    // The one instruction that stops nine sections' styles fighting. If this
    // stops being sent, every artifact still generates and slowly looks worse.
    const p = sectionPrompt({
      outline: outline(),
      index: 0,
      sectionId: 'entities',
      corpus: 'CORPUS',
      done: [],
    });
    expect(p).toContain('#panel-entities');
  });

  it('carries the shared vocabulary so sections agree on names', () => {
    const p = sectionPrompt({ outline: outline(), index: 1, sectionId: 'journeys', corpus: '', done: [] });
    expect(p).toContain('Order');
    expect(p).toContain('Fulfilment');
  });

  it('passes the briefs of finished sections and never their HTML', () => {
    // Sending the HTML would grow the context section by section and
    // reintroduce the size problem the outline exists to solve.
    const p = sectionPrompt({
      outline: outline(),
      index: 1,
      sectionId: 'journeys',
      corpus: '',
      done: [{ title: 'Entity model', brief: 'Every logical entity.' }],
    });
    expect(p).toContain('Already written');
    expect(p).toContain('Entity model: Every logical entity.');
    expect(p).not.toContain('<');
  });

  it('names what is still to come so sections do not duplicate each other', () => {
    const p = sectionPrompt({ outline: outline(), index: 0, sectionId: 'entities', corpus: '', done: [] });
    expect(p).toContain('Still to come');
    expect(p).toContain('Tranches');
  });

  it('omits the empty scaffolding on a single-section document', () => {
    const one = outline({ sections: [{ id: 'a', title: 'A', brief: 'B' }], vocabulary: [] });
    const p = sectionPrompt({ outline: one, index: 0, sectionId: 'a', corpus: 'C', done: [] });
    expect(p).not.toContain('Still to come');
    expect(p).not.toContain('Already written');
    expect(p).toContain('section 1 of 1');
  });

  it('puts the source material in', () => {
    const p = sectionPrompt({ outline: outline(), index: 0, sectionId: 'entities', corpus: 'THE SOW', done: [] });
    expect(p).toContain('THE SOW');
  });
});

describe('assembleArtifact', () => {
  const meta = { title: 'Scope atlas', subtitle: 'Acme rebuild', footer: 'generated' };
  const sections = [
    { sectionId: 'entities', title: 'Entity model', html: '<h2>Entities</h2>' },
    { sectionId: 'journeys', title: 'Journeys', html: '<h2>Journeys</h2>' },
  ];

  it('produces one self-contained document', () => {
    const html = assembleArtifact(meta, sections);
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<h2>Entities</h2>');
    expect(html).toContain('<h2>Journeys</h2>');
  });

  it('carries a CSP that forbids fetching anything', () => {
    // This is what makes "self-contained" enforced rather than hoped for: no
    // analytics a model hallucinated, no CDN font, no image hotlinked from a
    // domain that 404s in a year. It pairs with the viewer's sandbox, and both
    // layers matter because this HTML was written by a model and handed to a
    // client.
    const html = assembleArtifact(meta, sections);
    expect(html).toContain("default-src 'none'");
    expect(html).toContain("img-src data:");
  });

  it('wraps each section in its own element with the id its CSS is scoped to', () => {
    const html = assembleArtifact(meta, sections);
    expect(html).toContain('id="panel-entities"');
    expect(html).toContain('id="panel-journeys"');
  });

  it('shows the first panel and hides the rest', () => {
    const html = assembleArtifact(meta, sections);
    const first = html.indexOf('id="panel-entities"');
    const second = html.indexOf('id="panel-journeys"');
    expect(html.slice(first, first + 120)).not.toContain('hidden');
    expect(html.slice(second, second + 120)).toContain('hidden');
  });

  it('omits the tab bar for a single section', () => {
    // A one-tab tab bar is furniture that says nothing.
    const html = assembleArtifact(meta, [sections[0]!]);
    expect(html).not.toContain('role="tablist"');
    // ...and the only panel must not be hidden, or the document renders blank.
    expect(html).toContain('id="panel-entities"');
    expect(html).not.toContain('hidden>');
  });

  it('keeps every panel visible in print', () => {
    // Somebody will send this to a client as a PDF. A print that silently
    // dropped eight of nine sections is the worst failure available to a
    // document whose whole purpose is being handed over.
    const html = assembleArtifact(meta, sections);
    expect(html).toContain('@media print');
    expect(html).toContain('.panel[hidden]{display:block!important}');
  });

  it('escapes the text it writes, so a quote in a title cannot break the markup', () => {
    const html = assembleArtifact(
      { title: 'The "big" <rebuild>', subtitle: 'x', footer: 'y' },
      sections,
    );
    expect(html).toContain('The &quot;big&quot; &lt;rebuild&gt;');
    expect(html).not.toContain('<rebuild>');
  });

  it('escapes tab labels, which come from the model', () => {
    const html = assembleArtifact(meta, [
      { sectionId: 'a', title: '<script>x</script>', html: '<p>ok</p>' },
      { sectionId: 'b', title: 'B', html: '<p>ok</p>' },
    ]);
    expect(html).toContain('&lt;script&gt;');
  });
});

describe('the CSS contract', () => {
  it('names only classes the shell actually ships', () => {
    // The contract and the stylesheet live in one module precisely so they
    // cannot drift. A prompt promising a class the shell stopped shipping is a
    // silent downgrade in every artifact generated afterwards, so this asserts
    // the promise against the real document.
    const shipped = assembleArtifact(
      { title: 't', subtitle: 's', footer: 'f' },
      [{ sectionId: 'a', title: 'A', html: '' }],
    );
    for (const cls of ['.card', '.grid-2', '.pill', '.eyebrow', '.muted', '.scroll-x']) {
      expect(CSS_CONTRACT).toContain(cls);
      expect(shipped).toContain(cls);
    }
  });
});
