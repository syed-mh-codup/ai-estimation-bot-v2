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

/**
 * The diagram renderer, and the one hole in `default-src 'none'`. AEH-324.
 *
 * A section that needs a formal diagram writes NOTATION rather than SVG — see
 * DIAGRAM_CONTRACT — and this is what lays it out. Mermaid is loaded from a CDN
 * because the alternative is not viable: the UMD build is 3,572,661 bytes and
 * these documents live in a Postgres column.
 *
 * ## Why an exact URL rather than the host
 *
 * `script-src https://cdn.jsdelivr.net` would be the obvious spelling and it is
 * the wrong one. That CDN serves any npm package and any GitHub repo, and the
 * corpus these documents are generated from is built out of client-uploaded
 * files — so a prompt injection landing in an estimate could fetch arbitrary
 * code into a document we then hand to a client. A CSP source expression may
 * carry a PATH, and one that does not end in `/` matches that file and nothing
 * else, so the allowance is exactly one immutable URL. The SRI hash is the
 * second lock: the file is content-addressed as well as name-addressed.
 *
 * Everything else stays shut. `connect-src` is absent and so inherits
 * `default-src 'none'`, which the UMD build permits because it is a single
 * esbuild IIFE with its diagram registry inlined — the ESM entry is 30KB but
 * lazy-loads its chunks over the network, which would need the hole widened.
 * Pinned to an exact version because both the path match and the hash are
 * version-specific; a bump means recomputing:
 *
 *   curl -sL <url> | openssl dgst -sha384 -binary | openssl base64 -A
 *
 * ## The allowance is only spent when it is used
 *
 * `assembleArtifact` omits the script tag AND this source from the CSP unless a
 * section actually contains a diagram block. A wireframe pack keeps the header
 * it has always had, byte for byte, and only the documents that need a renderer
 * carry the narrowed one.
 */
const MERMAID_VERSION = '11.17.2';
const MERMAID_URL = `https://cdn.jsdelivr.net/npm/mermaid@${MERMAID_VERSION}/dist/mermaid.min.js`;
const MERMAID_SRI = 'sha384-EOXBFmc3gx5mb+vn0vPvvGqACToJD24hhacX5Yx+8NUUQrHIle/Qi5Bg9o3zKwW2';

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
/* Notation, before the renderer reaches it — and permanently if it never does. */
pre.diagram{margin:0 0 1em;padding:12px 14px;overflow-x:auto;white-space:pre;
  background:var(--surface-2);border:1px solid var(--line-soft);border-radius:8px;
  font-size:12.5px;line-height:1.5;color:var(--ink-2)}
pre.diagram[data-diagram-error]{background:var(--brick-tint);border-color:var(--brick-line)}
/* And after: a pan/zoom viewport, not a scroll box. See DIAGRAM_JS. */
.diagram{margin:0 0 1em;border:1px solid var(--line-soft);border-radius:8px;
  background:var(--surface);overflow:hidden}
.diagram-view{position:relative;height:clamp(300px,58vh,700px);overflow:hidden;
  cursor:grab;touch-action:none}
.diagram-view.is-dragging{cursor:grabbing}
.diagram-view:focus-visible{outline:2px solid var(--green);outline-offset:-2px}
/* transform-origin at the corner keeps the zoom-at-cursor arithmetic linear. */
.diagram-pan{position:absolute;top:0;left:0;transform-origin:0 0}
.diagram-pan svg{display:block;height:auto;max-width:none}
.diagram-bar{display:flex;align-items:center;gap:5px;padding:6px 8px;
  border-top:1px solid var(--line-soft);background:var(--surface-2)}
.diagram-bar button{appearance:none;border:1px solid var(--line);background:var(--surface);
  color:var(--ink-2);border-radius:6px;padding:3px 9px;font:inherit;font-size:12px;
  line-height:1.45;cursor:pointer}
.diagram-bar button:hover{border-color:var(--ink-4);color:var(--ink)}
.diagram-zoom{font-size:11px;color:var(--ink-4);min-width:44px;text-align:center}
.diagram-hint{margin-left:auto;font-size:11px;color:var(--ink-4)}
/* Maximised: real fullscreen where the viewer delegates it, this where it does not. */
.diagram.is-max{position:fixed;inset:0;z-index:9999;margin:0;border:0;border-radius:0;
  background:var(--canvas);display:flex;flex-direction:column}
