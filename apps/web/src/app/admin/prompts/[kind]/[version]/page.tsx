import { revalidatePath } from 'next/cache';
import { redirect, notFound } from 'next/navigation';
import Link from 'next/link';
import { prisma } from '@repo/db';
import type { AgentKind } from '@repo/db';
import { requireAdmin } from '@/lib/rbac';

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
      <Link href={`/admin/prompts/${kind}`} className="text-sm text-gray-500 hover:underline">
        &larr; Back to {kind}
      </Link>

      <div className="mt-2 flex items-center gap-3">
        <h1 className="text-2xl font-semibold text-gray-900">
          {kind} · v{promptVersion.version}
        </h1>
        {promptVersion.active ? (
          <span
            className="rounded-full bg-green-100 px-2 py-0.5 text-xs font-medium text-green-800"
            data-testid="version-status"
          >
            active
          </span>
        ) : (
          <span
            className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-600"
            data-testid="version-status"
          >
            inactive
          </span>
        )}
      </div>

      <dl className="mt-4 grid max-w-2xl grid-cols-2 gap-x-4 gap-y-2 text-sm">
        <dt className="text-gray-500">Model</dt>
        <dd className="text-gray-900" data-testid="version-model">
          {promptVersion.modelString}
        </dd>
        <dt className="text-gray-500">Created</dt>
        <dd className="text-gray-900">{new Date(promptVersion.createdAt).toLocaleString()}</dd>
        <dt className="text-gray-500">Change reason</dt>
        <dd className="text-gray-900">{promptVersion.changeReason ?? '—'}</dd>
      </dl>

      <div className="mt-6 max-w-2xl">
        <label className="block text-sm font-medium text-gray-700" htmlFor="version-body">
          Prompt body
        </label>
        <textarea
          id="version-body"
          readOnly
          rows={16}
          value={promptVersion.body}
          className="mt-1 w-full rounded-md border border-gray-300 bg-gray-50 px-3 py-2 font-mono text-xs text-gray-800 focus:outline-none"
          data-testid="version-body"
        />
      </div>

      {!promptVersion.active && (
        <form action={activateVersion} className="mt-4">
          <input type="hidden" name="kind" value={kind} />
          <input type="hidden" name="version" value={promptVersion.version} />
          <button
            type="submit"
            className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700"
            data-testid="activate-version"
          >
            Activate this version
          </button>
        </form>
      )}
    </div>
  );
}
