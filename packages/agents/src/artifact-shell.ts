/**
 * The page every artifact assembles into. AEH-239.
 *
 * ## Why a shell exists when there is deliberately no template
 *
 * The per-type HTML template was rejected, because a low-fidelity wireframe's
 * layout IS its content and templating it would put the interesting part back
 * under code review. This is not that. The shell supplies only what is the same
 * for every artifact — the document, its navigation, a colour and type
 * vocabulary, and the security header — and never touches what a section
 * actually renders inside itself.
 *
 * It also pays for itself twice over. The reference artifact on AEH-235 is
 * ~100KB, and the great majority of that is chrome. Generating chrome per
 * artifact would spend most of a ~25k-token budget re-deriving a tab bar, and
 * would produce a different tab bar every time.
 *
 * ## Self-contained is enforced, not hoped for
 *
 * The CSP meta tag is the mechanism. `default-src 'none'` means a generated
 * page cannot fetch, embed, or beacon anywhere — no analytics a model
 * hallucinated, no CDN font, no image hotlinked from a domain that will 404 in
 * a year. Inline style and script are allowed because that is what a section
 * legitimately writes; everything else is refused by the browser rather than by
 * a reviewer noticing.
 *
 * That pairs with how the viewer frames it: `sandbox="allow-scripts"` WITHOUT
 * `allow-same-origin`, so the document runs in an opaque origin and cannot
 * reach the app's cookies or DOM. Two independent layers, because this HTML was
 * written by a model and then handed to a client.
 */

/** Palette lifted from the app's own tokens so an artifact looks like the product. */
const TOKENS = `
  --canvas:#ebe7dc; --surface:#fbfaf6; --surface-2:#f4f2ea;
  --line:#d6d1c1; --line-soft:#e4e0d3;
  --ink:#23211b; --ink-2:#555146; --ink-3:#615d51; --ink-4:#948f81;
  --green:#2f6b4c; --green-deep:#245239; --green-tint:#e0e8dd; --green-line:#b9cbb8;
  --bronze:#a87524; --bronze-ink:#8a5f16; --bronze-tint:#f2e7ce; --bronze-line:#dcc38a;
  --brick:#a93f2e; --brick-tint:#f3dfd9; --brick-line:#e0b8ac;
`;

/**
 * The utility vocabulary every section may compose from.
 *
 * A FLOOR, not a ceiling, and the section prompt says so. Its job is to stop
 * nine independently written sections each inventing their own card, and to
 * keep each fragment small by not repeating the same 40 lines of CSS nine
 * times. A section that needs something not here writes its own — that freedom
 * is the entire reason there is no template.
 */
const BASE_CSS = `
*,*::before,*::after{box-sizing:border-box}
body{margin:0;background:var(--canvas);color:var(--ink);
  font:15px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;
  -webkit-text-size-adjust:100%}
h1,h2,h3,h4{line-height:1.25;margin:0 0 .5em}
h1{font-size:1.6rem}h2{font-size:1.25rem}h3{font-size:1.05rem}
p{margin:0 0 .75em}
a{color:var(--green-deep)}
code,pre,.num{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.wrap{max-width:1100px;margin:0 auto;padding:24px 20px 64px}
.card{background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:16px}
.grid{display:grid;gap:12px}
.grid-2{grid-template-columns:repeat(auto-fit,minmax(260px,1fr))}
.grid-3{grid-template-columns:repeat(auto-fit,minmax(200px,1fr))}
.pill{display:inline-block;padding:2px 8px;border-radius:999px;font-size:11.5px;
  border:1px solid var(--line);background:var(--surface-2);color:var(--ink-3);white-space:nowrap}
.pill.green{background:var(--green-tint);border-color:var(--green-line);color:var(--green-deep)}
.pill.bronze{background:var(--bronze-tint);border-color:var(--bronze-line);color:var(--bronze-ink)}
.pill.brick{background:var(--brick-tint);border-color:var(--brick-line);color:var(--brick)}
.muted{color:var(--ink-3)}
.eyebrow{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--ink-3);font-weight:700}
table{width:100%;border-collapse:collapse;font-size:14px}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line-soft);vertical-align:top}
th{background:var(--surface-2);font-size:11px;letter-spacing:.06em;text-transform:uppercase}
/* Wide content scrolls inside its own box; the page itself never does. */
.scroll-x{overflow-x:auto}
`;

const CHROME_CSS = `
.doc-head{background:var(--surface);border-bottom:1px solid var(--line);padding:18px 20px}
.doc-head .inner{max-width:1100px;margin:0 auto}
.doc-title{font-size:1.5rem;font-weight:700;margin:0}
.doc-sub{color:var(--ink-3);font-size:13px;margin:.35em 0 0}
.tabs{display:flex;flex-wrap:wrap;gap:6px;max-width:1100px;margin:0 auto;padding:12px 20px 0}
.tab{appearance:none;border:1px solid var(--line);background:var(--surface-2);color:var(--ink-2);
  border-radius:999px;padding:6px 14px;font:inherit;font-size:13px;cursor:pointer}
.tab:hover{border-color:var(--ink-4);color:var(--ink)}
.tab[aria-selected="true"]{background:var(--green-tint);border-color:var(--green-line);
  color:var(--green-deep);font-weight:600}
.panel[hidden]{display:none!important}
@media print{.tabs{display:none}.panel[hidden]{display:block!important}}
`;