.diagram.is-max .diagram-view,.diagram:fullscreen .diagram-view{height:auto;flex:1}
.diagram:fullscreen{background:var(--canvas);display:flex;flex-direction:column;
  border:0;border-radius:0}
@media print{
  /* A zoomed diagram would otherwise print as a crop of itself. */
  .diagram.is-max{position:static;inset:auto}
  .diagram-view{height:auto;overflow:visible}
  .diagram-pan{position:static;transform:none!important}
  .diagram-bar{display:none}
}
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

/**
 * Turn every diagram block into an SVG. AEH-324.
 *
 * ## Why `render` and not `run`
 *
 * Mermaid's `run()` renders nodes where they sit, and that is exactly wrong
 * here: every panel after the first is assembled `hidden`, and `getBBox()`
 * returns zeros inside `display:none`, so a diagram in any tab but the first
 * would lay out with every label measured as zero-width and come back as a pile
 * of collapsed boxes. `render()` measures in its own temporary container
 * attached to `<body>` — always visible, regardless of which tab the block is
 * in — and hands back the markup to inject. It is also the only form that lets
 * a parse failure be caught, rather than mermaid replacing the block with its
 * own "Syntax error" bomb graphic inside a document bound for a client.
 *
 * ## Every exit leaves the notation on screen
 *
 * No mermaid (offline, CDN blocked, SRI mismatch), no `initialize`, a rejected
 * `render` — all of them return without touching the block, so the reader gets
 * the notation as text. That is the whole fallback story and it is why the
 * `<pre>` ships visible instead of hidden.
 *
 * Loaded after CHROME_JS so tab switching is live before 3.5MB starts
 * downloading; a slow connection must not leave the navigation dead.
 *
 * ## Navigating one, once it is drawn — AEH-329
 *
 * `navigate()` makes a rendered diagram zoomable, draggable and full-screenable.
 * It is called from render()'s SUCCESS path only: a block mermaid could not
 * parse keeps its visible `<pre>`, and a zoom control attached to notation
 * nobody can zoom would be worse than no control at all.
 *
 * Mechanically it is one `translate` plus `scale` on `.diagram-pan` inside a
 * fixed-height `.diagram-view`. Hand-rolled rather than svg-pan-zoom or
 * d3-zoom, because a second library means a second entry in `script-src` and
 * the whole point of the exact-path pin above is that there is only ever one.
 * Zoom is applied ABOUT A POINT, so whatever is under the cursor stays under
 * it — that is the `x = px - (px - x) * (k'/k)` line, and it is why
 * `transform-origin` is pinned to the corner.
 *
 * ## Fit means fit to WIDTH, and that was measured
 *
 * Fitting both axes is the obvious reading of "fit" and it is wrong here. The
 * first real document tried against this — a seven-journey user flow on the
 * Geoshield estimate — has flowcharts about 625px wide and 2,575px tall, and
 * fitting both put them on screen at 16%, which is a grey smudge rather than a
 * diagram. So it fits WIDTH, top-aligned, and the reader pans down to follow
 * the flow, the way any document viewer behaves.
 *
 * FLOOR then covers the opposite shape: a very wide ERD would fit its width at
 * 20% and be just as unreadable, so it stops shrinking at 0.35 and is panned
 * sideways instead. On either axis, an axis the diagram DOES fit is centred and
 * one it does not starts at that edge — never centred-and-cropped-both-ends.
 *
 * The whole-diagram overview is still one click away on the minus button, with
 * the percentage readout saying where you are.
 *
 * ## Fit meets the hidden-panel trap from both sides
 *
 * Fitting needs the diagram's size and the viewport's, and a panel that is not
 * the frontmost one is assembled `hidden`:
 *
 * - The DIAGRAM's size is read from the `width`/`height` attributes mermaid
 *   writes, which `useMaxWidth:false` makes intrinsic. Never `getBBox()` or
 *   `getBoundingClientRect()`, which are the calls that return zeros under
 *   `display:none` — the same trap that decided render() over run().
 * - The VIEWPORT's size cannot be faked that way, so the first honest fit is
 *   driven by a `ResizeObserver`: it fires when the box first has a non-zero
 *   size, which is when the reader opens that tab. It also covers a window
 *   resize, and it stands down once the reader has zoomed or dragged, so it
 *   never re-fits out from under somebody.
 *
 * ## Two deliberate refusals
 *
 * A bare wheel is left alone and only ctrl/cmd+wheel zooms. A document whose
 * tab is one large diagram would otherwise be impossible to scroll past with
 * the pointer over it, which is the failure every embedded map used to have.
 *
 * And full screen is two-tier. `document.fullscreenEnabled` is FALSE inside
 * `sandbox="allow-scripts"` unless the viewer delegates it with
 * `allow="fullscreen"` — measured, with this document's own CSP, and the origin
 * stays opaque either way, so the delegation is not a loosening of the sandbox.
 * A downloaded copy is a top-level document and has it outright. Where it is
 * missing the control falls back to `position:fixed` inside the document, which
 * fills the frame rather than the screen: smaller, but the feature degrades
 * instead of doing nothing when clicked. State is synced from
 * `fullscreenchange` so the browser's own Escape cannot desync the label.
 *
 * Comments here are kept terse ON PURPOSE. Every byte of this string ships
 * inside every artifact that draws, so the reasoning lives up here where it
 * does not.
 */
