import Link from 'next/link';
import { prisma } from '@repo/db';
import { Card, Heading } from '@/components/ui/card';
import { Pill } from '@/components/ui/pill';

export default async function PromptsAdminPage() {
  const prompts = await prisma.prompt.findMany({
    include: { versions: { orderBy: { version: 'desc' } } },
    orderBy: { kind: 'asc' },
  });

  return (
    <div data-testid="admin-prompts">
      <Heading level={1}>Prompts</Heading>
      <p className="mt-1.5 text-[13px] text-ink-3">
        One system prompt per agent in the crew. Editing one creates a new active version — the crew
        picks it up on the next run.
      </p>

      {prompts.length === 0 ? (
        <div
          className="mt-6 rounded-[10px] border border-dashed border-line bg-surface px-6 py-10 text-center"
          data-testid="prompts-empty"
        >
          <div className="font-serif text-[20px] text-ink">No prompts yet</div>
          <p className="mx-auto mt-1.5 max-w-[420px] text-[13px] leading-relaxed text-ink-3">
            The crew&apos;s prompts are seeded from the repo. Seed the database, then reload this
            page to edit them.
          </p>
        </div>
      ) : (
        <Card className="mt-5 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[13px]" data-testid="prompts-table">
              <thead>
                <tr className="border-b border-line bg-surface-2 text-left">
                  <th className="eyebrow px-4 py-2.5 font-bold">Agent</th>
                  <th className="eyebrow px-4 py-2.5 font-bold">Active version</th>
                  <th className="eyebrow px-4 py-2.5 font-bold">Model</th>
                  <th className="eyebrow px-4 py-2.5 text-right font-bold">Versions</th>
                </tr>
              </thead>
              <tbody>
                {prompts.map((p) => {
                  const active = p.versions.find((v) => v.active);
                  return (
                    <tr
                      key={p.kind}
                      className="border-b border-line-soft last:border-0 hover:bg-surface-2"
                    >
                      <td className="px-4 py-3">
                        <Link
                          href={`/admin/prompts/${p.kind}`}
                          className="font-semibold text-ink hover:text-green hover:underline"
                          data-testid={`prompt-link-${p.kind}`}
                        >
                          {p.kind}
                        </Link>
                      </td>
                      <td className="px-4 py-3">
                        {active ? (
                          <Pill tone="green" dot={false} className="num">
                            v{active.version}
                          </Pill>
                        ) : (
                          <Pill tone="bronze">none active</Pill>
                        )}
                      </td>
                      <td className="num px-4 py-3 text-[12px] text-ink-2">
                        {active?.modelString ?? '—'}
                      </td>
                      <td className="num px-4 py-3 text-right text-ink-3">{p.versions.length}</td>
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
