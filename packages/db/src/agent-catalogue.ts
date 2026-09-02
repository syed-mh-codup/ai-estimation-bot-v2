/**
 * What every agent is, what it does, and which system it belongs to.
 *
 * This is the single source of truth for the `AgentKind` set. Before it existed
 * the list was hardcoded in four places — the Prisma enum, `seed-prompts.ts`,
 * and two `/admin/prompts` pages — and adding an agent meant finding all four.
 * Everything except the Prisma enum now derives from here.
 *
 * The prose is not decoration. `/admin/prompts` lets an admin rewrite the system
 * prompt of any agent, and until this existed the screen named them and nothing
 * more: no statement of what an agent reads, what it produces, where it sits in
 * the run, or whether editing it changes anything at all. Three lengths are
 * carried deliberately — `blurb` for a table row, `summary` for an expanded row,
 * `detail` for the agent's own page.
 *
 * Side-effect free: importing this NEVER touches the database. `seed-prompts.ts`
 * depends on that and so does the e2e global-setup.
 */
import type { AgentKind } from './generated/client/index.js';

/**
 * Which system an agent belongs to. This is the distinction the screen exists to
 * make: an admin editing a prompt should know whether they are changing what
 * every future estimate is worth, or what one person's next question gets back.
 */
export type AgentTrack =
  /** Loaded on every estimate run. Editing changes what the next run produces. */
  | 'RUN_CREW'
  /** Answers on demand, never part of a run. Editing changes the next answer. */
  | 'SUPPLEMENTAL'
  /** Authored spec whose prompt no code path loads. Editing changes nothing. */
  | 'REFERENCE';

export type AgentProfile = {
  kind: AgentKind;
  /** Human name, as distinct from the enum value. */
  label: string;
  track: AgentTrack;
  /**
   * Position within its track, for display order. For `RUN_CREW` this is the
   * pipeline order; agents sharing a number run in parallel.
   */
  order: number;
  /** One line, for a table row. */
  blurb: string;
  /** Two or three sentences, for an expanded row. */
  summary: string;
  /** The full account, for the agent's own page. */
  detail: string;
  /** What it reads. Short noun phrases. */
  consumes: string[];
  /** What it produces. Short noun phrases. */
  produces: string[];
};

export const TRACK_META: Record<AgentTrack, { label: string; description: string }> = {
  RUN_CREW: {
    label: 'Estimation crew',
    description:
      'The council that runs on every estimate, in this order. Editing one of these prompts changes what the next run produces.',
  },
  SUPPLEMENTAL: {
    label: 'Supplemental',
    description:
      'Answers questions on demand and is never part of a run. Editing changes the next answer given, not any estimate.',
  },
  REFERENCE: {
    label: 'Reference only',
    description:
      'An authored specification that no code path loads at runtime. Editing it is recorded and versioned, but it will not change a run.',
  },
};

