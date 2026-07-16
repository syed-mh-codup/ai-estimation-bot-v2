import Link from 'next/link';
import { prisma } from '@repo/db';
import { Card, Heading } from '@/components/ui/card';
import { Pill } from '@/components/ui/pill';

export default async function PresetsAdminPage() {
  const presets = await prisma.preset.findMany({
    include: { versions: { orderBy: { version: 'desc' } } },
    orderBy: { id: 'asc' },
  });

  return (
    <div data-testid="admin-presets">
      <Heading level={1}>Presets &amp; taxonomy</Heading>
      <p className="mt-1.5 text-[13px] text-ink-3">
        <span className="num text-ink-2">{presets.length}</span> reusable costed blocks. Editing one
        creates a new active version — the old one stays in its history.
      </p>

      {presets.length === 0 ? (
        <div
          className="mt-6 rounded-[10px] border border-dashed border-line bg-surface px-6 py-10 text-center"
          data-testid="presets-empty"
        >
          <div className="font-serif text-[20px] text-ink">No presets yet</div>
          <p className="mx-auto mt-1.5 max-w-[420px] text-[13px] leading-relaxed text-ink-3">
            The taxonomy is seeded from the repo. Run{' '}
            <code className="num rounded border border-line-soft bg-surface-2 px-1.5 py-0.5 text-[12px] text-ink-2">
              db:seed:presets
            </code>{' '}
            to load the catalogue, then reload this page.
          </p>
        </div>
      ) : (
        <Card className="mt-5 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[13px]" data-testid="presets-table">
              <thead>
                <tr className="border-b border-line bg-surface-2 text-left">
                  <th className="eyebrow px-4 py-2.5 font-bold">ID</th>
                  <th className="eyebrow px-4 py-2.5 font-bold">Name</th>
                  <th className="eyebrow px-4 py-2.5 font-bold">Category</th>
                  <th className="eyebrow px-4 py-2.5 font-bold">Req. type</th>
                  <th className="eyebrow px-4 py-2.5 text-right font-bold">BE/FE</th>
                  <th className="eyebrow px-4 py-2.5 text-right font-bold">Active</th>
                </tr>
              </thead>
              <tbody>
                {presets.map((p) => {
                  const active = p.versions.find((v) => v.active) ?? p.versions[0];
                  return (
                    <tr
                      key={p.id}
                      className="border-b border-line-soft last:border-0 hover:bg-surface-2"
                    >
                      <td className="num px-4 py-2.5 text-[12px] whitespace-nowrap text-ink-3">
                        {p.id}
                      </td>
                      <td className="px-4 py-2.5">
                        <Link
                          href={`/admin/presets/${p.id}`}
                          className="font-semibold text-ink hover:text-green hover:underline"
                          data-testid={`preset-link-${p.id}`}
                        >
                          {active?.name ?? '(no version)'}
                        </Link>
                      </td>
                      <td className="px-4 py-2.5 text-ink-2">{active?.category ?? '—'}</td>
                      <td className="px-4 py-2.5 text-ink-2">{active?.reqType ?? '—'}</td>
                      <td className="num px-4 py-2.5 text-right whitespace-nowrap text-ink-2">
                        {active ? `${active.beHours}/${active.feHours}h` : '—'}
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        {active ? (
                          <Pill tone="green" dot={false} className="num">
                            v{active.version}
                          </Pill>
                        ) : (
                          <span className="text-ink-4">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