/**
 * Tab switching. Vanilla, tiny, and no dependency — the CSP forbids fetching
 * one and "self-contained" would be a lie if it did not.
 *
 * Print is handled in CSS above rather than here: somebody will send this to a
 * client as a PDF, and a print that silently dropped eight of nine sections
 * would be the worst possible failure for a document whose whole job is being
 * handed over.
 */
const CHROME_JS = `
(function(){
  var tabs=[].slice.call(document.querySelectorAll('.tab'));
  var panels=[].slice.call(document.querySelectorAll('.panel'));
  if(tabs.length<2){return}
  function show(id){
    tabs.forEach(function(t){t.setAttribute('aria-selected',String(t.dataset.target===id))});
    panels.forEach(function(p){p.hidden=(p.id!==id)});
  }
  tabs.forEach(function(t){t.addEventListener('click',function(){show(t.dataset.target)})});
  show(tabs[0].dataset.target);
})();
`;

export type ShellSection = {
  /** Slug; becomes the panel id and the tab's target. */
  sectionId: string;
  title: string;
  /** The model's fragment, verbatim. */
  html: string;
};

export type ShellMeta = {
  /** Document title — the artifact's own title. */
  title: string;
  /** One line under it: usually the estimate's name. */
  subtitle: string;
  /** Rendered into the footer so a document in a client's inbox is traceable. */
  footer: string;
};

/**
 * Escape text destined for an HTML text node or attribute.
 *
 * Applied to the title, subtitle, footer and every tab label — the parts the
 * shell writes. Not applied to section HTML, which is markup by definition and
 * is contained by the CSP and the sandbox instead.
 */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Wrap the generated sections into one self-contained document.
 *
 * A single section gets no tab bar — a one-tab tab bar is furniture that says
 * nothing. Sections are always wrapped in their own `<section>` with the id the
 * outline gave them, because that element is what the section prompt is told to
 * scope its selectors under, and it is the anchor other sections link to.
 */
export function assembleArtifact(meta: ShellMeta, sections: readonly ShellSection[]): string {
  const many = sections.length > 1;

  const tabs = many
    ? `<nav class="tabs" role="tablist">${sections
        .map(
          (s, i) =>
            `<button class="tab" type="button" role="tab" data-target="panel-${escapeHtml(
              s.sectionId,
            )}" aria-selected="${i === 0}">${escapeHtml(s.title)}</button>`,
        )
        .join('')}</nav>`
    : '';

  const panels = sections
    .map(
      (s, i) =>
        `<section class="panel" id="panel-${escapeHtml(s.sectionId)}" data-section="${escapeHtml(
          s.sectionId,
        )}" role="tabpanel"${many && i > 0 ? ' hidden' : ''}>${s.html}</section>`,
    )
    .join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; font-src data:">
<title>${escapeHtml(meta.title)}</title>
<style>:root{${TOKENS}}${BASE_CSS}${CHROME_CSS}</style>
</head>
<body>
<header class="doc-head">
  <div class="inner">
    <h1 class="doc-title">${escapeHtml(meta.title)}</h1>
    <p class="doc-sub">${escapeHtml(meta.subtitle)}</p>
  </div>
</header>
${tabs}
<main class="wrap">
${panels}
<footer class="muted" style="margin-top:40px;padding-top:16px;border-top:1px solid var(--line-soft);font-size:12px">${escapeHtml(
    meta.footer,
  )}</footer>
</main>
<script>${CHROME_JS}</script>
</body>
</html>`;
}

/**
 * The CSS contract, as the section prompt states it.
 *
 * Exported from the same module that defines the CSS so the two cannot drift —
 * a prompt promising a `.pill.green` the shell stopped shipping is a silent
 * downgrade in every artifact generated afterwards.
 */
export const CSS_CONTRACT = [
  'A stylesheet is already present. You may use these classes:',
  '  .card       a bordered panel on paper-white',
  '  .grid .grid-2 .grid-3   responsive columns (combine: class="grid grid-2")',
  '  .pill, and .pill.green / .pill.bronze / .pill.brick   small status chips',
  '  .eyebrow    a small uppercase label',
  '  .muted      secondary text',
  '  .num        tabular/monospace figures',
  '  .scroll-x   wrap anything wide (tables, diagrams) so the PAGE never scrolls sideways',
  '  table/th/td are already styled — write plain tables.',
  'CSS variables: --ink --ink-2 --ink-3 --ink-4 --surface --surface-2 --canvas',
  '  --line --line-soft --green --green-deep --green-tint --green-line',
  '  --bronze --bronze-ink --bronze-tint --bronze-line --brick --brick-tint --brick-line',
  'This is a floor, not a ceiling: write your own <style> for anything else you need.',
].join('\n');
