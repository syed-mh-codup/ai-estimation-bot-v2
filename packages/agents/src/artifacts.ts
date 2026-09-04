import { type CorpusSectionKey, type PrismaClient } from '@repo/db';
import type { IModelProvider } from '@repo/providers';
import {
  ArtifactOutlineSchema,
  type ArtifactOutline,
  type ArtifactProgress,
} from '@repo/shared';

import { buildArtifactDossier, renderArtifactDossier } from './artifact-dossier';
import { CSS_CONTRACT, assembleArtifact, type ShellSection } from './artifact-shell';
import { chatJSON } from './llm-json';
import { createUsageRecorder, type UsageRecorder } from './usage-recorder';

/**
 * Generating one supporting document. AEH-239.
 *
 * ## Shape, and why it is this shape
 *
 * The requester's reference artifact is ~100KB — roughly 25,000 output tokens.
 * The deploy target's per-step ceiling is a hard 300s with Vercel Pro ruled
 * out, so one model call cannot produce it. But Inngest invokes one
 * `step.run()` per HTTP request, so each step gets its own 300s. Generation is
 * therefore:
 *
 *   1        outline   plan the sections (small, fast)
 *   2..N+1   section   write one section's HTML each (own step, own budget)
 *   N+2      assemble  wrap them in the shared shell
 *
 * That is the same answer `runEstimate` reached for the same reason, and it
 * scales by content with no special cases: a small document is a few sections
 * and a few steps, a large one is a dozen. More sections is the SAFE direction,
 * because each is generated separately — see SECTION_WORD_BUDGET for what the
 * first real run cost us by planning too few.
 *
 * ## What is code and what is data
 *
 *   > anything specific to one artifact is data;
 *   > anything shared by every artifact is code.
 *
 * The author writes a BRIEF. The envelope below — the JSON contract, the
 * fragment rules, the scoping rule, the CSS vocabulary, the size budget — is
 * code, wrapped around that brief at call time. So a prompt edit cannot break
 * generation, which matters because every artifact type in this system is
 * hand-authored with no seeded example to copy.
 */

// The same `StepRunner` a run uses — reused rather than redeclared, because the
// two pipelines are handed the identical Inngest `step.run` and a second
// structurally-equal type would just be a place for them to drift.
import type { StepRunner } from './run-estimate';

/**
 * The per-section output budget, in words, that the outline is told to plan
 * around.
 *
 * A number rather than "keep it short" because the ceiling is a real constraint
 * and vagueness spends it: this is the figure that makes the model SPLIT a
 * large subject rather than trying to fit it into one section and timing out.
 *
 * Started at 1200 and was cut to 700 on 3 September, by measurement rather than
 * taste. The first real generation planned four sections for an ERD and wrote
 * 7,073 then 14,935 output tokens — the second of those about 2.5x the intent —
 * before the third exceeded the function's 300s and returned a gateway 504.
 *
 * The budget alone does not hold, and 4 September proved it twice. Stating it
 * in the OUTLINE envelope did nothing, because the outline is not what writes
 * the section — the section envelope had never been told the figure at all, and
 * was being told to write "in full" and not to summarise. Once it WAS told, a
 * seven-section ERD still came back at 10,127, 11,247 and 12,309 characters —
 * roughly 1,800 words each, near three times the budget — and its fourth
 * section exceeded a 240s call budget twice and failed the run.
 *
 * The lever that has actually moved this is SECTION COUNT, which is why the
 * outline envelope now sets a floor of ten rather than a preference for five to
 * twelve. A document's total volume is roughly what the model wants to say; the
 * ceiling is per CALL. So the only way to fit is more calls, each smaller.
 */
const SECTION_WORD_BUDGET = 700;

