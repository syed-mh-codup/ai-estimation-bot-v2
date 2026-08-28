import { revalidatePath } from 'next/cache';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { isAgentKind, prisma } from '@repo/db';
import type { ChangeMotivation } from '@repo/db';
import { requireAdmin } from '@/lib/rbac';
import { Button } from '@/components/ui/button';
import { Card, CardBody, Eyebrow, Heading } from '@/components/ui/card';
import { Pill } from '@/components/ui/pill';
import { Input, Textarea, FieldLabel, Select } from '@/components/ui/input';

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


async function savePrompt(formData: FormData) {
  'use server';
  const admin = await requireAdmin();

  const kindRaw = formData.get('kind');
  const body = (formData.get('body') as string | null)?.trim();
  const modelString = (formData.get('modelString') as string | null)?.trim();
  const changeReason = (formData.get('changeReason') as string | null)?.trim();
  const motivationRaw = formData.get('changeMotivation');
  const changeMotivation =
    typeof motivationRaw === 'string' && isMotivation(motivationRaw) ? motivationRaw : 'OTHER';
  if (typeof kindRaw !== 'string' || !isAgentKind(kindRaw) || !body || !modelString || !changeReason) {
    return;
  }
  const kind = kindRaw;

  // A prompt edit changes what every estimate is worth. Whoever made it should
  // be on the record — the detail page has an Author row and nothing was ever
  // filling it.
  const author = await prisma.user.findUnique({
    where: { id: admin.id },
    select: { email: true },
  });

  const last = await prisma.promptVersion.findFirst({
    where: { kind },
    orderBy: { version: 'desc' },
    select: { version: true },
  });
  const nextVersion = (last?.version ?? 0) + 1;

  // Transaction preserves the single-active invariant per agent kind.
  await prisma.$transaction([
    prisma.promptVersion.updateMany({ where: { kind, active: true }, data: { active: false } }),
    prisma.promptVersion.create({
      data: {
        kind,
        version: nextVersion,
        body,
        modelString,
        active: true,
        changeReason,
        changeMotivation,
        createdBy: author?.email ?? null,
      },
    }),
  ]);

  revalidatePath(`/admin/prompts/${kind}`);
  revalidatePath('/admin/prompts');
}

export default async function PromptEditorPage({
  params,
}: {
  params: Promise<{ kind: string }>;
}) {
  const { kind } = await params;
  if (!isAgentKind(kind)) {
    notFound();
  }

  const versions = await prisma.promptVersion.findMany({
    where: { kind },
    orderBy: { version: 'desc' },
  });
  const active = versions.find((v) => v.active);
  if (!active) {
    notFound();
  }

  return (
    <div data-testid="admin-prompt-editor">
      <Link
        href="/admin/prompts"
        className="text-[12.5px] text-ink-3 hover:text-ink hover:underline"
      >
        ← Prompts
      </Link>

      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
        <Heading level={1} className="min-w-0 break-words">
          {kind}
        </Heading>
        <div className="flex items-center gap-2">
          <Pill tone="green" dot={false} data-testid="prompt-active-version" className="num">
            v{active.version}
          </Pill>
          <span className="eyebrow">active version</span>
        </div>
      </div>
      <p className="mt-1.5 text-[13px] text-ink-3">
        Saving creates a new active version; v<span className="num">{active.version}</span> is kept in
        the history below and can be reactivated from its detail page.
      </p>

      <form action={savePrompt} className="mt-5 max-w-3xl">
        <input type="hidden" name="kind" value={kind} />

        <Card>
          <CardBody className="space-y-4 p-4 sm:p-5">
            <div className="max-w-md">
              <FieldLabel htmlFor="modelString">Model</FieldLabel>
              <Input
                id="modelString"
                name="modelString"
                defaultValue={active.modelString}
                className="num text-[12.5px]"
              />
            </div>

            <div>
              <FieldLabel htmlFor="body">Prompt body</FieldLabel>
              <Textarea
                id="body"
                name="body"
                rows={18}
                defaultValue={active.body}
                className="font-mono text-[12.5px] leading-relaxed"
              />
            </div>
          </CardBody>
        </Card>

        <Card className="mt-3.5">
          <CardBody>
            <Eyebrow>Why</Eyebrow>
            <p className="mt-1 text-[12.5px] text-ink-3">
              A prompt edit changes what every estimate is worth. The body diff shows what moved;
              this is the only place the reason survives.
            </p>
            <div className="mt-3.5 grid gap-3.5 sm:grid-cols-[1fr_auto]">
              <div>
                <FieldLabel htmlFor="changeReason">Change reason</FieldLabel>
                <Input
                  id="changeReason"
                  name="changeReason"
                  required
                  placeholder="Tightened the decomposition rule — cards were coming back over 4h"
                  data-testid="prompt-change-reason"
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

        <div className="mt-4">
          <Button type="submit" data-testid="save-prompt">
            Save new version
          </Button>
        </div>
      </form>

      <section className="mt-8">
        <Eyebrow>Version history</Eyebrow>
        <Card className="mt-2 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[13px]" data-testid="prompt-history">
              <thead>
                <tr className="border-b border-line bg-surface-2 text-left">
                  <th className="eyebrow px-4 py-2.5 font-bold">Version</th>
                  <th className="eyebrow px-4 py-2.5 font-bold">Model</th>
                  <th className="eyebrow px-4 py-2.5 font-bold">Status</th>
                  <th className="eyebrow px-4 py-2.5 font-bold">Created</th>
                </tr>
              </thead>
              <tbody>
                {versions.map((v) => (
                  <tr
                    key={v.id}
                    className="border-b border-line-soft last:border-0 hover:bg-surface-2"
                    data-testid={`prompt-version-${v.version}`}
                  >
                    <td className="num px-4 py-3 whitespace-nowrap">
                      <Link
                        href={`/admin/prompts/${kind}/${v.version}`}
                        className="font-semibold text-ink hover:text-green hover:underline"
                        data-testid={`prompt-version-link-${v.version}`}
                      >
                        v{v.version}
                      </Link>
                    </td>
                    <td className="num px-4 py-3 text-[12px] text-ink-2">{v.modelString}</td>
                    <td className="px-4 py-3">
                      {v.active ? (
                        <Pill tone="green">active</Pill>
                      ) : (
                        <Pill tone="neutral" dot={false}>
                          inactive
                        </Pill>
                      )}
                    </td>
                    <td className="num px-4 py-3 whitespace-nowrap text-ink-3">
                      {new Date(v.createdAt).toLocaleDateString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </section>
    </div>
  );
}