const DIAGRAM_JS = `
(function(){
  function navigate(box){
    var view=box.querySelector('.diagram-view');
    var pan=box.querySelector('.diagram-pan');
    var svg=pan.querySelector('svg');
    var readout=box.querySelector('.diagram-zoom');
    var fullBtn=box.querySelector('[data-act="full"]');
    if(!view||!pan||!svg){return}

    var k=1,x=0,y=0;
    /* Reader picked their own view; stop auto-fitting under them. */
    var touched=false;
    var MIN=0.1,MAX=8,FLOOR=0.35;

    function apply(){
      pan.style.transform='translate('+x+'px,'+y+'px) scale('+k+')';
      readout.textContent=Math.round(k*100)+'%';
    }
    function clamp(v){return v<MIN?MIN:v>MAX?MAX:v}

    /* Intrinsic size. Anything measured in a hidden panel reads zero. */
    function natural(){
      var w=parseFloat(svg.getAttribute('width'))||svg.viewBox.baseVal.width||0;
      var h=parseFloat(svg.getAttribute('height'))||svg.viewBox.baseVal.height||0;
      return {w:w,h:h};
    }

    function fit(){
      var n=natural();
      var vw=view.clientWidth,vh=view.clientHeight;
      /* Still hidden. The observer calls back when it is not. */
      if(!n.w||!n.h||!vw||!vh){return false}
      /* Width, not both, and never below FLOOR. See the note above. */
      k=clamp(Math.max(Math.min(vw/n.w,1),FLOOR));
      /* Centre on an axis it fits, otherwise start at that edge. */
      x=Math.max(0,(vw-n.w*k)/2);
      y=Math.max(0,(vh-n.h*k)/2);
      apply();
      return true;
    }

    /* Zoom about a point, so the thing under the cursor stays under it. */
    function zoomAt(px,py,factor){
      var nk=clamp(k*factor);
      if(nk===k){return}
      x=px-(px-x)*(nk/k);
      y=py-(py-y)*(nk/k);
      k=nk;
      touched=true;
      apply();
    }
    function zoomCentre(factor){zoomAt(view.clientWidth/2,view.clientHeight/2,factor)}

    /* drag to pan; two pointers pinch */
    var pointers={},last=null,pinch=null;

    view.addEventListener('pointerdown',function(e){
      pointers[e.pointerId]={x:e.clientX,y:e.clientY};
      view.setPointerCapture(e.pointerId);
      var ids=Object.keys(pointers);
      if(ids.length===1){last={x:e.clientX,y:e.clientY};view.classList.add('is-dragging')}
      else if(ids.length===2){
        var a=pointers[ids[0]],b=pointers[ids[1]];
        pinch=Math.hypot(a.x-b.x,a.y-b.y);
        last=null;
      }
    });

    view.addEventListener('pointermove',function(e){
      if(!pointers[e.pointerId]){return}
      pointers[e.pointerId]={x:e.clientX,y:e.clientY};
      var ids=Object.keys(pointers);
      if(ids.length===2&&pinch){
        var a=pointers[ids[0]],b=pointers[ids[1]];
        var d=Math.hypot(a.x-b.x,a.y-b.y);
        if(d>0){
          var r=view.getBoundingClientRect();
          zoomAt((a.x+b.x)/2-r.left,(a.y+b.y)/2-r.top,d/pinch);
          pinch=d;
        }
        return;
      }
      if(!last){return}
      x+=e.clientX-last.x;
      y+=e.clientY-last.y;
      last={x:e.clientX,y:e.clientY};
      touched=true;
      apply();
    });

    function release(e){
      delete pointers[e.pointerId];
      if(Object.keys(pointers).length<2){pinch=null}
      if(!Object.keys(pointers).length){last=null;view.classList.remove('is-dragging')}
    }
    view.addEventListener('pointerup',release);
    view.addEventListener('pointercancel',release);

    /* Modifier only: a bare wheel must still scroll the page. */
    view.addEventListener('wheel',function(e){
      if(!e.ctrlKey&&!e.metaKey){return}
      e.preventDefault();
      var r=view.getBoundingClientRect();
      zoomAt(e.clientX-r.left,e.clientY-r.top,e.deltaY<0?1.12:1/1.12);
    },{passive:false});

    view.addEventListener('dblclick',function(){touched=false;fit()});

    view.addEventListener('keydown',function(e){
      if(e.key==='+'||e.key==='='){zoomCentre(1.2);e.preventDefault()}
      else if(e.key==='-'||e.key==='_'){zoomCentre(1/1.2);e.preventDefault()}
      else if(e.key==='0'){touched=false;fit();e.preventDefault()}
      /* Escape for the CSS fallback; the browser owns real full screen. */
      else if(e.key==='Escape'&&box.classList.contains('is-max')){
        box.classList.remove('is-max');
        syncFull();
        e.preventDefault();
      }
    });

    /* full screen, falling back to filling the frame */
    function isFull(){
      return document.fullscreenElement===box||box.classList.contains('is-max');
    }
    function syncFull(){
      fullBtn.textContent=isFull()?'Exit full screen':'Full screen';
      /* Re-fit unless the reader has chosen their own zoom. */
      if(!touched){requestAnimationFrame(fit)}
    }
    function maximise(on){box.classList.toggle('is-max',on);syncFull()}

    fullBtn.addEventListener('click',function(){
      if(document.fullscreenElement===box){
        if(document.exitFullscreen){document.exitFullscreen()}
        return;
      }
      if(box.classList.contains('is-max')){maximise(false);return}
      /* False in the viewer unless it delegates; true when downloaded. */
      if(document.fullscreenEnabled&&box.requestFullscreen){
        box.requestFullscreen().then(syncFull).catch(function(){maximise(true)});
      }else{
        maximise(true);
      }
    });

    document.addEventListener('fullscreenchange',syncFull);

    box.querySelector('[data-act="in"]').addEventListener('click',function(){zoomCentre(1.2)});
    box.querySelector('[data-act="out"]').addEventListener('click',function(){zoomCentre(1/1.2)});
    box.querySelector('[data-act="fit"]').addEventListener('click',function(){touched=false;fit()});

    /* The first honest viewport measurement arrives when its tab opens. */
    if(window.ResizeObserver){
      new ResizeObserver(function(){if(!touched){fit()}}).observe(view);
    }
    fit();
  }

  var blocks=[].slice.call(document.querySelectorAll('pre.diagram'));
  if(!blocks.length){return}
  var m=window.mermaid;
  if(!m||typeof m.render!=='function'){return}
  try{
    m.initialize({
      startOnLoad:false,
      securityLevel:'strict',
      theme:'base',
      fontFamily:'ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif',
      themeVariables:{
        background:'#fbfaf6',primaryColor:'#f4f2ea',primaryTextColor:'#23211b',
        primaryBorderColor:'#d6d1c1',secondaryColor:'#e0e8dd',tertiaryColor:'#f2e7ce',
        lineColor:'#948f81',textColor:'#555146',fontSize:'14px'
      },
      /* Natural size, so Fit can compute a scale and zooming stays crisp. */
      er:{useMaxWidth:false},sequence:{useMaxWidth:false},
      flowchart:{useMaxWidth:false},state:{useMaxWidth:false}
    });
  }catch(e){return}
  blocks.forEach(function(pre,i){
    /* textContent, so the &lt; the notation had to be written with decodes
       back to the "<" mermaid expects. */
    var src=(pre.textContent||'').trim();
    if(!src){return}
    try{
      m.render('mmd-'+i,src).then(function(out){
        var box=document.createElement('div');
        box.className='diagram';
        box.innerHTML=
          '<div class="diagram-view" tabindex="0"><div class="diagram-pan">'+out.svg+
          '</div></div><div class="diagram-bar">'+
          '<button type="button" data-act="out" title="Zoom out">&minus;</button>'+
          '<button type="button" data-act="in" title="Zoom in">+</button>'+
          '<span class="diagram-zoom">100%</span>'+
          '<button type="button" data-act="fit">Fit</button>'+
          '<button type="button" data-act="full">Full screen</button>'+
          '<span class="diagram-hint">drag to move &middot; ctrl+scroll to zoom</span>'+
          '</div>';
        pre.parentNode.replaceChild(box,pre);
        if(out.bindFunctions){try{out.bindFunctions(box.querySelector('.diagram-pan'))}catch(e){}}
        navigate(box);
      }).catch(function(){
        pre.setAttribute('data-diagram-error','1');
      });
    }catch(e){
      pre.setAttribute('data-diagram-error','1');
    }
  });
})();
`;

