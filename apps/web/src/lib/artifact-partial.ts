import { assembleArtifact, type ShellSection } from '@repo/agents';

/**
 * Assemble the sections of a document that has not finished. AEH-326.
 *
 * ## Why this can exist at all
 *
 * `assembleArtifact` is a pure function of a list of sections — it writes the
 * shell, the tabs and the panels from whatever it is handed. The final assemble
 * step in `runArtifact` is not doing anything a partial set cannot; it just
 * happens to be called at the point where the list is complete. Handing it the
 * rows written so far produces a valid document with working tabs, which is the
 * whole of this feature.
 *
 * ## Why it lives here rather than in the route
 *
 * The judgement in it — that an empty set is nothing rather than an empty
 * document, and what the footer of a half-written document should say — is
 * worth a test, and an API route is the one place in this app nothing is unit
 * tested. The route stays a query and a call.
 */

export type PartialSectionRow = {
  sectionId: string;
  title: string;
  html: string;
};

export type PartialArtifact = {
  /** The assembled document, or null when no section has landed yet. */
  html: string | null;
  /** Sections actually written. Counted from the rows, never estimated. */
  written: number;
  /** Sections the outline planned. 0 before planning has finished. */
  planned: number;
};

/**
 * Build the readable-so-far document, or say there is nothing to read.
 *
 * Null rather than an empty shell for zero rows: a masthead with no tabs and no
 * body is a worse answer than "nothing yet", because it reads as a document
 * that came out blank rather than one that has not started.
 */
export function assemblePartialArtifact(input: {
  /** The artifact's own title — the user's, not the model's. */
  title: string;
  /** The estimate this was generated from; becomes the subtitle. */
  estimateTitle: string;
  /** The artifact type's display name, for the footer. */
  typeName: string;
  /** How many sections the outline planned, if it has run yet. */
  planned: number;
  rows: readonly PartialSectionRow[];
}): PartialArtifact {
  const { title, estimateTitle, typeName, planned, rows } = input;
  const written = rows.length;

  if (written === 0) return { html: null, written: 0, planned };

  const sections: ShellSection[] = rows.map((r) => ({
    sectionId: r.sectionId,
    title: r.title,
    html: r.html,
  }));

  // The footer is the one part of the document that travels with it, so it is
  // where being partial has to be stated. The page around the iframe says so as
  // well, but a screenshot leaves the page behind and keeps the footer.
  const of = planned > 0 ? ` of ${planned}` : '';
  // Pluralise on the number the noun actually follows, which is the planned
  // total whenever there is one: "1 of 9 section written" is not English.
  const noun = (planned > 0 ? planned : written) === 1 ? 'section' : 'sections';
  const html = assembleArtifact(
    {
      title,
      subtitle: estimateTitle,
      footer: `DRAFT — ${written}${of} ${noun} written so far. ${typeName}, still generating from the estimate "${estimateTitle}". This is not the finished document and its figures are not final.`,
    },
    sections,
  );

  return { html, written, planned };
}
