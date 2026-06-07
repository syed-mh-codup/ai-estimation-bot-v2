import Link from 'next/link';
import { prisma } from '@repo/db';

export default async function PromptsAdminPage() {
  const prompts = await prisma.prompt.findMany({
    include: { versions: { orderBy: { version: 'desc' } } },
    orderBy: { kind: 'asc' },
  });

  return (
    <div data-testid="admin-prompts">
      <h1 className="text-2xl font-semibold text-gray-900">Prompts</h1>
      <p className="mt-1 text-sm text-gray-500">
        One prompt per agent. Editing creates a new active version.
      </p>

      {prompts.length === 0 ? (
        <p className="mt-8 text-sm text-gray-500" data-testid="prompts-empty">
          No prompts seeded yet.
        </p>
      ) : (
        <table className="mt-6 w-full border-collapse text-sm" data-testid="prompts-table">
          <thead>
            <tr className="border-b border-gray-200 text-left text-gray-500">
              <th className="py-2 font-medium">Agent</th>
              <th className="py-2 font-medium">Active version</th>
              <th className="py-2 font-medium">Model</th>
              <th className="py-2 font-medium">Versions</th>
            </tr>
          </thead>
          <tbody>
            {prompts.map((p) => {
              const active = p.versions.find((v) => v.active);
              return (
                <tr key={p.kind} className="border-b border-gray-100 hover:bg-gray-50">
                  <td className="py-3">
                    <Link
                      href={`/admin/prompts/${p.kind}`}
                      className="font-medium text-gray-900 hover:underline"
                      data-testid={`prompt-link-${p.kind}`}
                    >
                      {p.kind}
                    </Link>
                  </td>
                  <td className="py-3 text-gray-600">{active ? `v${active.version}` : '—'}</td>
                  <td className="py-3 text-gray-600">{active?.modelString ?? '—'}</td>
                  <td className="py-3 text-gray-500">{p.versions.length}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
