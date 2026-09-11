import { revalidatePath } from 'next/cache';
import Link from 'next/link';
import { prisma } from '@repo/db';
import { requireAdmin } from '@/lib/rbac';
import { Card, CardBody, Eyebrow, Heading } from '@/components/ui/card';
import { CollapsibleSection } from '@/components/ui/collapsible-section';
import { Pill } from '@/components/ui/pill';
import { Button } from '@/components/ui/button';
import { Input, FieldLabel, Select } from '@/components/ui/input';
import { OverheadRows, ThresholdRows } from './RuleRows';
import { MOTIVATIONS, parseConfigForm } from './parse-form';

/**
 * The house settings every estimate is costed against.
 *
 * Grouped by what a setting GOVERNS rather than by what kind of widget edits it.
 * The previous arrangement put the two JSON textareas together under "Rules"
 * because they were both textareas — but a complexity multiplier and a delivery
 * overhead card have nothing to do with each other, while the overhead cards and
 * the role buffers are the same concern seen twice: hours added on top of the
 * work a SOW actually asked for. AEH-348.
 */

async function saveConfig(formData: FormData) {
  'use server';
  await requireAdmin();

  // Reading the form back is its own module, and tested there: the two rule
  // lists arrive as one flat sequence per column and the rows exist only in so
  // far as that function reconstructs them. Getting it wrong does not throw.
  const parsed = parseConfigForm(formData);
  if (!parsed) return;

  const last = await prisma.estimationConfig.findFirst({
    orderBy: { version: 'desc' },
    select: { version: true },
  });
  const nextVersion = (last?.version ?? 0) + 1;

  // Transaction preserves the single-active invariant: deactivate all, then
  // create the new active version atomically. The rule rows are written as part
  // of that create, so a version never exists without the rules it was saved
  // with — an estimate run between the two would otherwise score against a
  // config that had lost its bands.
  await prisma.$transaction([
    prisma.estimationConfig.updateMany({ where: { active: true }, data: { active: false } }),
    prisma.estimationConfig.create({
      data: {
        version: nextVersion,
        active: true,
        pmCommunicationTaxPct: parsed.pmCommunicationTaxPct,
        baCommunicationTaxPct: parsed.baCommunicationTaxPct,
        qaRegressionBufferPct: parsed.qaRegressionBufferPct,
        legacyKeywords: parsed.legacyKeywords,
        legacyScoreBonus: parsed.legacyScoreBonus,
        aiKeywords: parsed.aiKeywords,
        aiScoreBonus: parsed.aiScoreBonus,
        dataVolumeMultiplierNone: parsed.dataVolumeMultiplierNone,
        dataVolumeMultiplierLow: parsed.dataVolumeMultiplierLow,
        dataVolumeMultiplierHigh: parsed.dataVolumeMultiplierHigh,
        hiddenWorkBlocksFinalise: parsed.hiddenWorkBlocksFinalise,
        changeReason: parsed.changeReason,
        changeMotivation: parsed.changeMotivation,
        apiThresholds: { create: parsed.apiThresholds },
        overheadItems: { create: parsed.overheadItems },
      },
    }),
  ]);

  revalidatePath('/admin/config');
}

// ─── Version-to-version diff ─────────────────────────────────────────────────

interface DiffRow {
  field: string;
  from: string;
  to: string;
}

/** "0–1 → 1, 2–3 → 3". Reads each band's own columns, which is also what tells
 *  the field audit these columns have a consumer that is not a form echo. */
function describeBands(bands: { minCount: number; maxCount: number; score: number }[]): string {
  if (bands.length === 0) return 'none';
  return bands.map((band) => `${band.minCount}–${band.maxCount} → ${band.score}`).join(', ');
}

function describeOverhead(
  items: {
    title: string;
    taxonomyKey: string;
    devPct: number | null;
    qaPct: number | null;
    pmPct: number | null;
    baPct: number | null;
  }[],
): string {
  if (items.length === 0) return 'none';
  return items
    .map((item) => {
      const charged = [
        item.devPct === null ? null : `DEV ${item.devPct}%`,
        item.qaPct === null ? null : `QA ${item.qaPct}%`,
        item.pmPct === null ? null : `PM ${item.pmPct}%`,
        item.baPct === null ? null : `BA ${item.baPct}%`,
      ].filter((part): part is string => part !== null);
      return `${item.title} (${item.taxonomyKey}) ${charged.join(' ')}`.trimEnd();
    })
    .join('; ');
}

