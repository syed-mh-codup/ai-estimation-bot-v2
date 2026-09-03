import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { prisma } from '@repo/db';
import type { ArtifactOutline } from '@repo/shared';
import { auth } from '@/lib/auth';
import { Card, CardBody, Eyebrow, Heading } from '@/components/ui/card';
import { Pill } from '@/components/ui/pill';
import { ArtifactFrame } from './ArtifactFrame';
import { ArtifactProgress } from './ArtifactProgress';
import { ResumeButton } from './ResumeButton';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { deleteArtifact } from './actions';

/**
 * Delete, then go back to the estimate.
 *
 * A thin wrapper over the action so the page can bind it to ConfirmDialog's
 * form: the authorization and the state guard live in `deleteArtifact`, where
 * they are unit-tested without a browser.
 */
async function deleteArtifactAction(formData: FormData) {
  'use server';
  const artifactId = formData.get('artifactId');
  const estimateId = formData.get('estimateId');
  if (typeof artifactId !== 'string' || typeof estimateId !== 'string') return;

  await deleteArtifact(artifactId);

  revalidatePath(`/estimates/${estimateId}`);
  redirect(`/estimates/${estimateId}`);
}

/**
 * One generated document. AEH-239.
 *
 * A page of its own rather than a panel on the estimate screen, for the reason
 * AEH-302 is already about: that rail is a fixed stack that keeps growing and
 * buries the actions. A ~100KB interactive document is the last thing that
 * should be wedged into it.
 */
export default async function ArtifactPage({
  params,
}: {
  params: Promise<{ id: string; artifactId: string }>;
}) {
  const { id: estimateId, artifactId } = await params;

  const session = await auth();
  if (!session?.user) redirect('/login');

  const artifact = await prisma.estimateArtifact.findUnique({
    where: { id: artifactId },
    include: {
      artifactType: { select: { name: true, key: true } },
      estimate: { select: { id: true, title: true, runFinishedAt: true } },
      sections: { orderBy: { order: 'asc' }, select: { sectionId: true, title: true } },
    },
  });
  // Checked rather than assumed: an artifact id from another estimate would
  // otherwise render here under this estimate's breadcrumb.
  if (!artifact || artifact.estimateId !== estimateId) notFound();

  // Written by the outline step after passing its schema, so the shape is
  // already guaranteed; re-validating here would break a progress view over a
  // document that is generating perfectly well.
  const outline = (artifact.outline ?? null) as ArtifactOutline | null;

  // An Inngest function is writing to this row, so it cannot be deleted yet.
  // The control is hidden rather than shown and then refused.
  const generating = artifact.status === 'RUNNING' || artifact.status === 'IDLE';

  // The run that produced the numbers in this document has since been
  // superseded. Not an error — an artifact is a snapshot and says so in its own
  // footer — but somebody about to send it to a client should know.
  const stale =
    artifact.estimate.runFinishedAt !== null &&
    artifact.createdAt < artifact.estimate.runFinishedAt;

  const filename = `${artifact.artifactType.key}-${artifact.estimate.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)}.html`;

  return (
    <div data-testid="artifact-page">
      <Link
        href={`/estimates/${estimateId}`}
        className="text-[12.5px] text-ink-3 hover:text-ink hover:underline"
      >
        ← {artifact.estimate.title}
      </Link>

      <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-2">
        <Heading level={1} className="min-w-0 break-words">
          {artifact.title}
        </Heading>
        {artifact.status === 'DONE' && (
          <Pill tone="green" data-testid="artifact-status">
            ready
          </Pill>
        )}
        {artifact.status === 'RUNNING' && (
          <Pill tone="bronze" data-testid="artifact-status">
            generating
          </Pill>
        )}
        {artifact.status === 'FAILED' && (
          <Pill tone="brick" data-testid="artifact-status">
            failed
          </Pill>
        )}
        {stale && (
          <Pill tone="bronze" dot={false} data-testid="artifact-stale">
            generated before the last run
          </Pill>
        )}
      </div>

      <p className="mt-1.5 text-[13px] text-ink-3">
        {artifact.artifactType.name} · generated{' '}
        {new Date(artifact.createdAt).toLocaleString()}
        {artifact.createdBy ? ` by ${artifact.createdBy}` : ''} · from v
        <span className="num">{artifact.typeVersion}</span> of the brief
      </p>

      {stale && (
        <p className="mt-2 max-w-[720px] text-[12.5px] leading-relaxed text-ink-3">
          This estimate has been re-run since this document was generated, so its figures may no
          longer match. Generate it again to bring it up to date — the old one is kept either way.
        </p>
      )}

      {artifact.status === 'FAILED' && (
        <Card className="mt-5 max-w-[720px]">
          <CardBody>
            <Eyebrow>What went wrong</Eyebrow>
            <p className="mt-1.5 text-[13px] text-ink-2" data-testid="artifact-error">
              {artifact.error ?? 'Generation failed with no message.'}
            </p>
            {artifact.sections.length > 0 && (
              <p className="mt-2.5 text-[12.5px] leading-relaxed text-ink-3">
                {artifact.sections.length}{' '}
                {artifact.sections.length === 1 ? 'section was' : 'sections were'} written before it
                stopped, and{' '}
                {artifact.sections.length === 1 ? 'it is' : 'they are'} kept.
              </p>
            )}

            {/* Resume, not Generate. Generate would start a NEW document and
                pay for every section again; this re-runs the same one against
                the plan it already has. */}
            <ResumeButton
              estimateId={estimateId}
              artifactId={artifact.id}
              written={artifact.sections.length}
              planned={outline?.sections.length ?? 0}
            />
          </CardBody>
        </Card>
      )}

      {/* Server-rendered once, then kept live by its own poll. The page is a
          server component, so without this it showed a frozen line for the
          whole of a multi-minute generation — accurate at first paint and
          misleading a second later. */}
      <ArtifactProgress
        estimateId={estimateId}
        artifactId={artifact.id}
        initial={{
          status: artifact.status,
          stage: artifact.stage,
          pct: artifact.pct,
          error: artifact.error,
          title: outline?.title ?? null,
          sections: (outline?.sections ?? []).map((s) => ({ id: s.id, title: s.title })),
          written: artifact.sections.map((s) => s.sectionId),
        }}
      />

      {artifact.status === 'DONE' && artifact.content && (
        <div className="mt-5">
          <ArtifactFrame html={artifact.content} filename={filename} />
        </div>
      )}

      {/* Admin only, and last on the page: destructive, rare, and it should not
          sit next to Download where a mis-click is expensive. */}
      {session.user.role === 'ADMIN' && !generating && (
        <div className="mt-8 max-w-[720px] border-t border-line-soft pt-4">
          <ConfirmDialog
            action={deleteArtifactAction}
            hidden={{ artifactId: artifact.id, estimateId }}
            title="Delete this document?"
            description={
              <>
                <span className="font-medium text-ink">{artifact.title}</span> and its{' '}
                {artifact.sections.length}{' '}
                {artifact.sections.length === 1 ? 'section' : 'sections'} will be permanently
                deleted. This can&rsquo;t be undone, and anyone you have already sent the file to
                keeps their copy. What it cost stays on the estimate&rsquo;s spend.
              </>
            }
            confirmLabel="Delete document"
            trigger={
              <button
                type="button"
                className="text-xs text-ink-3 hover:text-brick"
                data-testid="delete-artifact"
              >
                Delete this document
              </button>
            }
          />
        </div>
      )}
    </div>
  );
}