/**
 * The block marker, in the one place that owns it.
 *
 * The shell reads it to decide whether a document needs the renderer at all;
 * generation reads it to check and repair what the model wrote. Two regexes
 * spelling the same contract in two files is how they drift, so both live here
 * beside the CSS and the prompt text that describe the same block.
 *
 * Deliberately lenient about the tag: a model asked for `class="diagram"` will
 * eventually write `class="diagram scroll-x"` or add an attribute, and that is
 * a block, not a failure. `normaliseDiagramBlocks` rewrites the tag to the
 * canonical form, so nothing downstream has to be this forgiving twice.
 */
const DIAGRAM_BLOCK_SOURCE =
  '<pre\\b[^>]*\\bclass\\s*=\\s*["\'][^"\']*\\bdiagram\\b[^>]*>([\\s\\S]*?)<\\/pre>';

/** Fresh each call: a shared global regex carries `lastIndex` between callers. */
export function diagramBlockRe(): RegExp {
  return new RegExp(DIAGRAM_BLOCK_SOURCE, 'gi');
}

/** Does this fragment contain a diagram block? Decides the CSP and the script tag. */
export function hasDiagramBlock(html: string): boolean {
  return new RegExp(DIAGRAM_BLOCK_SOURCE, 'i').test(html);
}

