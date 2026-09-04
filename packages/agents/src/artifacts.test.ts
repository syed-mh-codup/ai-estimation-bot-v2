import { describe, expect, it } from 'vitest';

import { assembleArtifact, escapeHtml, CSS_CONTRACT } from './artifact-shell';
import {
  normaliseDiagramBlocks,
  normaliseSectionId,
  sectionEnvelope,
  sectionPrompt,
  stripFence,
  uniqueSectionIds,
} from './artifacts';
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
  it('strips an opening fence that is never closed', () => {
    // The live failure (AEH-321): a long section opened ```html and ran out
    // before closing it, and a both-ends regex left the marker in the document.
    expect(stripFence('```html\n<style>\n  .a { color: red }\n</style>\n<p>hi</p>')).toBe(
      '<style>\n  .a { color: red }\n</style>\n<p>hi</p>',
    );
  });

  it('leaves a fence that is part of the content alone', () => {
    // Only a fence on the FIRST line is a wrapper. One further in belongs to
    // the section — a code sample in a <pre> — and stripping it would corrupt
    // the document rather than clean it.
    const html = '<pre><code>```bash\nnpm i\n```</code></pre>';
    expect(stripFence(html)).toBe(html);
  });

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
    { id: 'entities', title: 'Entity model', brief: 'Every logical entity.', kind: 'diagram' },
    { id: 'journeys', title: 'Journeys', brief: 'Every end-to-end journey.', kind: 'prose' },
    { id: 'tranches', title: 'Tranches', brief: 'The delivery tranches.', kind: 'prose' },
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
    const one = outline({ sections: [{ id: 'a', title: 'A', brief: 'B', kind: 'prose' }], vocabulary: [] });
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

