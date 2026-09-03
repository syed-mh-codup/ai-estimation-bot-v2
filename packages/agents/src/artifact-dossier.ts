import {
  corpusSection,
  partitionCorpusSections,
  type CorpusSectionKey,
  type PrismaClient,
} from '@repo/db';
import type { Requirement } from '@repo/shared';

/**
 * What an artifact type is allowed to read. AEH-239.
 *
 * ## Why a third corpus builder
 *
 * `buildOracleCorpus` and `buildScopeCorpus` both exist already, and neither
 * fits. Cartographer wrote down why it did not reuse Oracle's, and the same
 * reasons apply here with one more on top:
 *
 * - Oracle's corpus omits `MenuItem.id`, so nothing built on it can produce a
 *   stable handle back to a card. An artifact that references specific scope
 *   needs exactly that.
 * - Oracle's own `@todo` marks it as the seam its retrieval work will change.
 *   Coupling a third consumer to it means that work silently alters what
 *   artifacts see.
 * - Neither is SELECTABLE. That is the new requirement: an artifact type ticks
 *   the sections it wants and pays for nothing else, so the corpus has to be
 *   addressable by name rather than assembled whole. Both of the others are
 *   all-or-nothing by construction.
 *
 * ## One query, then slicing
 *
 * Every section is cut from a single `findUnique`. Fetching per selected
 * section would be N round trips to Neon for data that overlaps heavily —
 * `cards` and `roles` are the same rows at different depths — and the cost of
 * over-fetching once is far below the latency of doing it properly N times.
 *
 * The rendering is text, not JSON. These are prompts: a numbered list costs
 * fewer tokens than the same data as JSON, and models follow prose structure
 * at least as well.
 */

export type ArtifactDossier = {
  estimateId: string;
  title: string;
  status: string;
  /** Rendered text per section, keyed. Only the requested keys are present. */
  sections: Partial<Record<CorpusSectionKey, string>>;
  /** Requested keys that had no data — reported, never silently dropped. */
  empty: CorpusSectionKey[];
  /** Requested keys this build no longer knows. */
  retired: string[];
};

const h = (n: number): string => n.toFixed(1);

/**
 * Assemble the requested slices of one estimate.
 *
 * Returns null when the estimate does not exist. An estimate that exists but
 * has no menu cards is NOT null — a type reading only `sow` is perfectly
 * capable of producing something useful before a run, and refusing here would
 * make that impossible.
 */
