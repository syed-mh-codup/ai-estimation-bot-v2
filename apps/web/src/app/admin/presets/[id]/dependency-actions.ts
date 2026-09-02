'use server';

import { revalidatePath } from 'next/cache';
import { prisma, loadPresetGraph } from '@repo/db';
import { wouldCreateCycle } from '@repo/shared';
import { requireAdmin } from '@/lib/rbac';

export type DependencyActionResult = { error?: string };

/**
 * Edges are edited in place on the ACTIVE version, not by minting a new one.
 *
 * The rest of this editor versions on save, so this is a deliberate exception.
 * Cutting a version per edge click would make wiring up a preset with five
 * prerequisites produce five versions of noise, and the history it bought would
 * be of individual clicks rather than of meaningful states.
 *
 * History is not lost. `carryPresetEdges` snapshots the whole edge set onto each
 * new version as it is created, so every superseded version keeps exactly the
 * edges it had when it was superseded. The active version is the working draft;
 * the frozen ones stay frozen. The editor says so on screen rather than leaving
 * an admin to infer it — AEH-244 is the record of what happens when a screen
 * promises history it is not delivering.
 */
async function activeVersionIdFor(presetId: string): Promise<string | null> {
  const active = await prisma.presetVersion.findFirst({
    where: { presetId, active: true },
    orderBy: { version: 'desc' },
    select: { id: true },
  });
  return active?.id ?? null;
}

export async function addPresetDependency(
  presetId: string,
  prerequisitePresetId: string,
  note: string,
): Promise<DependencyActionResult> {
  await requireAdmin();

  if (presetId === prerequisitePresetId) {
    return { error: 'A preset cannot depend on itself.' };
  }

  // Re-checked here even though the picker cannot offer a cycle-forming option.
  // The UI guard is what makes the interaction pleasant; this is what makes the
  // invariant true. Two admins editing different presets at the same time can
  // each be offered a valid option that together close a loop, and only the
  // server sees both.
  const graph = await loadPresetGraph(prisma);
  if (!graph.nodes.has(prerequisitePresetId)) {
    return { error: 'That preset has no active version.' };
  }
  if (wouldCreateCycle(graph, presetId, prerequisitePresetId)) {
    return { error: 'That would create a circular dependency — nothing could be built first.' };
  }

  const versionId = await activeVersionIdFor(presetId);
  if (!versionId) return { error: 'This preset has no active version.' };

  await prisma.presetDependency.upsert({
    where: {
      dependentVersionId_prerequisitePresetId: {
        dependentVersionId: versionId,
        prerequisitePresetId,
      },
    },
    update: { note: note.trim() || null },
    create: {
      dependentVersionId: versionId,
      prerequisitePresetId,
      note: note.trim() || null,
    },
  });

  revalidatePath(`/admin/presets/${presetId}`);
  revalidatePath('/admin/presets/graph');
  return {};
}

export async function removePresetDependency(
  presetId: string,
  prerequisitePresetId: string,
): Promise<DependencyActionResult> {
  await requireAdmin();

  const versionId = await activeVersionIdFor(presetId);
  if (!versionId) return { error: 'This preset has no active version.' };

  await prisma.presetDependency.deleteMany({
    where: { dependentVersionId: versionId, prerequisitePresetId },
  });

  revalidatePath(`/admin/presets/${presetId}`);
  revalidatePath('/admin/presets/graph');
  return {};
}
