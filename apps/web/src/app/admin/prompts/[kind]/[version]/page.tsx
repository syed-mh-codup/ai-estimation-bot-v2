import { revalidatePath } from 'next/cache';
import { redirect, notFound } from 'next/navigation';
import Link from 'next/link';
import { prisma } from '@repo/db';
import type { AgentKind } from '@repo/db';
import { requireAdmin } from '@/lib/rbac';
import { Button } from '@/components/ui/button';
import { Card, CardBody, Heading } from '@/components/ui/card';
import { Pill } from '@/components/ui/pill';
import { Textarea, FieldLabel } from '@/components/ui/input';

const AGENT_KINDS: AgentKind[] = [
  'SUPERVISOR',
  'LIBRARIAN',
  'DETECTIVE',
  'ARCHIVIST',
  'SPECIALIST_DEV',
  'SPECIALIST_QA',
  'SPECIALIST_PM',
  'SPECIALIST_BA',
  'ARCHITECT',
];

function isAgentKind(v: string): v is AgentKind {
  return (AGENT_KINDS as string[]).includes(v);
}

async function activateVersion(formData: FormData) {
  'use server';
  await requireAdmin();

  const kindRaw = formData.get('kind');
  const versionRaw = formData.get('version');
  if (typeof kindRaw !== 'string' || !isAgentKind(kindRaw) || typeof versionRaw !== 'string') return;
  const kind = kindRaw;
  const version = Number(versionRaw);
  if (!Number.isInteger(version)) return;

  // Transaction preserves the single-active invariant per agent kind — same
  // pattern as savePrompt, but flips active on an EXISTING version instead
  // of creating a new one.
  await prisma.$transaction([
    prisma.promptVersion.updateMany({ where: { kind, active: true }, data: { active: false } }),
    prisma.promptVersion.update({
      where: { kind_version: { kind, version } },
      data: { active: true },
    }),
  ]);

  revalidatePath(`/admin/prompts/${kind}`);
  revalidatePath(`/admin/prompts/${kind}/${version}`);
  revalidatePath('/admin/prompts');
  redirect(`/admin/prompts/${kind}`);
}

export default async function PromptVersionDetailPage({
  params,
}: {
  params: Promise<{ kind: string; version: string }>;
}) {
  const { kind: kindRaw, version: versionRaw } = await params;
  if (!isAgentKind(kindRaw)) {
    notFound();
  }
  const kind = kindRaw;
  const version = Number(versionRaw);
  if (!Number.isInteger(version)) {
    notFound();
  }

  const promptVersion = await prisma.promptVersion.findUnique({
    where: { kind_version: { kind, version } },
  });
  if (!promptVersion) {
    notFound();
  }

  return (
    <div data-testid="admin-prompt-version-detail">
      <Link
        href={`/admin/prompts/${kind}`}
        className="text-[12.5px] text-ink-3 hover:text-ink hover:underline"
      >
        ← {kind}
      </Link>

      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
        <Heading level={1} className="min-w-0 break-words">
          {kind} <span className="num text-ink-3">v{promptVersion.version}</span>
        </Heading>
        {promptVersion.active ? (
          <Pill tone="green" data-testid="version-status">
            active
          </Pill>
        ) : (
          <Pill tone="neutral" dot={false} data-testid="version-status">
            inactive
          </Pill>
        )}
      </div>
      <p className="mt-1.5 text-[13px] text-ink-3">
        {promptVersion.active
          ? 'This is the version the crew runs today.'
          : 'A superseded version, kept for the record. Activate it to put it back in service.'}
      </p>

      <div className="mt-5 max-w-3xl">
        <Card>
          <CardBody className="p-4 sm:p-5">
            <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-[auto_minmax(0,1fr)]">
              <dt className="eyebrow self-center">Model</dt>
              <dd className="num text-[12.5px] break-all text-ink" data-testid="version-model">
                {promptVersion.modelString}
              </dd>
              <dt className="eyebrow self-center">Created</dt>
              <dd className="num text-[12.5px] text-ink">
                {new Date(promptVersion.createdAt).toLocaleString()}
              </dd>
              <dt className="eyebrow self-center">Change reason</dt>
              <dd className="text-[13px] text-ink">{promptVersion.changeReason ?? '—'}</dd>
            </dl>
          </CardBody>
        </Card>

        <div className="mt-5">
          <FieldLabel htmlFor="version-body" className="eyebrow mb-2">
            Prompt body
          </FieldLabel>
          <Textarea
            id="version-body"
            readOnly
            rows={20}
            value={promptVersion.body}
            className="bg-surface-2 font-mono text-[12.5px] leading-relaxed text-ink-2"
            data-testid="version-body"
          />
        </div>

        {!promptVersion.active && (
          <form action={activateVersion} className="mt-4">
            <input type="hidden" name="kind" value={kind} />
            <input type="hidden" name="version" value={promptVersion.version} />
            <Button type="submit" data-testid="activate-version">
              Activate this version
            </Button>
          </form>
        )}
      </div>
    </div>
  );
}