/**
 * How much thinking an artifact call is allowed, and how long it may take.
 *
 * Both are AEH-321. Every generation before it died the same way: one step ran
 * past Vercel's 300s, the platform killed the process with
 * FUNCTION_INVOCATION_TIMEOUT, and Inngest recorded a bare "your server
 * returned HTTP 504" with no step output and no clue which section did it.
 *
 * Measured against the exact ERD section that had been taking runs down — same
 * prompt, same model, one variable:
 *
 *   default        143.4s   41,336 completion tokens (33,542 of them reasoning)
 *   effort 'low'    87.3s    3,909 completion tokens (1,396 of them reasoning)
 *
 * Reasoning was ~80% of the wall clock and ~90% of the tokens, and it is billed
 * as completion, so turning it down is the same lever for the deadline and the
 * bill. The visible document survives it: 14,470 characters of HTML against
 * 26,876, which is nearer the planned budget anyway.
 *
 * Not `{ enabled: false }`. That was measured too: the same call with reasoning
 * off hung for over nine minutes and never returned. Down, never off.
 *
 * The timeout is the guard rail rather than the fix. 240s leaves ~60s of the
 * function's 300s for the step to record a real error, so a slow call now fails
 * saying which model exceeded what — and the sections already written survive
 * for the resume, which a 504 also allowed but never explained.
 *
 * Both are constants here and belong in the artifact type's own version row
 * next to `modelString`, which an admin already edits. That is AEH-322.
 */
const ARTIFACT_REASONING = { effort: 'low' } as const;
const ARTIFACT_TIMEOUT_MS = 240_000;

/**
 * There is deliberately NO max_tokens on the section call. It was tried, on
 * 3 September, and it made things worse.
 *
 * The reasoning was that capping output would keep a section inside the
 * function's time budget. What actually happened: the very next generation
 * spent eight minutes on its first section and returned `content: null` with
 * the cap consumed — on a reasoning model the token budget can be spent
 * thinking, before a single character of answer is emitted, so the cap does not
 * shorten the output, it deletes it.
 *
 * Two things replaced it, and both are better:
 *
 * - Sections are kept small by PLANNING, not truncation. Cutting the word
 *   budget to 700 and asking for 5-12 sections took one real document from four
 *   sections to eleven, which is the outcome the cap was reaching for.
 * - An empty section now fails loudly, naming the provider's finish_reason,
 *   rather than being silently assembled into a client-facing document.
 *
 * If a time ceiling ever needs enforcing again, do it by making sections
 * smaller or by splitting them further — never by cutting the model off
 * mid-thought.
 */

const OUTLINE_ENVELOPE = `
You are planning a self-contained HTML document that will be generated section
by section, then assembled into one page with tabs.

Plan the sections. Return JSON only, matching exactly:
{
  "title": "the document's own title",
  "vocabulary": ["names, ids and terms every section must use identically"],
  "sections": [{ "id": "a-slug", "title": "Tab label", "brief": "what this section must contain" }]
}

Rules that decide whether this document can be produced at all:

- Each section is written by a SEPARATE later call that will NOT see the other
  sections' output. It sees only: the source material, this whole outline, and
  its own brief. So each brief must stand alone.
- Each section must fit in about ${SECTION_WORD_BUDGET} words of rendered
  content. If a subject is bigger than that, SPLIT IT into several sections.
  This is a hard production constraint, not a style preference: a section that
  runs long takes the whole document down with a timeout. That has happened.
- So PREFER MORE, SMALLER SECTIONS. There is no cost to a document having many
  sections and a real cost to it having few: each is generated separately, so
  ten small ones succeed where four large ones fail. If a subject could be one
  section or three, make it three.
- A section covering "everything about X" is almost always too big. Split by
  the natural seams in the material — by domain, by actor, by phase, by
  lifecycle stage — and give each seam its own section.
- "vocabulary" is how the document stays coherent. Put every proper noun the
  sections must agree on in it — entity names, journey ids, tranche labels. If
  two sections would otherwise name the same thing differently, that name
  belongs here.
- Plan AT LEAST 10 sections, and prefer 12-20. Fewer than ten is almost always
  wrong: it means some section is carrying more than one subject, and that is
  the section that will run long and take the document down. Splitting costs
  nothing — each section is a separate call with its own budget — so when in
  doubt, split.
- "id" must be lowercase, hyphenated, and unique.

Base the plan on the source material you are given. Do not invent scope that is
not there.
`.trim();

