import { revalidatePath } from 'next/cache';
import { prisma } from '@repo/db';
import { requireAdmin } from '@/lib/rbac';
import { Card, CardBody, Eyebrow, Heading } from '@/components/ui/card';
import { Pill } from '@/components/ui/pill';
import { Button } from '@/components/ui/button';
import { Input, Textarea, FieldLabel } from '@/components/ui/input';

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

  // Reject invalid input rather than persisting a broken config version.
  if (
    [pm, ba, qa].some((n) => Number.isNaN(n)) ||
    complexityRules === null ||
    infraBaseline === null
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
        changeReason: 'edited via admin',
      },
    }),
  ]);

  revalidatePath('/admin/config');
}

export default async function ConfigAdminPage() {
  const config = await prisma.estimationConfig.findFirst({
    where: { active: true },
    orderBy: { version: 'desc' },
  });

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

        <div className="flex items-center gap-3">
          <Button type="submit" data-testid="save-config">
            Save new version
          </Button>
          <span className="text-[12.5px] text-ink-3">
            This will become <span className="num">v{config.version + 1}</span>.
          </span>
        </div>
      </form>
    </div>
  );
}
