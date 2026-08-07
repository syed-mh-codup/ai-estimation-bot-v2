import Link from 'next/link';
import { prisma } from '@repo/db';
import { Button } from '@/components/ui/button';
import { Card, Heading } from '@/components/ui/card';
import { Pill } from '@/components/ui/pill';

export default async function PresetsAdminPage() {
  const rows = await prisma.preset.findMany({
    include: { versions: { orderBy: { version: 'desc' } } },
  });

  // Sorted here, not in SQL: codes are free-flowing so a lexical sort puts P100
  // before P46. Compare the numeric part instead; codeless rows sort last.
  const codeNumber = (code: string | null): number =>
    code ? Number(code.replace(/\D/g, '')) || Number.MAX_SAFE_INTEGER : Number.MAX_SAFE_INTEGER;
  const presets = [...rows].sort((a, b) => codeNumber(a.code) - codeNumber(b.code));

  return (
    <div data-testid="admin-presets">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <Heading level={1}>Presets &amp; taxonomy</Heading>
          <p className="mt-1.5 text-[13px] text-ink-3">
            <span className="num text-ink-2">{presets.length}</span> reusable costed blocks. Editing
            one creates a new active version — the old one stays in its history.
          </p>
        </div>
        <Button asChild size="lg">
          <Link href="/admin/presets/new" data-testid="new-preset">
            New preset
          </Link>
        </Button>
      </div>

      {presets.length === 0 ? (
        <div
          className="mt-6 rounded-[10px] border border-dashed border-line bg-surface px-6 py-10 text-center"
          data-testid="presets-empty"
        >
          <div className="font-serif text-[20px] text-ink">No presets yet</div>
          <p className="mx-auto mt-1.5 max-w-[440px] text-[13px] leading-relaxed text-ink-3">
            Add one by hand, or load the catalogue from the repo with{' '}
            <code className="num rounded border border-line-soft bg-surface-2 px-1.5 py-0.5 text-[12px] text-ink-2">
              db:seed:presets
            </code>
            .
          </p>
          <Button asChild className="mt-5">
            <Link href="/admin/presets/new">Create the first preset</Link>
          </Button>
        </div>
      ) : (
        <Card className="mt-5 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[13px]" data-testid="presets-table">
              <thead>
                <tr className="border-b border-line bg-surface-2 text-left">
                  <th className="eyebrow px-4 py-2.5 font-bold">Code</th>
                  <th className="eyebrow px-4 py-2.5 font-bold">Name</th>
                  <th className="eyebrow px-4 py-2.5 font-bold">Category</th>
                  <th className="eyebrow px-4 py-2.5 font-bold">Req. type</th>
                  <th className="eyebrow px-4 py-2.5 text-right font-bold">Dev</th>
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
                        {p.code ?? '—'}
                        {p.origin !== 'SEEDED' && (
                          <span className="ml-1.5 text-[10px] tracking-[0.04em] text-ink-4 uppercase">
                            {p.origin === 'FINALISED' ? 'delivered' : 'manual'}
                          </span>
                        )}
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
                        {active ? `${active.devHours}h` : '—'}
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