type ConfigWithRules = {
  pmCommunicationTaxPct: number;
  baCommunicationTaxPct: number;
  qaRegressionBufferPct: number;
  legacyKeywords: string[];
  legacyScoreBonus: number;
  aiKeywords: string[];
  aiScoreBonus: number;
  dataVolumeMultiplierNone: number;
  dataVolumeMultiplierLow: number;
  dataVolumeMultiplierHigh: number;
  hiddenWorkBlocksFinalise: boolean;
  apiThresholds: { minCount: number; maxCount: number; score: number }[];
  overheadItems: {
    title: string;
    taxonomyKey: string;
    devPct: number | null;
    qaPct: number | null;
    pmPct: number | null;
    baPct: number | null;
  }[];
};

/**
 * What moved between the previous version and this one.
 *
 * Written out field by field rather than looped over a list of key names. A
 * loop would be shorter and would read every column through a dynamic index,
 * which is exactly the shape the field audit cannot attribute — and the audit
 * being unable to see a read is how a live column comes to be reported as an
 * orphan. Naming each one costs a line and keeps the column honest.
 */
function buildDiff(current: ConfigWithRules, previous: ConfigWithRules): DiffRow[] {
  const rows: DiffRow[] = [];
  const add = (field: string, from: string, to: string) => {
    if (from !== to) rows.push({ field, from, to });
  };

  add('PM comms tax', `${previous.pmCommunicationTaxPct}%`, `${current.pmCommunicationTaxPct}%`);
  add('BA comms tax', `${previous.baCommunicationTaxPct}%`, `${current.baCommunicationTaxPct}%`);
  add(
    'QA regression buffer',
    `${previous.qaRegressionBufferPct}%`,
    `${current.qaRegressionBufferPct}%`,
  );
  add('Delivery overhead', describeOverhead(previous.overheadItems), describeOverhead(current.overheadItems));
  add('Integration bands', describeBands(previous.apiThresholds), describeBands(current.apiThresholds));
  add('Legacy keywords', previous.legacyKeywords.join(', ') || 'none', current.legacyKeywords.join(', ') || 'none');
  add('Legacy score bonus', `${previous.legacyScoreBonus}×`, `${current.legacyScoreBonus}×`);
  add('AI keywords', previous.aiKeywords.join(', ') || 'none', current.aiKeywords.join(', ') || 'none');
  add('AI score bonus', `${previous.aiScoreBonus}×`, `${current.aiScoreBonus}×`);
  add(
    'Data volume multipliers',
    `none ${previous.dataVolumeMultiplierNone}× · low ${previous.dataVolumeMultiplierLow}× · high ${previous.dataVolumeMultiplierHigh}×`,
    `none ${current.dataVolumeMultiplierNone}× · low ${current.dataVolumeMultiplierLow}× · high ${current.dataVolumeMultiplierHigh}×`,
  );
  add(
    'Hidden work gate',
    previous.hiddenWorkBlocksFinalise ? 'blocks finalising' : 'warns only',
    current.hiddenWorkBlocksFinalise ? 'blocks finalising' : 'warns only',
  );

  return rows;
}

// ─── Screen ──────────────────────────────────────────────────────────────────

const withRules = {
  apiThresholds: { orderBy: { position: 'asc' } },
  overheadItems: { orderBy: { position: 'asc' } },
} as const;

