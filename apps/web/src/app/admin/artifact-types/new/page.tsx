import Link from 'next/link';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { createArtifactType, prisma } from '@repo/db';
import { requireAdmin } from '@/lib/rbac';
import { Heading } from '@/components/ui/card';
import { fetchModelOptions } from '@/lib/openrouter-models';
import { CorpusPicker, readCorpusSections } from '../CorpusPicker';
import { NewArtifactTypeForm, type NewArtifactTypeState } from './NewArtifactTypeForm';

/**
 * Create an artifact type by hand. AEH-239.
 *
 * This is the only way a type ever comes into existence — there is no seed
 * script and there will not be one, by decision: the brief that defines an
 * artifact is a piece of writing, and shipping a fixture version of it would
 * mean the first thing anybody did was rewrite it.
 *
 * The form asks for what cannot be defaulted, in the order it has to be thought
 * about: what the document is, what the model may read, and what it should
 * produce. The URL handle is allocated server-side from the name, like a
 * preset's code, so nobody has to invent an identifier.
 */

const MIN_BRIEF = 40;

async function createType(
  _state: NewArtifactTypeState,
  formData: FormData,
): Promise<NewArtifactTypeState> {
  'use server';
  const admin = await requireAdmin();

  const name = (formData.get('name') ?? '').toString().trim();
  const description = (formData.get('description') ?? '').toString().trim();
  const promptBody = (formData.get('promptBody') ?? '').toString().trim();
  const modelString = (formData.get('modelString') ?? '').toString().trim();
  const corpusSections = readCorpusSections(formData);

  if (!name) return { error: 'Give the artifact a name.' };
  if (!modelString) return { error: 'Choose a model.' };
  // Not cosmetic. The brief is the entire specification of what gets generated
  // — there is no template behind it filling in the shape — so a one-liner
  // produces a document nobody wants and a bill for producing it.
  if (promptBody.length < MIN_BRIEF) {
    return {
      error: `Write the brief — it is the whole specification of the document, and ${MIN_BRIEF} characters is the floor.`,
    };
  }
  // An artifact with no corpus can only describe the estimate in the abstract,
  // which is never what anyone meant.
  if (corpusSections.length === 0) {
    return { error: 'Tick at least one section for the artifact to read.' };
  }

  const author = await prisma.user.findUnique({
    where: { id: admin.id },
    select: { email: true },
  });

  const { key } = await createArtifactType(prisma, {
    name,
    description: description || null,
    promptBody,
    modelString,
    corpusSections,
    createdBy: author?.email ?? null,
  });

  revalidatePath('/admin/artifact-types');
  redirect(`/admin/artifact-types/${key}`);
}

export default async function NewArtifactTypePage() {
  // Live catalogue, cached for an hour. An empty list degrades the picker to
  // free text rather than blocking creation — same contract as the prompt
  // editor's.
  const models = await fetchModelOptions();
  const modelOptions = models.map((m) => ({
    value: m.id,
    label: m.name,
    hint: [
      m.contextLength ? `${Math.round(m.contextLength / 1000)}k context` : null,
      m.promptPrice !== null ? `$${(m.promptPrice * 1_000_000).toFixed(2)}/M in` : null,
      m.completionPrice !== null ? `$${(m.completionPrice * 1_000_000).toFixed(2)}/M out` : null,
    ]
      .filter(Boolean)
      .join(' · '),
  }));

  return (
    <div data-testid="admin-artifact-type-new">
      <Link
        href="/admin/artifact-types"
        className="text-[12.5px] text-ink-3 hover:text-ink hover:underline"
      >
        ← Artifacts
      </Link>

      <Heading level={1} className="mt-3">
        New artifact type
      </Heading>
      <p className="mt-1.5 max-w-[720px] text-[13px] text-ink-3">
        This creates the type and its first version. Everything here is versioned from the moment
        you save, so the brief is safe to iterate on — nothing is overwritten.
      </p>

      <NewArtifactTypeForm
        action={createType}
        modelOptions={modelOptions}
        corpusSlot={<CorpusPicker selected={[]} />}
      />
    </div>
  );
}
