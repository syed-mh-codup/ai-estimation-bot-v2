import Link from 'next/link';
import { prisma, getChangeLog, type ChangeLogEntry } from '@repo/db';
import { requireAdmin } from '@/lib/rbac';
import { Card, CardBody, Eyebrow, Heading } from '@/components/ui/card';
import { Pill, type PillTone } from '@/components/ui/pill';

/**
 * One reverse-chronological view of every versioned edit in the system.
 *
 * Each admin screen already shows its own entity's history, which answers "how
 * did this preset get here". It cannot answer the question an admin actually
 * arrives with — "the estimates went strange last Tuesday, what did we change?"
 * — because the answer might be a prompt, a taxonomy node, a config version or
 * a preset, and those are four screens.
 *
 * `getChangeLog` has existed since WS1 and had no caller. It is a single
 * UNION over the four versioned tables, which is the right shape for exactly
 * this and the wrong shape for anything a per-entity page needs. AEH-253.
 */

const ENTITY_TONE: Record<string, PillTone> = {
  preset: 'green',
  taxonomy: 'bronze',
  prompt: 'neutral',
  config: 'neutral',
};

/** Where an entry's own screen lives, when it has one. */
function hrefFor(entry: ChangeLogEntry): string | null {
  switch (entry.entity) {
    case 'preset':
      return `/admin/presets/${entry.entityKey}`;
    case 'taxonomy':
      return `/admin/taxonomy/${encodeURIComponent(entry.entityKey)}`;
    case 'prompt':
      return `/admin/prompts/${entry.entityKey}/${entry.version}`;
    case 'config':
      return '/admin/config';
    default:
      return null;
  }
}

export default async function ChangelogPage() {
  await requireAdmin();
  const entries = await getChangeLog(prisma, 100);

  return (
    <div data-testid="admin-changelog">
      <Heading level={1} className="text-[28px]">
        Changelog
      </Heading>
      <p className="mt-1 text-[13px] text-ink-3">
        Every versioned edit across presets, taxonomy, prompts and config — newest first. Nothing
        here is editable; each row links to the screen that owns it.
      </p>

      <Card className="mt-5 max-w-3xl">
        <CardBody>
          <Eyebrow>Last {entries.length} changes</Eyebrow>
          {entries.length === 0 ? (
            <p className="mt-3 text-[13px] text-ink-3">
              Nothing has been versioned yet.
            </p>
          ) : (
            <ul className="mt-3 divide-y divide-line" data-testid="changelog-entries">
              {entries.map((entry) => {
                const href = hrefFor(entry);
                return (
                  <li key={`${entry.entity}:${entry.entityKey}:${entry.version}`} className="py-3">
                    <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                      <Pill tone={ENTITY_TONE[entry.entity] ?? 'neutral'} dot={false}>
                        {entry.entity}
                      </Pill>
                      {href ? (
                        <Link
                          href={href}
                          className="num text-[13px] font-semibold text-ink hover:text-green"
                        >
                          {entry.entityKey}
                        </Link>
                      ) : (
                        <span className="num text-[13px] font-semibold text-ink">
                          {entry.entityKey}
                        </span>
                      )}
                      <span className="num text-[12px] text-ink-4">v{entry.version}</span>
                      <span className="text-[12px] text-ink-4">
                        {entry.createdAt.toISOString().slice(0, 10)}
                      </span>
                      {entry.createdBy && (
                        <span className="text-[12px] text-ink-4">{entry.createdBy}</span>
                      )}
                      <span className="rounded border border-line bg-surface px-1 text-[9.5px] font-bold tracking-[0.07em] text-ink-3 uppercase">
                        {entry.changeMotivation.toLowerCase().replace(/_/g, ' ')}
                      </span>
                    </div>
                    {entry.changeReason && (
                      <p className="mt-1 text-[12.5px] text-ink-2">{entry.changeReason}</p>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
