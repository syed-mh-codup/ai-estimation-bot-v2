import Link from 'next/link';
import { prisma } from '@repo/db';

export default async function PresetsAdminPage() {
  const presets = await prisma.preset.findMany({
    include: { versions: { orderBy: { version: 'desc' } } },
    orderBy: { id: 'asc' },
  });

  return (
    <div data-testid="admin-presets">
      <h1 className="text-2xl font-semibold text-gray-900">Presets &amp; Taxonomy</h1>
      <p className="mt-1 text-sm text-gray-500">
        {presets.length} presets. Editing one creates a new active version.
      </p>

      {presets.length === 0 ? (
        <p className="mt-8 text-sm text-gray-500" data-testid="presets-empty">
          No presets seeded. Run <code>db:seed:presets</code>.
        </p>
      ) : (
        <table className="mt-6 w-full border-collapse text-sm" data-testid="presets-table">
          <thead>
            <tr className="border-b border-gray-200 text-left text-gray-500">
              <th className="py-2 font-medium">ID</th>
              <th className="py-2 font-medium">Name</th>
              <th className="py-2 font-medium">Category</th>
              <th className="py-2 font-medium">Req. type</th>
              <th className="py-2 text-right font-medium">BE/FE</th>
              <th className="py-2 text-right font-medium">Active v</th>
            </tr>
          </thead>
          <tbody>
            {presets.map((p) => {
              const active = p.versions.find((v) => v.active) ?? p.versions[0];
              return (
                <tr key={p.id} className="border-b border-gray-100 hover:bg-gray-50">
                  <td className="py-2 font-mono text-xs text-gray-500">{p.id}</td>
                  <td className="py-2">
                    <Link
                      href={`/admin/presets/${p.id}`}
                      className="font-medium text-gray-900 hover:underline"
                      data-testid={`preset-link-${p.id}`}
                    >
                      {active?.name ?? '(no version)'}
                    </Link>
                  </td>
                  <td className="py-2 text-gray-600">{active?.category ?? '—'}</td>
                  <td className="py-2 text-gray-600">{active?.reqType ?? '—'}</td>
                  <td className="py-2 text-right text-gray-600">
                    {active ? `${active.beHours}/${active.feHours}h` : '—'}
                  </td>
                  <td className="py-2 text-right text-gray-500">
                    {active ? `v${active.version}` : '—'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
