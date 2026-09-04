import { z } from 'zod';

/**
 * The outline step's contract. AEH-239.
 *
 * The outline exists because a ~25k-token document cannot be produced in one
 * model call inside a 300s step ceiling with no Pro headroom behind it.
 * Planning first turns one impossible call into N small ones, each its own
 * durable Inngest step — and it is also what keeps N independently written
 * sections coherent, because the plan fixes the shared vocabulary before any of
 * them are written.
 *
 * Kept in `@repo/shared` beside the Cartographer's schema for the same reason
 * that one is: the agent produces it, the web app renders it while generation
 * is still running, and neither should own the definition.
 */

export const ArtifactOutlineSectionSchema = z.object({
  /**
   * A slug. Becomes the panel id, the tab target, and the anchor other sections
   * link to, so it has to survive being put in an HTML attribute — normalised
   * in code rather than trusted, since a model asked for a slug will eventually
   * return a sentence.
   */
  id: z.string().min(1),
  /** The tab label. Short — it sits in a pill. */
  title: z.string().min(1),
  /**
   * What this section must contain, in enough detail that it can be written
   * without seeing the others. This is the instruction the section call
   * actually receives, so a vague brief here produces a vague section later.
   */
  brief: z.string().min(1),
  /**
   * What this section's deliverable IS, which decides how it gets written.
   * AEH-324.
   *
   * `'diagram'` means the section's value lives in a formal notation — an ERD,
   * a sequence, a state machine, a user flow — so it is written as notation and
   * laid out by the renderer rather than hand-drawn in SVG. `'prose'` is
   * everything else, wireframes and low-fidelity UI included: those have no
   * standard notation and their free-form arrangement is the deliverable.
   *
   * This is a PLANNING field, not a rendering one — a diagram section still
   * returns an HTML fragment, and the renderer finds its diagrams by the block
   * marker inside it. What the mark actually buys is the exemption below: a
   * diagram is not subject to SECTION_WORD_BUDGET and must not be split to fit
   * it, which is what produced seven per-domain ERDs where one system diagram
   * was wanted.
   *
   * Defaulted because most sections are prose and because an outline planned
   * before this field existed must still parse. Read it as `?? 'prose'` all the
   * same: a stored outline is CAST on resume, not re-parsed, so the default
   * never runs on the path that most needs it.
   */
  kind: z.enum(['prose', 'diagram']).default('prose'),
});

export const ArtifactOutlineSchema = z.object({
  /** The document's own title. */
  title: z.string().min(1),
  /**
   * Names, ids and terms every section must use identically — entity names,
   * journey ids, tranche labels.
   *
   * This is the coherence mechanism. Sections are written by separate calls
   * that never see each other's HTML, so without a vocabulary agreed up front,
   * section 5 refers to "the Order record" where section 2 called it
   * "Purchase". Defaulted because a one-section document needs none.
   */
  vocabulary: z.array(z.string()).default([]),
  sections: z.array(ArtifactOutlineSectionSchema).min(1),
});

export type ArtifactOutline = z.infer<typeof ArtifactOutlineSchema>;
// No `ArtifactOutlineSection` alias: nothing needs one yet, and the zero-caller
// gate is right that an exported type with no consumer is just a thing to keep
// in step. `ArtifactOutline['sections'][number]` says it where it is needed.

/** Where generation has got to. Drives the progress line, same shape as a run's. */
export type ArtifactProgress = {
  stage: string;
  pct: number;
  /** Sections planned. Known only after the outline, so absent before it. */
  sections?: number;
  /** Sections written so far — counted, never estimated. */
  written?: number;
};