/** The CSP meta tag's content attribute, so a test can assert on the policy alone. */
const csp = (html: string): string =>
  /<meta http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html)?.[1] ?? '';

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
    expect(html).toContain('img-src data:');
    // A document with no diagram in it is not merely self-contained by luck —
    // it names no remote source at all, exactly as before AEH-324.
    expect(csp(html)).not.toContain('https:');
    expect(html).not.toContain('cdn.jsdelivr.net');
  });

  it('widens the CSP by exactly one file, and only for a document that draws', () => {
    // The load-bearing test for AEH-324. `script-src https://cdn.jsdelivr.net`
    // would be the obvious spelling and it is the wrong one: that CDN serves
    // any npm package and any GitHub repo, and the corpus these documents are
    // built from comes out of client-uploaded files, so a prompt injection
    // could pull arbitrary code into a document we hand to a client. The
    // allowance is one immutable URL, and this is what stops somebody widening
    // it to the bare host later.
    const html = assembleArtifact(meta, [
      ...sections,
      { sectionId: 'erd', title: 'ERD', html: '<pre class="diagram">erDiagram\n A ||--o{ B : has</pre>' },
    ]);
    const policy = csp(html);

    const remote = policy.match(/https:\/\/[^;\s]+/g) ?? [];
    expect(remote).toHaveLength(1);
    expect(remote[0]).toBe(
      'https://cdn.jsdelivr.net/npm/mermaid@11.17.2/dist/mermaid.min.js',
    );
    // A path that does not end in "/" matches that file and nothing else, so
    // the exactness IS the mechanism, not a tidiness preference.
    expect(remote[0]!.endsWith('/')).toBe(false);

    // Everything else stays shut. connect-src is absent on purpose: it inherits
    // default-src 'none', which the UMD bundle permits because it has no lazy
    // chunks to fetch. Naming it here at all would be the hole reopening.
    expect(policy).toContain("default-src 'none'");
    expect(policy).not.toContain('connect-src');
    expect(policy).toContain('img-src data:');
    expect(policy).toContain('font-src data:');
  });

  it('pins the renderer by content as well as by name', () => {
    // The second lock. The path match says which file; SRI says which bytes,
    // so a compromised or silently-republished CDN artefact is refused by the
    // browser rather than executed inside a client-facing document.
    const html = assembleArtifact(meta, [
      { sectionId: 'erd', title: 'ERD', html: '<pre class="diagram">erDiagram\n A ||--o{ B : has</pre>' },
    ]);
    expect(html).toContain('integrity="sha384-');
    expect(html).toContain('crossorigin="anonymous"');
  });

  it('renders diagrams with render(), not run(), because later panels are hidden', () => {
    // getBBox() returns zeros inside display:none, so mermaid's in-place run()
    // would lay out every diagram outside the first tab with all its labels
    // measured as zero-width. render() measures in its own container attached
    // to <body>. This asserts the shape of the fix, since the failure it
    // prevents only shows up in a browser on the second tab.
    const html = assembleArtifact(meta, [
      sections[0]!,
      { sectionId: 'erd', title: 'ERD', html: '<pre class="diagram">erDiagram\n A ||--o{ B : has</pre>' },
    ]);
    expect(html).toContain('m.render(');
    expect(html).not.toContain('mermaid.run(');
    expect(html).toContain('startOnLoad:false');
    // And the tab chrome is live before 3.5MB starts downloading.
    expect(html.indexOf("querySelectorAll('.tab')")).toBeLessThan(
      html.indexOf('<script src="https://cdn.jsdelivr.net'),
    );
  });

  it('leaves the notation on screen when the renderer never arrives', () => {
    // The whole offline story: the <pre> ships visible and is replaced on
    // success, so a client opening the downloaded file with no network reads
    // notation instead of staring at an empty box.
    const html = assembleArtifact(meta, [
      { sectionId: 'erd', title: 'ERD', html: '<pre class="diagram">erDiagram\n A ||--o{ B : has</pre>' },
    ]);
    expect(html).toContain('<pre class="diagram">erDiagram');
    expect(html).toContain('pre.diagram{');
    expect(html).not.toContain('pre.diagram{display:none');
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
    for (const cls of [
      '.card',
      '.grid-2',
      '.pill',
      '.eyebrow',
      '.muted',
      '.scroll-x',
      '.diagram',
    ]) {
      expect(CSS_CONTRACT).toContain(cls);
      expect(shipped).toContain(cls);
    }
  });
});

describe('sectionEnvelope', () => {
  it('offers the notation block to every section, not just the diagram ones', () => {
    // A prose section explaining how checkout works legitimately wants a
    // sequence diagram in the middle of it. `kind` governs the word budget and
    // whether the subject may be split — never whether a diagram is allowed.
    for (const kind of ['prose', 'diagram'] as const) {
      expect(sectionEnvelope(kind)).toContain('<pre class="diagram">');
    }
  });

  it('gives a prose section the word budget and a diagram section none', () => {
    // The two tails make OPPOSITE demands, which is why they are branched
    // rather than concatenated. Handing a diagram section the budget is what
    // produced seven per-domain ERDs where one system diagram was asked for.
    expect(sectionEnvelope('prose')).toContain('Aim for about');
    expect(sectionEnvelope('diagram')).not.toContain('Aim for about');
    expect(sectionEnvelope('diagram')).toContain('NO word budget');
    expect(sectionEnvelope('diagram')).toContain('Do not split it');
  });

  it('asks an entity diagram for attributes, not just entity names', () => {
    // Boxes with only names in them are a list of nouns with lines between
    // them. The attribute block is what makes an ERD a deliverable, so the
    // worked example in the contract has to show one.
    const env = sectionEnvelope('diagram');
    expect(env).toContain('uuid id PK');
    expect(env).toContain('uuid customerId FK');
    expect(env).toContain('ATTRIBUTES');
  });

  it('teaches the angle-bracket rule, which is the one that breaks silently', () => {
    // stateDiagram-v2 spells a fork <<fork>>, which raw inside a <pre> is
    // markup rather than notation.
    expect(sectionEnvelope('prose')).toContain('&lt;&lt;fork&gt;&gt;');
  });
});

