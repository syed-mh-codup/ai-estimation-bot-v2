'use server';

import { revalidatePath } from 'next/cache';

import { prisma } from '@repo/db';
import { requireAdmin, requireUser } from '@/lib/rbac';

/**
 * Delete one generated document. AEH-239.
 *
 * ## Admin only, unlike deleting an estimate
 *
 * `deleteEstimate` allows the owner or an admin, because an estimate has an
 * owner and destroying your own work is your business. A generated artifact has
 * no owner in that sense — `createdBy` records who pressed the button, not who
 * it belongs to — and it is a document that may already have been sent to a
 * client. So the bar is the higher one.
 *
 * ## What survives
 *
 * `ArtifactSection` cascades, which is right: the sections have no meaning
 * without the document they compose.
 *
 * `ModelUsage.artifactId` is `SetNull`, which is also right and is the more
 * important half. Generating a document is N+2 paid model calls, and deleting
 * the document must not delete the record that the money was spent. The spend
 * rows survive with a null artifactId — still attributed to the estimate, still
 * counted in every total, just no longer pointing at a document that is gone.
 * Deleting an artifact to tidy a list must never quietly reduce what the month
 * appears to have cost.
 *
 * ## Why a RUNNING artifact is refused
 *
 * Because an Inngest function is actively writing to that row. Deleting it
 * mid-generation makes the next `update` throw, which fails the step, which
 * fires `onFailure`, which throws again trying to mark a row that no longer
 * exists — a confusing mess in the logs for something the user experiences as
 * "I clicked delete". Waiting for it to finish or fail costs nothing.
 */
export async function deleteArtifact(artifactId: string): Promise<void> {
  await requireAdmin();

  const artifact = await prisma.estimateArtifact.findUnique({
    where: { id: artifactId },
    select: { status: true },
  });
  if (!artifact) throw new Error('Artifact not found');
  if (artifact.status === 'RUNNING' || artifact.status === 'IDLE') {
    throw new Error(
      'This document is still being generated. Wait for it to finish or fail, then delete it.',
    );
  }

  await prisma.estimateArtifact.delete({ where: { id: artifactId } });
}

/**
 * Rename one generated document.
 *
 * An artifact is created under its type's name — "Entity model" — and that is
 * the whole default. It is a name, not a summary, so the only thing that can
 * improve on it is a person who knows what they are about to send: two entity
 * models cut against different scenarios need telling apart, and the type name
 * cannot do it. The generation run deliberately does not touch this column, so
 * a rename made while sections are still being written survives, and the
 * document assembles under the new name.
 *
 * Any signed-in user, unlike `deleteArtifact` above. Deleting destroys a
 * client deliverable; renaming one is reversible by typing the old name back,
 * and the person best placed to name it is whoever is sending it.
 *
 * No `assertEditable` — a FINALISED estimate is the main case for producing
 * documents from it, and nothing here touches the estimate's numbers.
 */
export async function renameArtifact(artifactId: string, title: string): Promise<void> {
  await requireUser();

  const trimmed = title.trim().slice(0, 200);
  // An empty name would leave the masthead and the panel row blank with nothing
  // to click back into. Silently keeping the old one matches `renameEstimate`.
  if (!trimmed) return;

  const row = await prisma.estimateArtifact.update({
    where: { id: artifactId },
    data: { title: trimmed },
    select: { estimateId: true },
  });

  // The estimate screen lists artifacts by title from its own server render,
  // and only re-polls while one is generating. Without this a rename would not
  // show up there until something else happened to invalidate the page.
  revalidatePath(`/estimates/${row.estimateId}`);
}