/**
 * The notation keywords a block may open with.
 *
 * A whitelist rather than a real parse, and the trade is deliberate: it is the
 * check that costs nothing and catches the failures a retry actually fixes — a
 * markdown fence nested inside the fragment, prose where notation was asked
 * for, an empty block. A genuine parse needs mermaid, which needs a DOM; when
 * that matters the browser does it, and the fallback shows the notation.
 *
 * `graph` and the un-suffixed `stateDiagram` are here because they are valid
 * mermaid that models emit constantly, and rejecting notation that would have
 * rendered perfectly is a worse failure than accepting a spelling we did not
 * suggest.
 */
export const DIAGRAM_KEYWORDS = [
  'erDiagram',
  'sequenceDiagram',
  'stateDiagram-v2',
  'stateDiagram',
  'flowchart',
  'graph',
] as const;

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

  // Only a document that actually draws a diagram pays for the renderer, in
  // bytes or in policy. See the MERMAID_URL note: the CSP allowance is one
  // exact file, and a document with no diagram keeps the header it has always
  // had — no https source at all.
  const needsDiagrams = sections.some((s) => hasDiagramBlock(s.html));
  const scriptSrc = needsDiagrams ? `'unsafe-inline' ${MERMAID_URL}` : `'unsafe-inline'`;
  const renderer = needsDiagrams
    ? `\n<script src="${MERMAID_URL}" integrity="${MERMAID_SRI}" crossorigin="anonymous"></script>\n<script>${DIAGRAM_JS}</script>`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src ${scriptSrc}; img-src data:; font-src data:">
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
<script>${CHROME_JS}</script>${renderer}
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
  '  .diagram    on a <pre>, a formal diagram written as notation — see below',
  '  table/th/td are already styled — write plain tables.',
  'CSS variables: --ink --ink-2 --ink-3 --ink-4 --surface --surface-2 --canvas',
  '  --line --line-soft --green --green-deep --green-tint --green-line',
  '  --bronze --bronze-ink --bronze-tint --bronze-line --brick --brick-tint --brick-line',
  'This is a floor, not a ceiling: write your own <style> for anything else you need.',
].join('\n');

