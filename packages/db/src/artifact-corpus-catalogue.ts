/**
 * The named slices of an estimate an artifact type can be shown. AEH-239.
 *
 * This is the single source of truth for the corpus vocabulary, and it is
 * CODE, deliberately, while the SELECTION is data. That split is the rule the
 * whole feature runs on:
 *
 *   > anything specific to one artifact is data;
 *   > anything shared by every artifact is code.
 *
 * Adding an artifact type ticks boxes here and touches nothing in this file.
 * Adding a SECTION is a code change, and rightly so — it is a change to what
 * data exists at all, not to artifact support.
 *
 * The prose is not decoration. Every artifact type in this system is
 * hand-authored through the admin UI with no seeded example to copy from, so
 * `blurb` is what an author reads when deciding what their prompt will actually
 * be able to see. A section nobody can describe is a section nobody will tick.
 *
 * Side-effect free: importing this NEVER touches the database. The type editor
 * depends on that, and so does `buildArtifactDossier`.
 */

export type CorpusSectionKey =
  | 'sow'
  | 'requirements'
  | 'cards'
  | 'roles'
  | 'rollup'
  | 'graph'
  | 'hiddenWork'
  | 'scenarios'
  | 'narrative';

export type CorpusSectionProfile = {
  key: CorpusSectionKey;
  /** Human name, for the picker. */
  label: string;
  /** What this section actually contains, in an author's terms. */
  blurb: string;
  /**
   * Roughly how much of the model's context this spends. Authors are choosing
   * what to feed a paid call, and "the whole source document" and "four totals"
   * should not look alike in the picker.
   */
  weight: 'small' | 'medium' | 'large';
  /**
   * True when the section is empty until something else has happened — a run,
   * a derive, a saved scenario. Ticking one of these is legitimate; being
   * surprised by an empty artifact is not.
   */
  conditional: boolean;
};

export const CORPUS_SECTIONS: CorpusSectionProfile[] = [
  {
    key: 'sow',
    label: 'Source document',
    blurb:
      'The SOW in the client’s own words, verbatim and entire. The only section carrying language nobody on the delivery side wrote — reach for it when the artifact has to quote or reflect what was actually asked for.',
    weight: 'large',
    conditional: false,
  },
  {
    key: 'requirements',
    label: 'Requirements',
    blurb:
      'The Librarian’s numbered breakdown of the SOW into discrete requirements, each with its own id. The right handle for anything that needs to reference a specific ask rather than the document as a whole.',
    weight: 'medium',
    conditional: true,
  },
  {
    key: 'cards',
    label: 'Menu cards',
    blurb:
      'Every costed card: title, taxonomy key, category, phase, total taxed hours, and which requirements it was costed against. This is the backbone of most artifacts — it is the scope, itemised.',
    weight: 'medium',
    conditional: true,
  },
  {
    key: 'roles',
    label: 'Role breakdown',
    blurb:
      'Per-card line items split by role — dev, QA, PM, BA — with base and taxed hours. Tick this only when the artifact is about effort distribution; it is several times the size of the cards alone.',
    weight: 'large',
    conditional: true,
  },
  {
    key: 'rollup',
    label: 'Totals',
    blurb:
      'The estimate’s totals: hours by role, by phase, and overall. A handful of numbers, and usually the cheapest way to let an artifact talk about size.',
    weight: 'small',
    conditional: true,
  },
  {
    key: 'graph',
    label: 'Dependency graph',
    blurb:
      'Which cards depend on which, plus the always-included foundation set. Empty until somebody derives it on the scope screen (AEH-235). Essential for anything that sequences work into tranches.',
    weight: 'small',
    conditional: true,
  },
  {
    key: 'hiddenWork',
    label: 'Hidden work',
    blurb:
      'Risks the Detective raised and what was decided about each — costed, covered, dismissed, or still open. The record of what the team spotted that the SOW did not say.',
    weight: 'small',
    conditional: true,
  },
  {
    key: 'scenarios',
    label: 'Saved scope configurations',
    blurb:
      'Scopes already cut from this estimate on the configurator, each a named set of picks. Needed by any artifact that reports on a particular cut rather than the whole estimate.',
    weight: 'small',
    conditional: true,
  },
  {
    key: 'narrative',
    label: 'Narrative & assumptions',
    blurb:
      'The estimate’s written narrative and its stated assumptions. Short, and the only prose the delivery team wrote about its own reasoning.',
    weight: 'small',
    conditional: false,
  },
];

const BY_KEY = new Map(CORPUS_SECTIONS.map((s) => [s.key as string, s]));

export function isCorpusSectionKey(v: string): v is CorpusSectionKey {
  return BY_KEY.has(v);
}

export function corpusSection(key: CorpusSectionKey): CorpusSectionProfile {
  const found = BY_KEY.get(key);
  // Unreachable while the completeness test passes. Throwing beats rendering a
  // blank row in the picker an author is choosing from.
  if (!found) throw new Error(`No corpus section profile for key: ${key}`);
  return found;
}

/**
 * Split stored section keys into the ones this build still knows and the ones
 * it does not.
 *
 * Stored selections are data and this catalogue is code, so the two can drift:
 * a section retired in a later release leaves its key behind on every type that
 * ticked it. That is handled HERE rather than by a database constraint, on
 * purpose — a foreign key would turn retiring a section into a migration that
 * either fails or silently rewrites people's artifact types.
 *
 * Both halves are returned because both are wanted. Generation uses `known`, so
 * a retired section degrades one artifact instead of breaking it; the editor
 * shows `unknown`, so an author can see that a box they once ticked no longer
 * means anything.
 */
export function partitionCorpusSections(keys: readonly string[]): {
  known: CorpusSectionKey[];
  unknown: string[];
} {
  const known: CorpusSectionKey[] = [];
  const unknown: string[] = [];
  // De-duplicated: a repeated key would render the same slice twice into the
  // prompt and be billed for twice.
  for (const key of [...new Set(keys)]) {
    if (isCorpusSectionKey(key)) known.push(key);
    else unknown.push(key);
  }
  return { known, unknown };
}