const SECTION_ENVELOPE = `
You are writing ONE section of a larger HTML document.

Return an HTML FRAGMENT and nothing else. No <!doctype>, no <html>, no <head>,
no <body>, no markdown fences, no commentary before or after. Start with your
first element.

The page around you already exists: it supplies the document title, the tab bar,
the navigation and the footer. Do not re-create any of them, and do not write a
tab bar of your own.

You may include <style> and <script> in your fragment. Your section is wrapped in
an element with the id given below, so SCOPE EVERY SELECTOR under it —
  #panel-<your-section-id> .thing { ... }
— never a bare ".thing", or your styles will fight the other sections'.

${CSS_CONTRACT}

Anything wide — a table, a diagram, a wide grid — must be inside an element with
class "scroll-x" so it scrolls itself. The page must never scroll sideways.

Images cannot be fetched. Draw with HTML, CSS and inline SVG.

Aim for about ${SECTION_WORD_BUDGET} words of rendered content. This is the
figure your section was PLANNED against — the outline split the document so that
each part would fit it — and it is a production constraint, not a style note: a
section that runs long takes the whole document down with a timeout.

Cover your whole brief, and leave no placeholders for a human to fill in. If the
brief looks bigger than the budget, write the part that matters most and trust
the sections around you to carry the rest — they were planned to.
`.trim();

/**
 * Everything the outline call needs, gathered once.
 *
 * Shared by generation and by the dry run so the two cannot diverge: a preview
 * that assembled its corpus differently from the real thing would be worse than
 * no preview at all, because it would be trusted.
 */
async function prepare(
  db: PrismaClient,
  estimateId: string,
  artifactTypeId: string,
  typeVersion: number,
): Promise<{
  corpus: string;
  promptBody: string;
  modelString: string;
  retired: string[];
  empty: CorpusSectionKey[];
}> {
  const version = await db.artifactTypeVersion.findUniqueOrThrow({
    where: { artifactTypeId_version: { artifactTypeId, version: typeVersion } },
    select: { promptBody: true, modelString: true, corpusSections: true },
  });

  const dossier = await buildArtifactDossier(db, estimateId, version.corpusSections);
  if (!dossier) throw new Error('That estimate no longer exists.');
  if (Object.keys(dossier.sections).length === 0) {
    // Every requested section came back empty. Generating anyway would spend
    // real money to produce a document about nothing, and the model would fill
    // the gap by inventing scope — the same failure the empty-SOW guard in
    // runEstimate exists to prevent.
    throw new Error(
      'Nothing to work from: every section this artifact reads is empty on this estimate. Run it first, or tick different sections on the artifact type.',
    );
  }

  return {
    corpus: renderArtifactDossier(dossier),
    promptBody: version.promptBody,
    modelString: version.modelString,
    retired: dossier.retired,
    empty: dossier.empty,
  };
}

/** The outline call. One place, so generation and the dry run plan identically. */
async function planOutline(
  modelProvider: IModelProvider,
  prep: { corpus: string; promptBody: string; modelString: string },
  recorder: UsageRecorder,
): Promise<ArtifactOutline> {
  return chatJSON(
    modelProvider,
    {
      model: prep.modelString,
      messages: [
        { role: 'system', content: `${OUTLINE_ENVELOPE}\n\n--- THE BRIEF ---\n${prep.promptBody}` },
        { role: 'user', content: prep.corpus },
      ],
      // Zero, like every other structured agent here: the same estimate should
      // plan the same document twice. It is also what makes the dry run
      // predictive rather than merely indicative.
      temperature: 0,
      reasoning: ARTIFACT_REASONING,
      timeoutMs: ARTIFACT_TIMEOUT_MS,
    },
    ArtifactOutlineSchema,
    'ARTIFACT_OUTLINE',
    { kind: 'ARTIFACT', recorder },
  );
}

export type ArtifactPreview = {
  outline: ArtifactOutline;
  /** Section keys the type asks for that this build no longer has. */
  retired: string[];
  /** Section keys that are empty on this estimate. */
  empty: CorpusSectionKey[];
};

/**
 * Plan the document without writing it. AEH-239.
 *
 * This exists because of the no-seed decision: every artifact type is authored
 * by hand with no example to copy, so a brief is written by iterating. The
 * outline step is one call and a couple of thousand tokens, and it answers the
 * only question that matters early — did my brief produce a sensible plan? —
 * in seconds, for a rounding error, instead of committing to nine sections of
 * generation to find out.
 *
 * Writes nothing. No artifact row, so no half-made document to clean up, and
 * `artifactId` on the usage row is null: the spend is real and belongs to the
 * estimate, but there is no document for it to belong to.
 */
