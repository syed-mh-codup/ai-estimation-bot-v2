import Link from 'next/link';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { after } from 'next/server';
import { prisma, allocatePresetCode } from '@repo/db';
import { requireAdmin } from '@/lib/rbac';
import { inngest, EVENT_EMBED_PRESETS } from '@/lib/inngest';
import { Heading } from '@/components/ui/card';
import { NewPresetForm, type NewPresetState } from './NewPresetForm';

/**
 * Create a preset by hand.
 *
 * Until now the library was seed-only: the list page's empty state told you to
 * shell out and run `db:seed:presets`, and `savePreset` could only version an
 * existing preset (it early-returns without an active version), so nothing could
 * bootstrap one.
 *
 * The form never asks for an id or a number — the code is allocated from a
 * Postgres sequence server-side. Fields are limited to what can't be defaulted,
 * with emphasis on the three that become the preset's embedding; everything else
 * is refined in the editor, which is where the caller lands.
 */

const csv = (v: FormDataEntryValue | null): string[] =>
  typeof v === 'string' ? v.split(',').map((s) => s.trim()).filter(Boolean) : [];
const num = (v: FormDataEntryValue | null): number => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : 0;
};
const oneOf = <T extends readonly string[]>(
  v: FormDataEntryValue | null,
  opts: T,
  fallback: T[number],
): T[number] =>
  typeof v === 'string' && (opts as readonly string[]).includes(v) ? (v as T[number]) : fallback;

const DATA_VOLUMES = ['NONE', 'LOW', 'HIGH'] as const;
const PHASES = ['FOUNDATION', 'CORE', 'ENHANCEMENT'] as const;
const LEVELS = ['LOW', 'MEDIUM', 'HIGH'] as const;

async function createPreset(_state: NewPresetState, formData: FormData): Promise<NewPresetState> {
  'use server';
  await requireAdmin();

  const name = (formData.get('name') ?? '').toString().trim();
  const category = (formData.get('category') ?? '').toString().trim();
  const reqType = (formData.get('reqType') ?? '').toString().trim();
  const description = (formData.get('description') ?? '').toString().trim();

  if (!name) return { error: 'Give the preset a name.' };
  if (!category) return { error: 'Give the preset a category.' };
  if (!reqType) return { error: 'Give the preset a requirement type.' };
  // Not cosmetic: description is part of the text the preset is embedded from,
  // so an empty one produces a preset that never matches a requirement.
  if (description.length < 10) {
    return { error: 'Write a description — it’s what requirements are matched against.' };
  }

  const keywords = csv(formData.get('keywords'));

  let presetId: string;
  try {
    const created = await prisma.$transaction(async (tx) => {
      const preset = await tx.preset.create({
        data: { code: await allocatePresetCode(tx), origin: 'MANUAL' },
        select: { id: true },
      });
      const version = await tx.presetVersion.create({
        data: {
          presetId: preset.id,
          version: 1,
          active: true,
          changeReason: 'created via admin',
        },
        select: { id: true },
      });
      await tx.presetAnchor.create({
        data: {
          presetVersionId: version.id,
          category,
          reqType,
          devHours: num(formData.get('devHours')),
          touchesBackend: formData.get('touchesBackend') === 'on',
          touchesFrontend: formData.get('touchesFrontend') === 'on',
          platforms: csv(formData.get('platforms')),
          integrationCount: num(formData.get('integrationCount')),
          dataVolume: oneOf(formData.get('dataVolume'), DATA_VOLUMES, 'LOW'),
          phase: oneOf(formData.get('phase'), PHASES, 'CORE'),
          risk: oneOf(formData.get('risk'), LEVELS, 'LOW'),
          // Defaulted, editable straight afterwards.
          aiAssist: 'LOW',
          projectSizeFit: [],
          spikeNeeded: false,
        },
      });
      await tx.presetRetrieval.create({
        data: {
          presetVersionId: version.id,
          name,
          description,
          keywords,
          userStoryTags: [],
          notes: '',
        },
      });
      await tx.presetComposition.create({
        data: {
          presetVersionId: version.id,
          canParallel: true,
        },
      });
      // No dependency edges on a new preset by design — they are added from the
      // editor, where the graph is visible and a cycle can be prevented rather
      // than validated after the fact. AEH-242.
      return preset;
    });
    presetId = created.id;
  } catch (err) {
    console.error('[presets] create failed:', err);
    return { error: 'Could not create the preset. Please try again.' };
  }

  revalidatePath('/admin/presets');

  // Embed it, or it doesn't exist as far as the Archivist is concerned:
  // `queryPresetsByVector` filters on `embedding IS NOT NULL`, so an un-embedded
  // preset silently never matches. Out of band and after the response because
  // it's a paid call and the Inngest SDK retries a failed send with backoff.
  // `pnpm db:embed:presets` is the recovery path if the event is lost.
  after(async () => {
    try {
      await inngest.send({ name: EVENT_EMBED_PRESETS, data: { presetIds: [presetId] } });
    } catch (e) {
      console.error(`[presets] could not queue embedding for new preset ${presetId}:`, e);
    }
  });

  // Land on the editor so the remaining fields can be filled in.
  redirect(`/admin/presets/${presetId}`);
}

export default async function NewPresetPage() {
  await requireAdmin();

  return (
    <div data-testid="new-preset-page">
      <Link
        href="/admin/presets"
        className="text-[12.5px] text-ink-3 hover:text-ink hover:underline"
      >
        ← Presets
      </Link>

      <Heading level={1} className="mt-3">
        New preset
      </Heading>
      <p className="mt-2 max-w-2xl text-[13.5px] leading-relaxed text-ink-3">
        A preset is a reusable costed block the crew anchors future estimates against. Its code is
        assigned for you.
      </p>

      <NewPresetForm action={createPreset} />
    </div>
  );
}
