import { type PrismaClient } from '@repo/db';
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
 * scales by content with no special cases: an ERD is a one-section outline and
 * three steps; a wireframe pack is nine sections and eleven.
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
 * and vagueness spends it. ~1200 words of HTML is roughly 4-6k tokens, which
 * streams comfortably inside one 300s step with room for a slow model — and it
 * is the figure that makes the model SPLIT a large subject into several
 * sections rather than trying to fit it into one and timing out.
 */
const SECTION_WORD_BUDGET = 1200;

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
  This is a hard production constraint, not a style preference: an oversized
  section fails to generate at all.
- "vocabulary" is how the document stays coherent. Put every proper noun the
  sections must agree on in it — entity names, journey ids, tranche labels. If
  two sections would otherwise name the same thing differently, that name
  belongs here.
- Prefer 3-9 sections. One section is correct for a genuinely small document.
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

Write the section, in full, to the brief. Do not summarise and do not leave
placeholders for a human to fill in.
`.trim();

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
    },
  });

  const version = await db.artifactTypeVersion.findUniqueOrThrow({
    where: {
      artifactTypeId_version: {
        artifactTypeId: artifact.artifactTypeId,
        version: artifact.typeVersion,
      },
    },
    select: { promptBody: true, modelString: true, corpusSections: true },
  });

  const recorder: UsageRecorder = createUsageRecorder({
    db,
    estimateId: artifact.estimateId,
    artifactId,
  });

  await report({ stage: 'Reading the estimate', pct: 4 });

  const dossier = await buildArtifactDossier(
    db,
    artifact.estimateId,
    version.corpusSections,
  );
  if (!dossier) throw new Error('That estimate no longer exists.');
  if (Object.keys(dossier.sections).length === 0) {
    // Every requested section came back empty. Generating anyway would spend
    // real money to produce a document about nothing, and the model would fill
    // the gap by inventing scope — the exact failure the empty-SOW guard in
    // runEstimate exists to prevent.
    throw new Error(
      'Nothing to work from: every section this artifact reads is empty on this estimate. Run it first, or tick different sections on the artifact type.',
    );
  }
  const corpus = renderArtifactDossier(dossier);

  // ── 1. Outline ──────────────────────────────────────────────────────────────
  await report({ stage: 'Planning the document', pct: 10 });
  const outline: ArtifactOutline = await step('artifact-outline', () =>
    chatJSON(
      modelProvider,
      {
        model: version.modelString,
        messages: [
          { role: 'system', content: `${OUTLINE_ENVELOPE}\n\n--- THE BRIEF ---\n${version.promptBody}` },
          { role: 'user', content: corpus },
        ],
        // Zero, like every other structured agent here: the same estimate
        // should plan the same document twice.
        temperature: 0,
      },
      ArtifactOutlineSchema,
      'ARTIFACT_OUTLINE',
      { kind: 'ARTIFACT', recorder },
    ),
  );

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
      const result = await modelProvider.chat({
        model: version.modelString,
        messages: [
          { role: 'system', content: `${SECTION_ENVELOPE}\n\n--- THE BRIEF ---\n${version.promptBody}` },
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
      });
      await recorder.record({ kind: 'ARTIFACT', model: result.model, usage: result.usage });

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
          html: stripFence(result.text),
        },
        update: { order: i, title: planned.title, brief: planned.brief, html: stripFence(result.text) },
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