export async function previewArtifactOutline(args: {
  db: PrismaClient;
  estimateId: string;
  artifactTypeId: string;
  typeVersion: number;
  modelProvider: IModelProvider;
}): Promise<ArtifactPreview> {
  const { db, estimateId, artifactTypeId, typeVersion, modelProvider } = args;

  const prep = await prepare(db, estimateId, artifactTypeId, typeVersion);
  const recorder = createUsageRecorder({ db, estimateId });
  const outline = await planOutline(modelProvider, prep, recorder);

  return { outline, retired: prep.retired, empty: prep.empty };
}

export type ArtifactRunDeps = {
  db: PrismaClient;
  artifactId: string;
  modelProvider: IModelProvider;
  /** Durable step runner. Defaults to inline, which is what tests use. */
  step?: StepRunner;
  onProgress?: (p: ArtifactProgress) => Promise<void> | void;
};

export type ArtifactRunResult = {
  title: string;
  sections: number;
  chars: number;
};

/**
 * Normalise a model-supplied slug into something safe as an HTML id.
 *
 * The outline schema only requires a non-empty string, and a model asked for a
 * slug will eventually return "Entity Model (core)". Left alone that lands in
 * an `id` attribute and a CSS selector, where a space or a paren silently
 * breaks tab switching.
 *
 * Falls back to a positional id rather than throwing: losing a nice anchor is
 * not worth failing a document that is otherwise fine.
 */
export function normaliseSectionId(raw: string, index: number): string {
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '');
  return slug || `section-${index + 1}`;
}

/**
 * Make every section id unique.
 *
 * Two sections sharing an id means one tab shows the other's panel — a bug that
 * looks like the model wrote the wrong content, and would be debugged in the
 * prompt for hours before anyone suspected the ids.
 */
export function uniqueSectionIds(raw: readonly string[]): string[] {
  const seen = new Set<string>();
  return raw.map((id, i) => {
    let candidate = normaliseSectionId(id, i);
    for (let n = 2; seen.has(candidate); n += 1) candidate = `${normaliseSectionId(id, i)}-${n}`;
    seen.add(candidate);
    return candidate;
  });
}

/**
 * Strip a markdown fence the model wrapped its HTML in.
 *
 * The section prompt forbids fences and models do it anyway, especially when
 * the content is code-like. Left in, the literal characters ```html render as
 * visible text at the top of a client-facing document — a cosmetic failure with
 * an embarrassing blast radius, and one line to prevent.
 *
 * Only a fence wrapping the WHOLE response is removed. A fence inside a section
 * that is legitimately showing markup is left exactly as it is.
 */
export function stripFence(text: string): string {
  const trimmed = text.trim();
  const match = /^```(?:html|HTML)?\s*\n([\s\S]*?)\n?```$/.exec(trimmed);
  return match ? match[1]!.trim() : trimmed;
}

/** The section call's user message. Exported so a test can assert what is sent. */
export function sectionPrompt(args: {
  outline: ArtifactOutline;
  index: number;
  sectionId: string;
  corpus: string;
  /** Titles and briefs of sections already written — never their HTML. */
  done: { title: string; brief: string }[];
}): string {
  const { outline, index, sectionId, corpus, done } = args;
  const section = outline.sections[index]!;

  const parts = [
    `Document: ${outline.title}`,
    '',
    `You are writing section ${index + 1} of ${outline.sections.length}: "${section.title}".`,
    `Your section's id is "${sectionId}", so scope your CSS under #panel-${sectionId}.`,
    '',
    'Your brief:',
    section.brief,
  ];

  if (outline.vocabulary.length) {
    parts.push(
      '',
      'Use these names exactly as written — the other sections do:',
      outline.vocabulary.map((v) => `- ${v}`).join('\n'),
    );
  }

  // The briefs, never the HTML. Sending the HTML would blow the context up
  // section by section and reintroduce the size problem the outline exists to
  // solve; the briefs are enough to know what has been covered and what to
  // cross-reference.
  if (done.length) {
    parts.push(
      '',
      'Already written (do not repeat these; you may reference them):',
      done.map((d) => `- ${d.title}: ${d.brief}`).join('\n'),
    );
  }

  const rest = outline.sections
    .slice(index + 1)
    .map((s) => `- ${s.title}: ${s.brief}`)
    .join('\n');
  if (rest) {
    parts.push('', 'Still to come (leave these to them):', rest);
  }

  parts.push('', '--- SOURCE MATERIAL ---', corpus);
  return parts.join('\n');
}