export default async function ConfigAdminPage() {
  await requireAdmin();

  const [config, versions, overheadKeyOptions] = await Promise.all([
    prisma.estimationConfig.findFirst({
      where: { active: true },
      orderBy: { version: 'desc' },
      include: withRules,
    }),
    // Full rows, no `select`. The four versioned models share changeReason /
    // changeMotivation / createdAt, so a narrow projection is indistinguishable
    // between them — for the reader here, and for the field audit that has to
    // decide which model this read belongs to.
    prisma.estimationConfig.findMany({
      orderBy: { version: 'desc' },
      take: 20,
    }),
    // Suggestions for an overhead card's taxonomy key. Non-classifiable nodes
    // are exactly the `process.*` branch — the keys that exist to be filed
    // against rather than asked for — which is what an overhead card is. The
    // field takes a key that is not on this list, so a new one needs no trip
    // through the taxonomy admin first.
    prisma.taxonomyNode.findMany({
      where: { status: 'ACTIVE', classifiable: false },
      select: { key: true },
      orderBy: { key: 'asc' },
    }),
  ]);

  if (!config) {
    return (
      <div data-testid="admin-config">
        <Heading level={1} className="text-[28px]">
          Estimation config
        </Heading>
        <div className="mt-5 rounded-[10px] border border-dashed border-line bg-surface px-6 py-10 text-center">
          <div className="font-serif text-[20px] text-ink">No active configuration</div>
          <p className="mx-auto mt-1.5 max-w-[420px] text-[13px] leading-relaxed text-ink-3">
            The estimation engine needs a config version before it can tax or buffer any hours.
            Seed one with <span className="num text-ink-2">pnpm db:seed</span>, then reload this
            page to edit it.
          </p>
        </div>
      </div>
    );
  }

  const previous = await prisma.estimationConfig.findFirst({
    where: { version: { lt: config.version } },
    orderBy: { version: 'desc' },
    include: withRules,
  });
  const diff = previous ? buildDiff(config, previous) : [];

  return (
    <div data-testid="admin-config">
      <div className="flex flex-wrap items-center gap-3">
        <Heading level={1} className="text-[28px]">
          Estimation config
        </Heading>
        <Pill tone="green" dot={false} data-testid="config-version">
          <span className="num">v{config.version}</span>
        </Pill>
      </div>
      <p className="mt-1 max-w-2xl text-[13px] text-ink-3">
        Saving creates a new active version. The previous one is retained, deactivated — nothing
        is overwritten.
      </p>

      <form action={saveConfig} className="mt-5 max-w-2xl space-y-3.5">
        <Card>
          <CardBody>
            <Eyebrow>Hours added on top</Eyebrow>
            <p className="mt-1 text-[12.5px] text-ink-3">
              Everything charged beyond the work a SOW asked for. DEV carries no communication
              tax: the complexity multiplier is already applied to it, and a buffer on top would
              charge for the same uncertainty twice.
            </p>
            <p className="mt-1.5 text-[12px] text-ink-4">
              These three are the <span className="text-ink-3">house defaults</span>. An estimate
              can set its own for any role, and every estimate stores its taxed hours per line
              item against the version it was costed under — so changing a percentage here never
              moves an estimate that already exists. It applies from the next run onwards.
            </p>

            <div className="mt-3.5 grid gap-3.5 sm:grid-cols-3">
              <div>
                <FieldLabel htmlFor="pmCommunicationTaxPct">PM comms tax %</FieldLabel>
                <Input
                  id="pmCommunicationTaxPct"
                  name="pmCommunicationTaxPct"
                  type="number"
                  step="0.1"
                  required
                  defaultValue={config.pmCommunicationTaxPct}
                  className="num"
                />
              </div>
              <div>
                <FieldLabel htmlFor="baCommunicationTaxPct">BA comms tax %</FieldLabel>
                <Input
                  id="baCommunicationTaxPct"
                  name="baCommunicationTaxPct"
                  type="number"
                  step="0.1"
                  required
                  defaultValue={config.baCommunicationTaxPct}
                  className="num"
                />
              </div>
              <div>
                <FieldLabel htmlFor="qaRegressionBufferPct">QA regression buffer %</FieldLabel>
                <Input
                  id="qaRegressionBufferPct"
                  name="qaRegressionBufferPct"
                  type="number"
                  step="0.1"
                  required
                  defaultValue={config.qaRegressionBufferPct}
                  className="num"
                />
              </div>
            </div>

            <div className="mt-4 border-t border-line-soft pt-3.5">
              <FieldLabel>Delivery overhead</FieldLabel>
              <p className="mb-2.5 text-[12px] text-ink-3">
                Work every project carries that no SOW names. Each becomes a card on the estimate
                an estimator can see and argue with, priced as a percentage of that role&apos;s
                taxed hours — 24h of ceremony is 6% of a nine-month build and 120% of a two-week
                one. A blank percentage charges that role nothing.
              </p>
              <OverheadRows
                taxonomyKeys={overheadKeyOptions.map((node) => node.key)}
                initial={config.overheadItems.map((item) => ({
                  title: item.title,
                  taxonomyKey: item.taxonomyKey,
                  devPct: item.devPct,
                  qaPct: item.qaPct,
                  pmPct: item.pmPct,
                  baPct: item.baPct,
                }))}
              />
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardBody>
            <Eyebrow>How hard the work is judged</Eyebrow>
            <p className="mt-1 text-[12.5px] text-ink-3">
              Turns what the Librarian and Detective found into a complexity score, which
              multiplies DEV hours. Scored at run time, so a change here affects future estimates
              and never rewrites one that exists.
            </p>

            <div className="mt-3.5">
              <FieldLabel>Integration bands</FieldLabel>
              <p className="mb-2.5 text-[12px] text-ink-3">
                How many integrations a SOW wants, and the base score that earns. Read top to
                bottom: the first band containing the count wins, so the order is the rule.
              </p>
              <ThresholdRows
                initial={config.apiThresholds.map((band) => ({
                  minCount: band.minCount,
                  maxCount: band.maxCount,
                  score: band.score,
                }))}
              />
            </div>

            <div className="mt-4 grid gap-3.5 border-t border-line-soft pt-3.5 sm:grid-cols-[1fr_auto]">
              <div>
                <FieldLabel htmlFor="legacyKeywords">Legacy keywords</FieldLabel>
                <Input
                  id="legacyKeywords"
                  name="legacyKeywords"
                  defaultValue={config.legacyKeywords.join(', ')}
                  placeholder="legacy, mainframe, cobol"
                />
                <p className="mt-1 text-[11.5px] text-ink-4">Comma separated.</p>
              </div>
              <div>
                <FieldLabel htmlFor="legacyScoreBonus">Score ×</FieldLabel>
                <Input
                  id="legacyScoreBonus"
                  name="legacyScoreBonus"
                  type="number"
                  step="0.1"
                  min="0"
                  required
                  defaultValue={config.legacyScoreBonus}
                  className="num w-24"
                />
              </div>
            </div>

            <div className="mt-3.5 grid gap-3.5 sm:grid-cols-[1fr_auto]">
              <div>
                <FieldLabel htmlFor="aiKeywords">AI keywords</FieldLabel>
                <Input
                  id="aiKeywords"
                  name="aiKeywords"
                  defaultValue={config.aiKeywords.join(', ')}
                  placeholder="machine learning, llm, nlp"
                />
                <p className="mt-1 text-[11.5px] text-ink-4">Comma separated.</p>
              </div>
              <div>
                <FieldLabel htmlFor="aiScoreBonus">Score ×</FieldLabel>
                <Input
                  id="aiScoreBonus"
                  name="aiScoreBonus"
                  type="number"
                  step="0.1"
                  min="0"
                  required
                  defaultValue={config.aiScoreBonus}
                  className="num w-24"
                />
              </div>
            </div>

            <div className="mt-4 border-t border-line-soft pt-3.5">
              <FieldLabel>Data volume multipliers</FieldLabel>
              <p className="mb-2.5 text-[12px] text-ink-3">
                Applied to the score once the Librarian has judged how much data a requirement
                moves.
              </p>
              <div className="grid gap-3.5 sm:grid-cols-3">
                <div>
                  <FieldLabel htmlFor="dataVolumeMultiplierNone" className="text-ink-3">
                    None
                  </FieldLabel>
                  <Input
                    id="dataVolumeMultiplierNone"
                    name="dataVolumeMultiplierNone"
                    type="number"
                    step="0.1"
                    min="0"
                    required
                    defaultValue={config.dataVolumeMultiplierNone}
                    className="num"
                  />
                </div>
                <div>
                  <FieldLabel htmlFor="dataVolumeMultiplierLow" className="text-ink-3">
                    Low
                  </FieldLabel>
                  <Input
                    id="dataVolumeMultiplierLow"
                    name="dataVolumeMultiplierLow"
                    type="number"
                    step="0.1"
                    min="0"
                    required
                    defaultValue={config.dataVolumeMultiplierLow}
                    className="num"
                  />
                </div>
                <div>
                  <FieldLabel htmlFor="dataVolumeMultiplierHigh" className="text-ink-3">
                    High
                  </FieldLabel>
                  <Input
                    id="dataVolumeMultiplierHigh"
                    name="dataVolumeMultiplierHigh"
                    type="number"
                    step="0.1"
                    min="0"
                    required
                    defaultValue={config.dataVolumeMultiplierHigh}
                    className="num"
                  />
                </div>
              </div>
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardBody>
            <Eyebrow>What blocks sending</Eyebrow>
            <p className="mt-1 text-[12.5px] text-ink-3">
              Risks the Detective raised that nobody costed. Known ones are costed
              automatically; anything it invented a name for is raised for a person to decide.
            </p>
            <label className="mt-3.5 flex items-start gap-2.5">
              <input
                type="checkbox"
                name="hiddenWorkBlocksFinalise"
                defaultChecked={config.hiddenWorkBlocksFinalise}
                className="mt-0.5"
                data-testid="hidden-work-blocks-finalise"
              />
              <span className="text-[13px] text-ink-2">
                Block finalising until every flagged risk is resolved
                <span className="block text-[12px] text-ink-3">
                  Off, an estimate can be finalised with risks still open and the count is
                  shown alongside the button. On, each one has to be costed, marked covered,
                  or dismissed with a reason first.
                </span>
              </span>
            </label>
          </CardBody>
        </Card>

        <Card>
          <CardBody>
            <Eyebrow>Why this change</Eyebrow>
            <p className="mt-1 text-[12.5px] text-ink-3">
              Every version is kept, so the question a reader has months later is not what
              changed — the diff says that — but why anyone changed it.
            </p>
            <div className="mt-3.5 grid gap-3.5 sm:grid-cols-[1fr_auto]">
              <div>
                <FieldLabel htmlFor="changeReason">Change reason</FieldLabel>
                <Input
                  id="changeReason"
                  name="changeReason"
                  required
                  placeholder="QA buffer was under-calling regression on integration-heavy work"
                  data-testid="config-change-reason"
                />
              </div>
              <div>
                <FieldLabel htmlFor="changeMotivation">Motivation</FieldLabel>
                <Select id="changeMotivation" name="changeMotivation" defaultValue="CORRECTION">
                  {MOTIVATIONS.map((m) => (
                    <option key={m} value={m}>
                      {m.toLowerCase().replace(/_/g, ' ')}
                    </option>
                  ))}
                </Select>
              </div>
            </div>
          </CardBody>
        </Card>

        <div className="flex items-center gap-3">
          <Button type="submit" data-testid="save-config">
            Save new version
          </Button>
          <span className="text-[12.5px] text-ink-3">
            This will become <span className="num">v{config.version + 1}</span>.
          </span>
        </div>
      </form>

      {diff.length > 0 && (
        <section className="mt-8 max-w-2xl">
          <Eyebrow>
            Changes vs v<span className="num">{previous!.version}</span>
          </Eyebrow>
          <Card className="mt-2 overflow-hidden">
            <ul className="divide-y divide-line-soft" data-testid="config-diff">
              {diff.map((row) => (
                <li key={row.field} className="px-4 py-2.5">
                  <div className="text-[11.5px] text-ink-3">{row.field}</div>
                  <div className="mt-1 flex flex-col gap-1 overflow-x-auto">
                    <div className="flex min-w-0 items-start gap-2 rounded border border-brick-line bg-brick-tint px-2 py-1">
                      <span className="num shrink-0 text-[12px] font-bold text-brick">−</span>
                      <span className="text-[12.5px] break-words text-ink-2">{row.from}</span>
                    </div>
                    <div className="flex min-w-0 items-start gap-2 rounded border border-green-line bg-green-tint px-2 py-1">
                      <span className="num shrink-0 text-[12px] font-bold text-green">+</span>
                      <span className="text-[12.5px] break-words text-ink">{row.to}</span>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </Card>
        </section>
      )}

      {/* Collapsed by default, and that is the point of the section rather than
          an afterthought: the audit trail is worth keeping and worth reading,
          but an admin arriving to change a buffer should meet the settings, not
          twenty rows of what the settings used to be. */}
      <CollapsibleSection
        title="Version history"
        defaultOpen={false}
        storageKey="admin-config-history"
        className="mt-5 max-w-2xl"
        meta={`last ${versions.length}`}
        data-testid="config-history-section"
      >
        <ul className="divide-y divide-line" data-testid="config-history">
          {versions.map((v) => (
            <li key={v.version} className="py-3">
              <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                <span className="num text-[13px] font-semibold text-ink">v{v.version}</span>
                {v.active && (
                  <Pill tone="green" dot={false}>
                    active
                  </Pill>
                )}
                <span className="text-[12px] text-ink-4">
                  {v.createdAt.toISOString().slice(0, 10)}
                </span>
                <span className="rounded border border-line bg-surface px-1 text-[9.5px] font-bold tracking-[0.07em] text-ink-3 uppercase">
                  {v.changeMotivation.toLowerCase().replace(/_/g, ' ')}
                </span>
              </div>
              {v.changeReason && (
                <p className="mt-1 text-[12.5px] text-ink-2">{v.changeReason}</p>
              )}
              <p className="num mt-0.5 text-[12px] text-ink-3">
                PM {v.pmCommunicationTaxPct}% · BA {v.baCommunicationTaxPct}% · QA{' '}
                {v.qaRegressionBufferPct}%
              </p>
            </li>
          ))}
        </ul>
        <p className="mt-3 border-t border-line-soft pt-3 text-[12px] text-ink-3">
          Config is one of four versioned things.{' '}
          <Link href="/admin/changelog" className="text-green hover:underline">
            The changelog
          </Link>{' '}
          puts these edits next to prompt, taxonomy and preset changes, which is where to look
          when the question is &ldquo;what did we change last Tuesday&rdquo; rather than
          &ldquo;how did this setting get here&rdquo;.
        </p>
      </CollapsibleSection>
    </div>
  );
}
