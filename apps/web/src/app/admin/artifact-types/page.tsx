import Link from 'next/link';
import { prisma, corpusSection, partitionCorpusSections } from '@repo/db';
import { Button } from '@/components/ui/button';
import { Card, CardBody, Eyebrow, Heading } from '@/components/ui/card';
import { Pill } from '@/components/ui/pill';

/**
 * The artifact types an estimate can produce documents from. AEH-239.
 *
 * The screen exists because the list is DATA. `/admin/prompts` can be a fixed
 * table of ten agents driven by a code catalogue, because adding an agent is a
 * migration; adding an artifact type is an INSERT, which is the entire point of
 * the ticket. So this page has something that one does not: a create button.
 *
 * Nothing is seeded, ever. Every type in this system was written by hand
 * through this screen, which is why the empty state below is a real piece of
 * the product rather than a placeholder.
 */
export default async function ArtifactTypesAdminPage() {
  const types = await prisma.artifactType.findMany({
    orderBy: [{ order: 'asc' }, { createdAt: 'asc' }],
    include: {
      versions: { orderBy: { version: 'desc' } },
      // Never `content` — an assembled artifact runs to ~100KB and this is a
      // list page. The count is the only thing wanted here.
      _count: { select: { artifacts: true } },
    },
  });

  return (
    <div data-testid="admin-artifact-types">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Heading level={1}>Artifacts</Heading>
          <p className="mt-1.5 max-w-[720px] text-[13px] text-ink-3">
            A kind of supporting document an estimate can produce — an entity model, a set of user
            journeys, a wireframe pack. Each one is a brief and a choice of what the model gets to
            see. Adding one takes no deploy and no code change.
          </p>
        </div>
        <Button asChild size="lg">
          <Link href="/admin/artifact-types/new" data-testid="new-artifact-type">
            New artifact type
          </Link>
        </Button>
      </div>

      {types.length === 0 ? (
        <Card className="mt-6 max-w-[720px]">
          <CardBody className="p-6">
            <Eyebrow>Nothing here yet</Eyebrow>
            <p className="mt-2 text-[13px] leading-relaxed text-ink-2">
              There are no artifact types, so no estimate can generate a document. This is the
              expected state of a fresh install: artifact types are never seeded, because the brief
              that defines one is a piece of writing rather than a fixture.
            </p>
            <p className="mt-2.5 text-[13px] leading-relaxed text-ink-3">
              Creating one asks for two things — what the document should be, and which parts of an
              estimate the model may read to build it. Everything else, including the page it
              renders into, is already handled.
            </p>
            <div className="mt-4">
              <Button asChild>
                <Link href="/admin/artifact-types/new" data-testid="empty-new-type">
                  Create the first one
                </Link>
              </Button>
            </div>
          </CardBody>
        </Card>
      ) : (
        <Card className="mt-5 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[13px]">
              <thead>
                <tr className="border-b border-line bg-surface-2 text-left">
                  <th className="eyebrow px-4 py-2.5 font-bold">Artifact</th>
                  <th className="eyebrow px-4 py-2.5 font-bold">Reads</th>
                  <th className="eyebrow px-4 py-2.5 font-bold">Active</th>
                  <th className="eyebrow px-4 py-2.5 font-bold">Model</th>
                  <th className="eyebrow px-4 py-2.5 text-right font-bold">Generated</th>
                </tr>
              </thead>
              <tbody>
                {types.map((type) => {
                  const active = type.versions.find((v) => v.active);
                  const { known, unknown } = partitionCorpusSections(active?.corpusSections ?? []);
                  return (
                    <tr
                      key={type.id}
                      className="border-b border-line-soft align-top last:border-0 hover:bg-surface-2"
                      data-testid={`artifact-type-row-${type.key}`}
                    >
                      <td className="px-4 py-3">
                        <Link
                          href={`/admin/artifact-types/${type.key}`}
                          className="font-semibold text-ink hover:text-green hover:underline"
                          data-testid={`artifact-type-link-${type.key}`}
                        >
                          {type.name}
                        </Link>
                        <div className="num mt-0.5 text-[10.5px] text-ink-4">{type.key}</div>
                        {!type.enabled && (
                          <div className="mt-1.5">
                            <Pill tone="neutral" dot={false}>
                              archived
                            </Pill>
                          </div>
                        )}
                        {type.description && (
                          <p className="mt-1.5 max-w-[380px] text-[12px] leading-relaxed text-ink-3">
                            {type.description}
                          </p>
                        )}
                      </td>

                      <td className="max-w-[280px] px-4 py-3">
                        {known.length === 0 && unknown.length === 0 ? (
                          <span className="text-[12px] text-ink-4">nothing selected</span>
                        ) : (
                          <div className="flex flex-wrap gap-1">
                            {known.map((k) => (
                              <Pill key={k} tone="neutral" dot={false}>
                                {corpusSection(k).label}
                              </Pill>
                            ))}
                            {/* A section that no longer exists in this build.
                                Surfaced rather than hidden: the type still runs,
                                but it is quietly seeing less than its author
                                chose. */}
                            {unknown.map((k) => (
                              <Pill key={k} tone="bronze" dot={false}>
                                {k} (retired)
                              </Pill>
                            ))}
                          </div>
                        )}
                      </td>

                      <td className="px-4 py-3">
                        {active ? (
                          <Pill tone="green" dot={false} className="num">
                            v{active.version}
                          </Pill>
                        ) : (
                          <Pill tone="bronze">none</Pill>
                        )}
                      </td>

                      <td className="num px-4 py-3 text-[12px] break-all text-ink-2">
                        {active?.modelString ?? '—'}
                      </td>

                      <td className="num px-4 py-3 text-right whitespace-nowrap text-ink-3">
                        {type._count.artifacts}
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