/**
 * Generate one artifact, end to end.
 *
 * The artifact row must already exist — the route creates it so it has an id to
 * attribute spend to and a row to report progress on before any model call
 * happens. This drives it to DONE or throws, and the Inngest wrapper's
 * `onFailure` is what records FAILED.
 */
export async function runArtifact(deps: ArtifactRunDeps): Promise<ArtifactRunResult> {
  const { db, artifactId, modelProvider, onProgress } = deps;
  // Inline unless a durable runner is supplied. Same contract as runEstimate:
  // everything OUTSIDE a step re-executes on replay, so only cheap idempotent
  // work lives there.
  const step: StepRunner = deps.step ?? ((_id, fn) => fn());

  const report = async (p: ArtifactProgress): Promise<void> => {
    await onProgress?.(p);
  };

  const artifact = await db.estimateArtifact.findUniqueOrThrow({
    where: { id: artifactId },
    select: {
      id: true,
      estimateId: true,
      artifactTypeId: true,
      typeVersion: true,
      artifactType: { select: { name: true } },
      estimate: { select: { title: true } },
      // Present when this is a RESUME of a generation that failed part-way.
      outline: true,
    },
  });

  const recorder: UsageRecorder = createUsageRecorder({
    db,
    estimateId: artifact.estimateId,
    artifactId,
  });

  await report({ stage: 'Reading the estimate', pct: 4 });

  // The same preparation the dry run does, so a preview and the real thing are
  // planning from identical input.
  const prep = await prepare(
    db,
    artifact.estimateId,
    artifact.artifactTypeId,
    artifact.typeVersion,
  );
  const corpus = prep.corpus;

  // ── 1. Outline ──────────────────────────────────────────────────────────────
  //
  // A stored outline means this is a RESUME, and reusing it is not an
  // optimisation — it is the thing that makes resuming work at all. Re-planning
  // would produce different section ids, so every section already written and
  // paid for would fail to match and be generated again. Reuse also keeps the
  // document coherent: the sections that survived were written against THIS
  // plan's vocabulary.
  const stored = artifact.outline as ArtifactOutline | null;
  let outline: ArtifactOutline;
  if (stored) {
    await report({ stage: 'Resuming from the existing plan', pct: 12 });
    outline = stored;
  } else {
    await report({ stage: 'Planning the document', pct: 10 });
    outline = await step('artifact-outline', () => planOutline(modelProvider, prep, recorder));
  }

  const ids = uniqueSectionIds(outline.sections.map((s) => s.id));

  // Persisted before any section is written, so the UI can show the plan while
  // the slow part runs, and so a failure halfway is still readable afterwards.
  await db.estimateArtifact.update({
    where: { id: artifactId },
    data: { title: outline.title, outline: outline as unknown as object },
  });

  await report({
    stage: 'Writing sections',
    pct: 15,
    sections: outline.sections.length,
    written: 0,
  });

  // ── 2. One step per section ─────────────────────────────────────────────────
  //
  // Sequential, not parallel, and that is the design rather than a limitation:
  // each call is told what the finished sections cover, which is what lets a
  // later section reference an entity an earlier one introduced. It also keeps
  // one artifact to one Inngest concurrency slot.
  const done: { title: string; brief: string }[] = [];

  for (let i = 0; i < outline.sections.length; i += 1) {
    const planned = outline.sections[i]!;
    const sectionId = ids[i]!;

    await step(`artifact-section-${sectionId}`, async () => {
      // Already written, on a previous attempt at this same artifact. Skip the
      // model call entirely.
      //
      // Inngest's own memoisation only covers steps within ONE run, so without
      // this a resume would pay for every section again — which would make the
      // partial progress the design goes to such lengths to keep completely
      // worthless. This is what turns "2 of 9 were written" into "only 7 left
      // to pay for".
      const already = await db.artifactSection.findUnique({
        where: { artifactId_sectionId: { artifactId, sectionId } },
        select: { id: true },
      });
      if (already) return { sectionId, chars: 0, skipped: true };

      const result = await modelProvider.chat({
        model: prep.modelString,
        messages: [
          { role: 'system', content: `${SECTION_ENVELOPE}\n\n--- THE BRIEF ---\n${prep.promptBody}` },
          {
            role: 'user',
            content: sectionPrompt({
              outline,
              index: i,
              sectionId,
              corpus,
              done,
            }),
          },
        ],
        // Not zero. This is the one genuinely compositional call in the system —
        // laying out a wireframe or an entity diagram is design work, and a
        // deterministic setting here produces stilted, samey documents.
        temperature: 0.4,
        reasoning: ARTIFACT_REASONING,
        timeoutMs: ARTIFACT_TIMEOUT_MS,
      });
      await recorder.record({ kind: 'ARTIFACT', model: result.model, usage: result.usage });

      // The call was billed and produced nothing. Assembling an empty section
      // would put a blank tab into a document somebody is about to send a
      // client, so this fails instead — and names the provider's own reason,
      // because "the model returned nothing" is not actionable and "it stopped
      // on length" is.
      const html = stripFence(result.text);
      if (html.length === 0) {
        const why =
          result.finishReason === 'length'
            ? 'it hit its token limit before writing anything — the model spent the budget thinking. Try a model without extended reasoning, or split this section further.'
            : result.finishReason
              ? `the provider stopped it with finish_reason "${result.finishReason}".`
              : 'the provider returned no content and gave no reason.';
        throw new Error(`Section "${planned.title}" came back empty: ${why}`);
      }

      // Upsert, not create. The step is retried on failure and replayed on
      // resume, and a second create would violate the unique key and fail the
      // whole run over work that actually succeeded.
      await db.artifactSection.upsert({
        where: { artifactId_sectionId: { artifactId, sectionId } },
        create: {
          artifactId,
          sectionId,
          order: i,
          title: planned.title,
          brief: planned.brief,
          html,
        },
        update: { order: i, title: planned.title, brief: planned.brief, html },
      });

      return { sectionId, chars: result.text.length };
    });

    done.push({ title: planned.title, brief: planned.brief });

    await report({
      stage: `Writing sections`,
      // 15 → 90 across the sections, so the bar reflects the part that actually
      // takes the time.
      pct: 15 + Math.round(((i + 1) / outline.sections.length) * 75),
      sections: outline.sections.length,
      written: i + 1,
    });
  }

  // ── 3. Assemble ─────────────────────────────────────────────────────────────
  await report({ stage: 'Assembling the document', pct: 94, sections: outline.sections.length, written: outline.sections.length });

  const content = await step('artifact-assemble', async () => {
    // Re-read rather than accumulating in memory. On an Inngest replay the
    // section steps return memoised values without re-running, so an in-memory
    // array would be empty here — the database is the only place the sections
    // reliably are.
    const rows = await db.artifactSection.findMany({
      where: { artifactId },
      orderBy: { order: 'asc' },
      select: { sectionId: true, title: true, html: true },
    });

    const shellSections: ShellSection[] = rows.map((r) => ({
      sectionId: r.sectionId,
      title: r.title,
      html: r.html,
    }));

    const html = assembleArtifact(
      {
        title: outline.title,
        subtitle: artifact.estimate.title,
        footer: `${artifact.artifactType.name} · generated from the estimate "${artifact.estimate.title}" on ${new Date().toISOString().slice(0, 10)}. Figures are the estimate's own at the time of generation.`,
      },
      shellSections,
    );

    await db.estimateArtifact.update({
      where: { id: artifactId },
      data: {
        content: html,
        status: 'DONE',
        stage: 'Done',
        pct: 100,
        error: null,
        finishedAt: new Date(),
      },
    });

    return html;
  });

  await report({ stage: 'Done', pct: 100, sections: outline.sections.length, written: outline.sections.length });

  return { title: outline.title, sections: outline.sections.length, chars: content.length };
}