/**
 * How to write a formal diagram. AEH-324.
 *
 * Given to EVERY section, not just the ones the outline marked `'diagram'`. A
 * prose section explaining a checkout flow legitimately wants a sequence
 * diagram in the middle of it, and the outline's mark is about the word budget
 * and about not splitting, never about permission — see `kind` on
 * ArtifactOutlineSectionSchema.
 *
 * The angle-bracket rule is the one that earns its length. `stateDiagram-v2`
 * spells a fork as `<<fork>>` and flowchart labels carry `<br>`, and written
 * raw inside a `<pre>` those are markup rather than notation. Generation
 * repairs it either way — see `normaliseDiagramBlocks` — but a model told the
 * rule mostly gets it right, and a repair that never has to run is the cheap
 * kind.
 */
export const DIAGRAM_CONTRACT = [
  'FORMAL DIAGRAMS: write the notation, not the drawing.',
  'This block is about entity relationship diagrams, sequences, state machines',
  'and flows — notations with a standard shape and a mechanical layout. It does',
  'NOT apply to wireframes or low-fidelity UI: those have no formal notation,',
  'their free-form arrangement IS the deliverable, and they stay HTML and CSS as',
  'described above. If there is no formal diagram in your section, nothing in the',
  'rest of this block applies to you.',
  '',
  'For one that there is: do NOT hand-draw the SVG. Write Mermaid notation in a',
  '<pre class="diagram"> and it is laid out for you:',
  '',
  '  <pre class="diagram">erDiagram',
  '  CUSTOMER {',
  '    uuid id PK',
  '    string email "unique"',
  '    datetime createdAt',
  '  }',
  '  ORDER {',
  '    uuid id PK',
  '    uuid customerId FK',
  '    decimal total',
  '  }',
  '  CUSTOMER ||--o{ ORDER : places',
  '  ORDER ||--|{ ORDER_LINE : contains',
  '</pre>',
  '',
  '- An ENTITY DIAGRAM gives every entity its ATTRIBUTES, as above — type, name,',
  '  then PK or FK on the key columns, and a short note in "quotes" where one',
  '  earns its place. Boxes with only names in them are not an entity model,',
  '  they are a list of nouns with lines between them, and a reader learns',
  '  nothing from them they could not have guessed from the brief.',
  '- The first line must start with one of: erDiagram, sequenceDiagram,',
  `  stateDiagram-v2, flowchart, graph. Nothing before it — no blank line, no`,
  '  comment, no markdown fence. A fence is what the <pre> replaces.',
  '- It is Mermaid syntax, inside HTML. So write &lt; for "<" and &amp; for "&".',
  '  A state fork is &lt;&lt;fork&gt;&gt; and a line break in a label is &lt;br&gt;.',
  '  Arrows contain no "<" — write --> and ->> and --o{ exactly as they are.',
  '- One diagram per block. Several blocks are fine, and so is prose, a heading',
  '  and a legend around them: a diagram almost always needs a sentence saying',
  '  what to look at, and an unexplained one is half a deliverable.',
  '- Layout is not your problem. No coordinates, no widths, no positions, and no',
  '  <style> for the diagram — it is themed to match this page already.',
].join('\n');
