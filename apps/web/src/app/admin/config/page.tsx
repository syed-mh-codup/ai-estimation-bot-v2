import { revalidatePath } from 'next/cache';
import { prisma } from '@repo/db';
import { requireAdmin } from '@/lib/rbac';
import { Card, CardBody, Eyebrow, Heading } from '@/components/ui/card';
import { Pill } from '@/components/ui/pill';
import { Button } from '@/components/ui/button';
import { Input, Textarea, FieldLabel, Select } from '@/components/ui/input';
import type { ChangeMotivation } from '@repo/db';

const MOTIVATIONS: ChangeMotivation[] = [
  'CORRECTION',
  'NEW_PROCESS',
  'POST_DELIVERY_VALIDATION',
  'TECH_ADVANCEMENT',
  'UPSKILL',
  'OTHER',
];

function isMotivation(v: string): v is ChangeMotivation {
  return (MOTIVATIONS as string[]).includes(v);
}

function parseJsonField(value: FormDataEntryValue | null): object | null {
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    return typeof parsed === 'object' && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

async function saveConfig(formData: FormData) {
  'use server';
  await requireAdmin();

  const pm = Number(formData.get('pmCommunicationTaxPct'));
  const ba = Number(formData.get('baCommunicationTaxPct'));
  const qa = Number(formData.get('qaRegressionBufferPct'));
  const hiddenWorkBlocksFinalise = formData.get('hiddenWorkBlocksFinalise') === 'on';
  const complexityRules = parseJsonField(formData.get('complexityRules'));
  const infraBaseline = parseJsonField(formData.get('infraBaseline'));
  const changeReason = (formData.get('changeReason') as string | null)?.trim();
  const motivationRaw = formData.get('changeMotivation');
  const changeMotivation =
    typeof motivationRaw === 'string' && isMotivation(motivationRaw) ? motivationRaw : 'OTHER';

  // Reject invalid input rather than persisting a broken config version.
  if (
    [pm, ba, qa].some((n) => Number.isNaN(n)) ||
    complexityRules === null ||
    infraBaseline === null ||
    !changeReason
  ) {
    return;
  }

  const last = await prisma.estimationConfig.findFirst({
    orderBy: { version: 'desc' },
    select: { version: true },
  });
  const nextVersion = (last?.version ?? 0) + 1;

  // Transaction preserves the single-active invariant: deactivate all, then
  // create the new active version atomically.
  await prisma.$transaction([
    prisma.estimationConfig.updateMany({ where: { active: true }, data: { active: false } }),
    prisma.estimationConfig.create({
      data: {
        version: nextVersion,
        active: true,
        pmCommunicationTaxPct: pm,
        baCommunicationTaxPct: ba,
        qaRegressionBufferPct: qa,
        hiddenWorkBlocksFinalise,
        complexityRules,
        infraBaseline,
        changeReason,
        changeMotivation,
      },
    }),
  ]);

  revalidatePath('/admin/config');
}

export default async function ConfigAdminPage() {
  // Full rows, no `select`. The four versioned models share changeReason /
  // changeMotivation / createdAt, so a narrow projection is indistinguishable
  // between them — for the reader here, and for the field audit that has to
  // decide which model this read belongs to.
  const versions = await prisma.estimationConfig.findMany({
    orderBy: { version: 'desc' },
    take: 20,
  });
  const config = versions.find((v) => v.active) ?? null;

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
      <p className="mt-1 text-[13px] text-ink-3">
        Saving creates a new active version. The previous one is retained, deactivated — nothing
        is overwritten.
      </p>

      <form action={saveConfig} className="mt-5 max-w-2xl space-y-3.5">
        <Card>
          <CardBody>
            <Eyebrow>Role adjustments</Eyebrow>
            <p className="mt-1 text-[12.5px] text-ink-3">
              Applied on top of base hours for each role. DEV hours are never taxed.
            </p>
            <div className="mt-3.5 grid gap-3.5 sm:grid-cols-3">
              <div>
                <FieldLabel htmlFor="pmCommunicationTaxPct">PM comms tax %</FieldLabel>
                <Input
                  id="pmCommunicationTaxPct"
                  name="pmCommunicationTaxPct"
                  type="number"
                  step="0.1"
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
                  defaultValue={config.qaRegressionBufferPct}
                  className="num"
                />
              </div>
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardBody>
            <Eyebrow>Hidden work</Eyebrow>
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
            <Eyebrow>Rules</Eyebrow>
            <p className="mt-1 text-[12.5px] text-ink-3">
              Both fields must be valid JSON objects — a malformed value is rejected and no
              version is written.
            </p>

            <div className="mt-3.5">
              <FieldLabel htmlFor="complexityRules">Complexity rules</FieldLabel>
              <Textarea
                id="complexityRules"
                name="complexityRules"
                rows={5}
                defaultValue={JSON.stringify(config.complexityRules, null, 2)}
                className="num text-xs leading-relaxed"
                spellCheck={false}
              />
            </div>

            <div className="mt-3.5">
              <FieldLabel htmlFor="infraBaseline">Infra baseline</FieldLabel>
              <Textarea
                id="infraBaseline"
                name="infraBaseline"
                rows={4}
                defaultValue={JSON.stringify(config.infraBaseline, null, 2)}
                className="num text-xs leading-relaxed"
                spellCheck={false}
              />
            </div>
          </CardBody>
        </Card>

        <Card>
          <CardBody>
            <Eyebrow>Why</Eyebrow>
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

      <Card className="mt-5 max-w-2xl">
        <CardBody>
          <Eyebrow>History</Eyebrow>
          <ul className="mt-3 divide-y divide-line" data-testid="config-history">
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
        </CardBody>
      </Card>
    </div>
  );
}
