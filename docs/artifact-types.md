# Artifact types

An **artifact** is a supporting document generated from an estimate — an entity
model, a set of user journeys, a wireframe pack, a phased delivery plan. An
**artifact type** is a row that defines one: a brief, and a choice of what the
model may read.

Adding a type takes no code change and no deploy. Nothing is seeded, ever, so
every type in this system was written by hand at `/admin/artifact-types`.

This document describes **the machine** — what your brief is joined to, what it
can see, and what it is expected to produce. It deliberately contains no example
briefs: the content is yours.

---

## The rule everything follows

> Anything specific to one artifact is data. Anything shared by every artifact
> is code.

| | |
|---|---|
| **Data** (you own it) | the brief, the corpus selection, the model |
| **Code** (supplied) | the page shell, the prompt envelope, the corpus builders |

That is the answer to "is X a code change?" for anything asked for later.

---

## Your brief is not the whole prompt

What you write is wrapped in a **code-owned envelope** at call time. The
envelope carries the JSON contract, the fragment rules, the CSS vocabulary, the
selector-scoping rule and the size budget. You never see it and cannot break it
— which is the point, since there is no seeded example to copy from.

So: **describe the content, never the container.** Do not ask for HTML, tabs,
styling, a title bar or a file structure. Those are supplied around whatever you
ask for. Say what the document must contain, how it should be organised, and
what a reader should be able to work out from it.

---

## What your artifact may read

Tick the sections your brief actually needs. Only ticked sections are sent, each
is paid for on every generation, and a large one crowds out the model's
attention as well as its budget.

| Section | Size | Contains |
|---|---|---|
| Source document | large | The SOW verbatim — the only language nobody on the delivery side wrote |
| Requirements | medium | The Librarian's numbered breakdown, each with a stable id |
| Menu cards | medium | Every costed card: taxonomy, category, phase, taxed hours, and the requirements it was costed against |
| Role breakdown | large | Per-card line items by role, base and taxed hours. Several times the size of the cards alone |
| Totals | small | Hours by role, by phase, and overall |
| Dependency graph | small | Which cards depend on which, plus the always-included set |
| Hidden work | small | Risks the Detective raised and what was decided about each |
| Saved scope configurations | small | Named scopes already cut on the configurator |
| Narrative & assumptions | small | The estimate's own written reasoning |

Several are empty until something else has happened — a run, a derive on the
scope screen, a saved scenario. The picker marks those "needs a run". Ticking
one is fine; an empty section is stated in the corpus rather than omitted, so
the model is told the estimate has none rather than inventing some.

**Cards are numbered once.** Every section that refers to a card uses the same
number, so a brief can safely say "reference cards by their number".

The catalogue lives in `packages/db/src/artifact-corpus-catalogue.ts`. Adding a
section is a code change — that is a change to what data exists at all, not to
artifact support. Retiring one degrades the types that ticked it rather than
breaking them; the editor shows the leftover key marked "retired".

---

## How a document gets made

Generation is a durable Inngest job of **N+2 steps**:

```
1        outline    plan the sections
2..N+1   section    write one section's HTML each — its own step, its own 300s
N+2      assemble   wrap them in the shared shell
```

It is this shape for one reason: the deploy target's per-step ceiling is a hard
300s with no Pro headroom, and a full document is ~25k output tokens, which no
single call can produce. Inngest gives each `step.run()` its own 300s.

It scales by content with no special cases — an ERD is a one-section outline and
three steps; a wireframe pack is nine sections and eleven.

**The outline decides the shape.** It plans the sections, and it fixes a shared
vocabulary — the proper nouns every section must use identically. Sections are
then written by separate calls that never see each other's HTML; each is given
the outline, its own brief, and the *briefs* of the sections already written.
That is what lets section 5 cite an entity section 2 introduced.

**Each section must fit ~1200 words.** The outline is told this and asked to
split anything larger. A brief that demands one enormous section fights the
constraint; a brief that names distinct areas of concern lets the model plan
well.

### Preview the plan first

On any estimate, "Preview the plan first" runs **only** the outline — one call,
a couple of thousand tokens, a few seconds — and shows the section list without
generating anything. Use it while iterating on a brief. It plans from exactly
the same corpus the real run would, at temperature 0, so it is predictive rather
than indicative.

---

## What a section may produce

Model-authored HTML: markup, `<style>` and `<script>`. **There is no template.**
A wireframe's layout is its content, so nothing constrains what a section
renders.

Supplied around it:

- **A shell** — document, header, tab bar derived from the outline, footer.
- **A CSS floor** — `.card`, `.grid`/`.grid-2`/`.grid-3`, `.pill` (`.green`,
  `.bronze`, `.brick`), `.eyebrow`, `.muted`, `.num`, `.scroll-x`, styled
  tables, and the app's colour variables. A floor, not a ceiling: a section
  writes its own CSS for anything else.
- **Selector scoping** — each section is wrapped in `#panel-<id>` and told to
  scope every selector under it, so sections cannot fight each other.

Constraints worth knowing when writing a brief:

- **No images can be fetched.** Diagrams are HTML, CSS and inline SVG. The
  document carries `default-src 'none'`, so anything external is refused by the
  browser, not merely discouraged.
- **Wide content scrolls itself** (`.scroll-x`); the page never scrolls
  sideways.
- **Print keeps every section**, because these get sent as PDFs.

---

## Delivery and safety

The finished document is one self-contained HTML file. The viewer renders it in
an iframe with `sandbox="allow-scripts"` and deliberately **without**
`allow-same-origin` — together those lift the sandbox — so it runs in an opaque
origin and cannot reach the app. Download hands over exactly those bytes.

An artifact is a **snapshot**. It records which version of the brief produced it
and says so in its own footer. If the estimate is re-run afterwards, the artifact
is flagged "generated before the last run" rather than silently going stale.

## Editing a type

Saving creates a new active version; the old one stays readable and can be
reactivated. Documents already generated are untouched and keep pointing at the
version that made them.

Types are **archived**, never deleted — a generated artifact is a client
deliverable and its type must stay resolvable forever. Archiving only removes it
from the picker.

## Cost

One document is N+2 model calls, all recorded against the artifact
(`ModelUsage.artifactId`), so per-document spend is a query. Generation is
capped at 2 concurrent so it can never starve estimate runs of Inngest
concurrency slots.

Corpus text is re-sent on every call. Prompt caching would cut that and is not
wired yet — deferred until the bill is measurable.