export async function buildArtifactDossier(
  db: PrismaClient,
  estimateId: string,
  requested: readonly string[],
): Promise<ArtifactDossier | null> {
  const { known, retired } = (() => {
    const { known, unknown } = partitionCorpusSections(requested);
    return { known, retired: unknown };
  })();

  const want = new Set(known);

  const estimate = await db.estimate.findUnique({
    where: { id: estimateId },
    select: {
      id: true,
      title: true,
      status: true,
      sowText: true,
      narrative: true,
      assumptions: true,
      agentState: true,
      sections: { orderBy: { order: 'asc' }, select: { id: true, title: true } },
      menuItems: {
        where: { injected: false },
        orderBy: { order: 'asc' },
        select: {
          id: true,
          title: true,
          taxonomyKey: true,
          category: true,
          phase: true,
          sectionId: true,
          foundation: true,
          meta: true,
          lineItems: {
            select: { role: true, title: true, baseHours: true, taxedHours: true, notes: true },
          },
        },
      },
      dependencies: {
        select: { dependentId: true, prerequisiteId: true, source: true, note: true },
      },
      hiddenWork: {
        orderBy: { createdAt: 'asc' },
        select: {
          riskFlag: true,
          outcome: true,
          known: true,
          claim: true,
          citation: true,
          dismissReason: true,
        },
      },
      scopeScenarios: {
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          name: true,
          createdAt: true,
          picks: { select: { menuItemId: true } },
        },
      },
    },
  });
  if (!estimate) return null;

  const state = (estimate.agentState ?? {}) as Record<string, unknown>;
  const librarian = state['librarianOutput'] as { requirements?: Requirement[] } | undefined;
  const requirements = librarian?.requirements ?? [];
  const requirementById = new Map(requirements.map((r) => [r.id, r.text]));
  const sectionTitleById = new Map(estimate.sections.map((s) => [s.id, s.title]));
  const cardTitleById = new Map(estimate.menuItems.map((m) => [m.id, m.title]));

  // Cards are numbered once, here, and every section that refers to a card uses
  // the same number. Without that the graph section would talk about cards the
  // cards section numbered differently, and the model would have no way to know
  // they were the same thing.
  const numberOf = new Map(estimate.menuItems.map((m, i) => [m.id, i + 1]));

  const out: Partial<Record<CorpusSectionKey, string>> = {};
  const empty: CorpusSectionKey[] = [];

  const put = (key: CorpusSectionKey, text: string): void => {
    if (text.trim().length === 0) empty.push(key);
    else out[key] = text;
  };

  if (want.has('sow')) put('sow', estimate.sowText.trim());

  if (want.has('requirements')) {
    put(
      'requirements',
      requirements.map((r, i) => `${i + 1}. [${r.id}] ${r.text}`).join('\n'),
    );
  }

  if (want.has('cards')) {
    put(
      'cards',
      estimate.menuItems
        .map((m) => {
          const meta = (m.meta ?? {}) as { requirementIds?: string[] };
          const taxed = m.lineItems.reduce((sum, li) => sum + li.taxedHours, 0);
          const bits = [m.taxonomyKey];
          if (m.category) bits.push(m.category);
          if (m.phase) bits.push(`phase ${m.phase}`);
          if (m.sectionId) {
            const t = sectionTitleById.get(m.sectionId);
            if (t) bits.push(`section "${t}"`);
          }
          if (m.foundation) bits.push('always included');
          bits.push(`${h(taxed)}h`);
          const head = `${numberOf.get(m.id)}. ${m.title} [${bits.join(' · ')}]`;
          const asked = (meta.requirementIds ?? [])
            .map((id) => requirementById.get(id))
            .filter((t): t is string => typeof t === 'string' && t.length > 0);
          return asked.length === 0 ? head : `${head}\n   asked for: ${asked.join(' | ')}`;
        })
        .join('\n'),
    );
  }

  if (want.has('roles')) {
    put(
      'roles',
      estimate.menuItems
        .map((m) => {
          const lines = m.lineItems.map(
            (li) =>
              `   ${li.role}: ${li.title} — ${h(li.baseHours)}h base, ${h(li.taxedHours)}h taxed${
                li.notes ? ` (${li.notes})` : ''
              }`,
          );
          return [`${numberOf.get(m.id)}. ${m.title}`, ...lines].join('\n');
        })
        .join('\n'),
    );
  }

  if (want.has('rollup')) {
    const byRole = new Map<string, number>();
    const byPhase = new Map<string, number>();
    let total = 0;
    for (const m of estimate.menuItems) {
      const cardTotal = m.lineItems.reduce((sum, li) => sum + li.taxedHours, 0);
      total += cardTotal;
      byPhase.set(m.phase ?? 'unphased', (byPhase.get(m.phase ?? 'unphased') ?? 0) + cardTotal);
      for (const li of m.lineItems) {
        byRole.set(li.role, (byRole.get(li.role) ?? 0) + li.taxedHours);
      }
    }
    put(
      'rollup',
      estimate.menuItems.length === 0
        ? ''
        : [
            `Total: ${h(total)}h across ${estimate.menuItems.length} cards.`,
            '',
            'By role:',
            ...[...byRole.entries()].map(([r, v]) => `  ${r}: ${h(v)}h`),
            '',
            'By phase:',
            ...[...byPhase.entries()].map(([p, v]) => `  ${p}: ${h(v)}h`),
          ].join('\n'),
    );
  }

  if (want.has('graph')) {
    const edges = estimate.dependencies.map((d) => {
      const dep = numberOf.get(d.dependentId);
      const pre = numberOf.get(d.prerequisiteId);
      return `  ${dep} (${cardTitleById.get(d.dependentId)}) needs ${pre} (${cardTitleById.get(
        d.prerequisiteId,
      )})${d.note ? ` — ${d.note}` : ''} [${d.source}]`;
    });
    const foundation = estimate.menuItems
      .filter((m) => m.foundation)
      .map((m) => `  ${numberOf.get(m.id)} (${m.title})`);
    put(
      'graph',
      edges.length === 0 && foundation.length === 0
        ? ''
        : [
            edges.length ? `Dependencies:\n${edges.join('\n')}` : 'No dependencies recorded.',
            '',
            foundation.length
              ? `Always included regardless of what is picked:\n${foundation.join('\n')}`
              : 'No cards are marked always-included.',
          ].join('\n'),
    );
  }

  if (want.has('hiddenWork')) {
    put(
      'hiddenWork',
      estimate.hiddenWork
        .map((f) => {
          // `claim` is what the Detective said the work is; `citation` is where
          // in the SOW it came from. Both matter to an artifact that has to
          // explain why something is in scope — the outcome alone is a verdict
          // with no argument behind it.
          const bits = [
            `- ${f.riskFlag} — ${f.outcome}${f.known ? '' : ' (off-list)'}`,
            `  claim: ${f.claim}`,
          ];
          if (f.citation) bits.push(`  from: "${f.citation}"`);
          if (f.dismissReason) bits.push(`  dismissed because: ${f.dismissReason}`);
          return bits.join('\n');
        })
        .join('\n'),
    );
  }

  if (want.has('scenarios')) {
    put(
      'scenarios',
      estimate.scopeScenarios
        .map((s) => {
          const picks = s.picks
            .map((p) => numberOf.get(p.menuItemId))
            .filter((n): n is number => n !== undefined)
            .sort((a, b) => a - b);
          return `- "${s.name}" (${s.id}), saved ${s.createdAt.toISOString().slice(0, 10)}: cards ${
            picks.length ? picks.join(', ') : 'none'
          }`;
        })
        .join('\n'),
    );
  }

  if (want.has('narrative')) {
    const parts: string[] = [];
    if (estimate.narrative.length) parts.push(`Narrative:\n${estimate.narrative.join('\n')}`);
    if (estimate.assumptions.length) {
      parts.push(`Assumptions:\n${estimate.assumptions.map((a) => `- ${a}`).join('\n')}`);
    }
    put('narrative', parts.join('\n\n'));
  }

  return {
    estimateId: estimate.id,
    title: estimate.title,
    status: estimate.status,
    sections: out,
    empty,
    retired,
  };
}

/**
 * Render a dossier as the text a prompt actually receives.
 *
 * Sections are labelled with the same names the admin picker shows, so an
 * author who ticked "Menu cards" can find "Menu cards" in what the model was
 * sent. That correspondence is the only thing making the picker's blurbs
 * trustworthy.
 *
 * Empty sections are stated rather than omitted. A model shown nothing under a
 * heading it was told to expect will invent content to fill it; a model told
 * the estimate has no dependency graph yet can say so.
 */
export function renderArtifactDossier(dossier: ArtifactDossier): string {
  const parts: string[] = [
    `Estimate: ${dossier.title}`,
    `Status: ${dossier.status}`,
    '',
  ];

  for (const [key, text] of Object.entries(dossier.sections)) {
    const profile = corpusSection(key as CorpusSectionKey);
    parts.push(`## ${profile.label}`, '', text, '');
  }

  for (const key of dossier.empty) {
    const profile = corpusSection(key);
    parts.push(
      `## ${profile.label}`,
      '',
      '(This estimate has none yet. Do not invent any — say so if the document needs it.)',
      '',
    );
  }

  return parts.join('\n').trim();
}
