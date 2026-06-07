import { revalidatePath } from 'next/cache';
import Link from 'next/link';
import { notFound } from 'next/navigation';
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

async function savePrompt(formData: FormData) {
  'use server';
  await requireAdmin();

  const kindRaw = formData.get('kind');
  const body = (formData.get('body') as string | null)?.trim();
  const modelString = (formData.get('modelString') as string | null)?.trim();
  if (typeof kindRaw !== 'string' || !isAgentKind(kindRaw) || !body || !modelString) return;
  const kind = kindRaw;

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
        changeReason: 'edited via admin',
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
      <Link href="/admin/prompts" className="text-sm text-gray-500 hover:underline">
        &larr; Back to prompts
      </Link>

      <div className="mt-2 flex items-center gap-3">
        <h1 className="text-2xl font-semibold text-gray-900">{kind}</h1>
        <span
          className="rounded-full bg-indigo-100 px-2 py-0.5 text-xs font-medium text-indigo-800"
          data-testid="prompt-active-version"
        >
          v{active.version}
        </span>
      </div>
      <p className="mt-1 text-sm text-gray-500">
        Saving creates a new active version; older versions are kept in the history below.
      </p>

      <form action={savePrompt} className="mt-6 max-w-2xl space-y-4">
        <input type="hidden" name="kind" value={kind} />
        <div>
          <label htmlFor="modelString" className="block text-sm font-medium text-gray-700">
            Model
          </label>
          <input
            id="modelString"
            name="modelString"
            defaultValue={active.modelString}
            className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-gray-500 focus:outline-none"
          />
        </div>
        <div>
          <label htmlFor="body" className="block text-sm font-medium text-gray-700">
            Prompt body
          </label>
          <textarea
            id="body"
            name="body"
            rows={10}
            defaultValue={active.body}
            className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 font-mono text-xs focus:border-gray-500 focus:outline-none"
          />
        </div>
        <button
          type="submit"
          className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700"
          data-testid="save-prompt"
        >
          Save new version
        </button>
      </form>

      <section className="mt-8">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500">
          Version history
        </h2>
        <table className="mt-2 w-full border-collapse text-sm" data-testid="prompt-history">
          <thead>
            <tr className="border-b border-gray-200 text-left text-gray-500">
              <th className="py-2 font-medium">Version</th>
              <th className="py-2 font-medium">Model</th>
              <th className="py-2 font-medium">Status</th>
              <th className="py-2 font-medium">Created</th>
            </tr>
          </thead>
          <tbody>
            {versions.map((v) => (
              <tr
                key={v.id}
                className="border-b border-gray-100"
                data-testid={`prompt-version-${v.version}`}
              >
                <td className="py-3 text-gray-900">v{v.version}</td>
                <td className="py-3 text-gray-600">{v.modelString}</td>
                <td className="py-3">
                  {v.active ? (
                    <span className="text-green-700">active</span>
                  ) : (
                    <span className="text-gray-400">inactive</span>
                  )}
                </td>
                <td className="py-3 text-gray-500">
                  {new Date(v.createdAt).toLocaleDateString()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