describe('normaliseDiagramBlocks', () => {
  const wrap = (body: string): string => `<p>Lead-in.</p><pre class="diagram">${body}</pre>`;

  it('leaves a well-formed block alone apart from canonicalising the tag', () => {
    const out = normaliseDiagramBlocks(wrap('erDiagram\n  A ||--o{ B : has'), 'ERD');
    expect(out).toContain('<pre class="diagram">erDiagram');
    expect(out).toContain('A ||--o{ B : has');
    expect(out).toContain('<p>Lead-in.</p>');
  });

  it('escapes a raw angle bracket the prompt asked for as an entity', () => {
    // The likeliest thing to be got wrong, and mechanical to fix, so it is
    // repaired rather than thrown on — a throw costs a paid retry.
    const out = normaliseDiagramBlocks(
      wrap('stateDiagram-v2\n  [*] --> <<fork>>'),
      'States',
    );
    expect(out).toContain('--&gt; &lt;&lt;fork&gt;&gt;');
    expect(out).not.toContain('<<fork>>');
  });

  it('converges both spellings on the entity form', () => {
    // textContent decodes them in the browser, so "-->" and "--&gt;" must both
    // reach mermaid as "-->".
    const raw = normaliseDiagramBlocks(wrap('flowchart TD\n  A --> B'), 'Flow');
    const escaped = normaliseDiagramBlocks(wrap('flowchart TD\n  A --&gt; B'), 'Flow');
    expect(raw).toBe(escaped);
  });

  it('strips a markdown fence the model nested inside the block', () => {
    // stripFence deliberately only looks at line one of the whole response, so
    // a fence inside the <pre> sails past it and reaches mermaid as a syntax
    // error.
    const out = normaliseDiagramBlocks(
      wrap('```mermaid\nsequenceDiagram\n  A->>B: hi\n```'),
      'Sequence',
    );
    expect(out).toContain('<pre class="diagram">sequenceDiagram');
    expect(out).not.toContain('```');
  });

  it('accepts every notation keyword the contract names', () => {
    for (const first of [
      'erDiagram',
      'sequenceDiagram',
      'stateDiagram-v2',
      'stateDiagram',
      'flowchart TD',
      'graph LR',
    ]) {
      expect(() => normaliseDiagramBlocks(wrap(`${first}\n  A --> B`), 'D')).not.toThrow();
    }
  });

  it('rejects a block that is prose rather than notation', () => {
    // What a retry actually fixes, so it throws rather than shipping a block
    // that will only fail in the client's browser.
    expect(() =>
      normaliseDiagramBlocks(wrap('The entities are as follows:'), 'ERD'),
    ).toThrow(/not a diagram/);
  });

  it('rejects an empty block, which is a billed call that produced nothing', () => {
    expect(() => normaliseDiagramBlocks(wrap('\n  \n'), 'ERD')).toThrow(/empty diagram block/);
  });

  it('names the section in the error, since a run has a dozen of them', () => {
    expect(() => normaliseDiagramBlocks(wrap('nonsense'), 'Warranty domain')).toThrow(
      /Warranty domain/,
    );
  });

  it('handles the tag a model actually writes, not just the one it was asked for', () => {
    const out = normaliseDiagramBlocks(
      '<pre class="diagram scroll-x" data-x="1">erDiagram\n  A ||--o{ B : has</pre>',
      'ERD',
    );
    expect(out).toBe('<pre class="diagram">erDiagram\n  A ||--o{ B : has</pre>');
  });

  it('carries an entity attribute block through unharmed', () => {
    // The braces and the quoted comment are notation, not markup, so nothing
    // in the repair pass may touch them.
    const src = [
      'erDiagram',
      '  CUSTOMER {',
      '    uuid id PK',
      '    string email "unique"',
      '  }',
      '  CUSTOMER ||--o{ ORDER : places',
    ].join('\n');
    const out = normaliseDiagramBlocks(wrap(src), 'ERD');
    expect(out).toContain('<pre class="diagram">' + src + '</pre>');
  });

  it('quotes the two flowchart labels that really killed a generation', () => {
    // AEH-330, both from real stored notation. mermaid reports `got 'PS'` — its
    // Paren-Start token — and the whole diagram dies, so a bare bracket in a
    // label is not a cosmetic problem.
    const course = normaliseDiagramBlocks(
      wrap('flowchart TD\n  DROP1 -- Yes --> COURSE[Take course(s)]'),
      'Academy',
    );
    expect(course).toContain('COURSE["Take course(s)"]');

    const klaviyo = normaliseDiagramBlocks(
      wrap('flowchart TD\n  Klaviyo <-->|email marketing (being phased out)| P0'),
      'Context',
    );
    expect(klaviyo).toContain('|"email marketing (being phased out)"|');
  });

  it('never quotes a shape delimiter, which would break a working diagram', () => {
    // Parens are also shape syntax. The rule that skips these has to test that
    // the content OPENS AND CLOSES with a pair: a rule that skipped anything
    // merely ending in a paren also skipped "Take course(s)" and so did nothing
    // at all to the case above.
    const src = [
      'flowchart TD',
      '  P0((DealerOS))',
      '  P11((1.1 Dashboard Analytics))',
      '  D1[(Dealer Profile)]',
      '  W[/Parallelogram/]',
      '  H{{Hexagon}}',
    ].join('\n');
    const out = normaliseDiagramBlocks(wrap(src), 'Core');
    expect(out).toContain('P0((DealerOS))');
    expect(out).toContain('P11((1.1 Dashboard Analytics))');
    expect(out).toContain('D1[(Dealer Profile)]');
    expect(out).toContain('W[/Parallelogram/]');
    expect(out).toContain('H{{Hexagon}}');
  });

  it('leaves a label alone when it needs nothing', () => {
    // The eleven of thirteen real blocks that were already fine must come
    // through byte-identical, or the repair is a liability rather than a net.
    const src = [
      'flowchart TD',
      '  A["Dealer in DealerOS<br>Warranty section"] --> B{"License on file?"}',
      '  B -->|"No"| C["Blocked"]',
      '  DROP1{Completes<br>course?} --> OUT1[Drops out]',
    ].join('\n');
    const body = /<pre class="diagram">([\s\S]*?)<\/pre>/.exec(
      normaliseDiagramBlocks(wrap(src), 'Flow'),
    )![1]!;
    // Only the angle-bracket escaping should have happened.
    expect(body).toBe(src.replace(/</g, '&lt;').replace(/>/g, '&gt;'));
  });

  it('does not reach into a diagram that is not a flowchart', () => {
    // erDiagram uses braces structurally; quoting an attribute block would
    // wreck it. The guard is the opening keyword.
    const src = [
      'erDiagram',
      '  CUSTOMER {',
      '    uuid id PK',
      '    string email "unique"',
      '  }',
      '  CUSTOMER ||--o{ ORDER : places',
    ].join('\n');
    expect(normaliseDiagramBlocks(wrap(src), 'ERD')).toContain(src);
  });

  it('leaves a fragment with no diagram in it completely untouched', () => {
    const html = '<h2>Tranches</h2><p>Three of them.</p><pre><code>npm i</code></pre>';
    expect(normaliseDiagramBlocks(html, 'Tranches')).toBe(html);
  });

  it('checks every block, not just the first', () => {
    const two = `${wrap('erDiagram\n  A ||--o{ B : has')}${wrap('still prose')}`;
    expect(() => normaliseDiagramBlocks(two, 'ERD')).toThrow(/not a diagram/);
  });
});