export const AGENT_CATALOGUE: AgentProfile[] = [
  {
    kind: 'LIBRARIAN',
    label: 'Librarian',
    track: 'RUN_CREW',
    order: 1,
    blurb: 'Turns the source document into a numbered list of discrete requirements.',
    summary:
      'Reads the entire statement of work and decomposes it into discrete, buildable requirements, mapping each to the best-fitting taxonomy key. Every requirement carries the passage it came from, so the rest of the run can trace a number back to a sentence in the document.',
    detail:
      'The first agent in the run, and the one everything downstream depends on. It receives the whole statement of work with no truncation, plus the active taxonomy, and returns a list of discrete requirements. Each is mapped to a taxonomy key or explicitly to none, and each carries a sourceRef naming the passage it came from, any ambiguities found in it, and whether those ambiguities are severe enough that the Detective must investigate before the work can be estimated. Requirement identifiers are assigned by code rather than by the model, so re-running the same document produces the same identifiers.',
    consumes: ['Statement of work', 'Active taxonomy'],
    produces: ['Requirements', 'Taxonomy mapping', 'Ambiguities'],
  },
  {
    kind: 'DETECTIVE',
    label: 'Detective',
    track: 'RUN_CREW',
    order: 2,
    blurb: 'Investigates the risky and unknown parts, and argues each risk in writing.',
    summary:
      'Takes the requirements and looks for what will go wrong: external integrations, rate limits, missing endpoints, legacy systems, migrations. Each finding is a written claim with a citation and one or more risk flags, which the Specialists then either cost or leave for a human.',
    detail:
      'Runs in parallel with the Archivist. It examines each requirement for external platforms, technical constraints and unknowns, and emits findings rather than hours — it never estimates effort. A finding carries the claim in the Detective’s own words, a citation, the requirement it was raised against, and its risk flags. Those flags are the mechanism behind hidden work: any flag no Specialist claims to have costed becomes a finding row a human must resolve before the estimate can be finalised. It also raises open questions, which are surfaced during the run but not persisted.',
    consumes: ['Requirements'],
    produces: ['Risk findings', 'Risk flags', 'Open questions'],
  },
  {
    kind: 'ARCHIVIST',
    label: 'Archivist',
    track: 'RUN_CREW',
    order: 2,
    blurb: 'Finds the closest work the company has already estimated before.',
    summary:
      'Embeds each requirement and runs a vector similarity search over the historical preset library, returning the nearest matches with their hours. This is what anchors an estimate to what the work actually took last time, rather than to a guess.',
    detail:
      'Runs in parallel with the Detective. Each requirement is embedded and matched against the preset library by vector similarity, returning the closest presets with their scores and their recorded hours. The match also declares coverage: whether the historical library fully covers this requirement, partly covers it, or does not cover it at all, which is a signal the gate checks look at. The search itself needs no model call; the prompt is used only when reranking matches. If no embedding provider is configured the stage is skipped and the run proceeds without anchors.',
    consumes: ['Requirements', 'Preset library'],
    produces: ['Preset matches', 'Anchor hours', 'Coverage'],
  },
  {
    kind: 'SPECIALIST_DEV',
    label: 'Specialist — Development',
    track: 'RUN_CREW',
    order: 3,
    blurb: 'Estimates engineering effort, broken into units of four hours or less.',
    summary:
      'Estimates development effort for one requirement at a time, anchored on the historical match and adjusted for complexity and the Detective’s risk flags. Output is decomposed into line items of at most four hours each, not one lump number.',
    detail:
      'One of four independent role estimators, each producing its own line items for the same requirement. Development anchors on the matched preset, adjusts for the complexity score and any risk flags raised against the requirement, and applies AI-assist compression. The four-hour rule applies: scope is broken into atomic units of at most four hours, and a unit over the cap is flagged by the gate checks. Each line item also declares which side of the stack it touches, which is what lets a finalised estimate be written back onto a preset accurately. Crucially, the Specialist declares which risk flags its hours genuinely cover — a flag it does not claim is not lost, it is raised for a human to cost or dismiss deliberately.',
    consumes: ['Requirement', 'Preset match', 'Complexity score', 'Risk flags'],
    produces: ['Line items', 'Rationale', 'Claimed risk flags'],
  },
  {
    kind: 'SPECIALIST_QA',
    label: 'Specialist — QA',
    track: 'RUN_CREW',
    order: 3,
    blurb: 'Estimates test design and execution effort against development scope.',
    summary:
      'Derives testing effort from the development scope and the risk attached to a requirement. It estimates direct test work only — the regression and bug buffer is a percentage applied later by the taxation engine, not something QA estimates twice.',
    detail:
      'One of four independent role estimators. QA sizes test design and execution relative to the development scope for the same requirement, weighted by complexity and by any risk flags raised against it. It deliberately estimates direct testing only: the regression and bug buffer is applied afterwards as a configured percentage, so including it here would double-count. The same four-hour decomposition and risk-flag claiming rules apply as for Development. The gate checks flag a run where the QA total falls outside a sane proportion of the Development total.',
    consumes: ['Requirement', 'Development scope', 'Complexity score', 'Risk flags'],
    produces: ['Line items', 'Rationale', 'Claimed risk flags'],
  },
  {
    kind: 'SPECIALIST_PM',
    label: 'Specialist — Project Management',
    track: 'RUN_CREW',
    order: 3,
    blurb: 'Estimates coordination and planning effort per requirement.',
    summary:
      'Sizes the project management effort a requirement carries. As with QA, the communication tax is a configured percentage applied later, so this estimates the direct coordination work only.',
    detail:
      'One of four independent role estimators. Project Management sizes planning and coordination effort for a single requirement. The communication tax is applied afterwards by the taxation engine as a configured percentage, so this figure covers direct coordination work only. The four-hour decomposition and risk-flag claiming rules apply. The gate checks flag a run where the PM total falls outside a sane proportion of the other three roles combined.',
    consumes: ['Requirement', 'Complexity score', 'Risk flags'],
    produces: ['Line items', 'Rationale', 'Claimed risk flags'],
  },
  {
    kind: 'SPECIALIST_BA',
    label: 'Specialist — Business Analysis',
    track: 'RUN_CREW',
    order: 3,
    blurb: 'Estimates requirements analysis and acceptance-criteria effort.',
    summary:
      'Sizes the analysis work a requirement carries: clarifying it, specifying it, and writing acceptance criteria. Ambiguities the Librarian flagged are the main driver here.',
    detail:
      'One of four independent role estimators. Business Analysis sizes requirements work: clarification, specification and acceptance criteria. Requirements the Librarian marked ambiguous, and those the Detective flagged as blocking estimation, are the main driver of effort here. The communication tax is applied later as a configured percentage. The four-hour decomposition and risk-flag claiming rules apply, and the gate checks flag a run where the BA total is disproportionate to Development.',
    consumes: ['Requirement', 'Ambiguities', 'Complexity score'],
    produces: ['Line items', 'Rationale', 'Claimed risk flags'],
  },
  {
    kind: 'ARCHITECT',
    label: 'Architect',
    track: 'RUN_CREW',
    order: 4,
    blurb: 'Assembles the menu card and writes the narrative and assumptions.',
    summary:
      'Takes every Specialist’s output and assembles it into the menu card the estimator actually sees: items grouped and titled, with a one-sentence approach narrative and a deduplicated assumption set. It never alters the hours it was given.',
    detail:
      'The last model in the run. It synthesises the four Specialist councils’ outputs into a coherent menu card, preserving dependency links between items, and writes the execution narrative and the deduplicated assumption set that appear on the estimate screen. It does not alter Specialist hours — its job is arrangement and explanation, not estimation. It also emits consistency flags for anything that does not reconcile, which are folded into the run’s gate warnings. Everything after this point is deterministic: taxation, process overhead, the hidden-work audit and the gate checks are all code, not prompts.',
    consumes: ['Specialist line items', 'Requirements', 'Risk findings'],
    produces: ['Menu card', 'Narrative', 'Assumptions', 'Consistency flags'],
  },
  {
    kind: 'ORACLE',
    label: 'Oracle',
    track: 'SUPPLEMENTAL',
    order: 1,
    blurb: 'Answers questions about one estimate, quoting its source material.',
    summary:
      'A chat surface on the estimate screen. It reads that estimate’s source material and everything derived from it, and answers by quoting the document verbatim and then explaining. It writes nothing, and when the documents do not answer a question it says so rather than guessing.',
    detail:
      'Oracle is a comprehension aid, not an estimation tool. It reads one estimate’s whole corpus — the source material, the requirements with their source references, the menu card and its hours, the narrative and assumptions, the complexity breakdown, and every risk the Detective raised along with what was decided about it — and answers questions about them. It has no write path: it cannot change a card, an assumption or a number, and when an estimator tells it something the documents do not say it recommends recording that as an assumption rather than storing it anywhere. Its answers quote verbatim and then explain, and every quote is checked mechanically against the corpus, so a fabricated quote is caught without a human reading it. When the corpus does not cover a question it names precisely what is missing and stops. That refusal behaviour is the hard part of this prompt: it is the thing to tune, and the reason this prompt is editable here rather than shipped in code.',
    consumes: ['Source material', 'Requirements', 'Menu card', 'Risk findings'],
    produces: ['Grounded answers', 'Verbatim citations'],
  },
  {
    kind: 'CARTOGRAPHER',
    label: 'Cartographer',
    track: 'SUPPLEMENTAL',
    order: 2,
    blurb: 'Works out which parts of one estimate depend on which.',
    summary:
      'Reads an estimate\u2019s menu card and decides, for each card, what has to exist before it can be delivered \u2014 plus which cards are foundation work that nothing runs without. That graph is what lets the scope configurator cascade: turn a module on and its prerequisites come with it, turn one off and the work that cannot exist without it goes too.',
    detail:
      'Runs on demand against one estimate, never as part of a run, because it uses a heavy model and most estimates are never configured. It reads the menu card \u2014 every card with its taxonomy key, phase, hours and the requirements behind it \u2014 and returns directed edges between cards plus a foundation set, each edge carrying one sentence saying why. Dependencies are a property of the project being built, so it works them out for THIS estimate rather than looking them up: the preset library records what past work needed, but every project is different and one project\u2019s ordering is not evidence about another\u2019s. Its output is validated before it is stored \u2014 an edge naming a card that does not exist is dropped, a self-edge is dropped, and an edge that would close a dependency loop is refused, because a cycle means there is no order the work can be done in. What survives is a graph a human can then correct by hand; nothing here is treated as the last word.',
    consumes: ['Menu card', 'Requirements'],
    produces: ['Card dependencies', 'Foundation set'],
  },
  {
    kind: 'SUPERVISOR',
    label: 'Supervisor',
    track: 'REFERENCE',
    order: 1,
    blurb: 'The written specification for the run’s quality gates. Not loaded at runtime.',
    summary:
      'Describes the invariants each stage of a run must satisfy before the next begins. The checks themselves are implemented deterministically in code, and this prompt is never loaded — editing it is versioned and recorded, but it will not change a run.',
    detail:
      'The Supervisor is a specification rather than a running agent. The invariants it describes — every requirement covered or explicitly not covered, every requirement carrying development effort, no line item over the four-hour cap, role totals in sane proportion, every line item under exactly one card — are implemented as a deterministic function that runs after the Architect and records its findings as gate warnings on the estimate. That function is code, not a prompt, and no code path loads this prompt body. It is kept here because it is the authored statement of what the gates are for, and because the code that implements them cites it. Be aware that nothing currently detects the two drifting apart, and that the gates warn rather than block. Reviewing and resolving that is tracked separately as AEH-283.',
    consumes: ['Every stage output'],
    produces: ['Gate warnings'],
  },
];

/** Every agent kind, in catalogue order. The list the enum used to duplicate. */
export const AGENT_KINDS: AgentKind[] = AGENT_CATALOGUE.map((a) => a.kind);

export function isAgentKind(value: string): value is AgentKind {
  return (AGENT_KINDS as string[]).includes(value);
}

export function agentProfile(kind: AgentKind): AgentProfile {
  const found = AGENT_CATALOGUE.find((a) => a.kind === kind);
  // Unreachable while the completeness test passes; throwing beats returning a
  // placeholder that would render as a real description of a real agent.
  if (!found) throw new Error(`No catalogue entry for agent kind: ${kind}`);
  return found;
}

/** The catalogue grouped by track, in track order, each group in `order` order. */
export function agentsByTrack(): { track: AgentTrack; agents: AgentProfile[] }[] {
  const tracks: AgentTrack[] = ['RUN_CREW', 'SUPPLEMENTAL', 'REFERENCE'];
  return tracks.map((track) => ({
    track,
    agents: AGENT_CATALOGUE.filter((a) => a.track === track).sort((x, y) => x.order - y.order),
  }));
}
