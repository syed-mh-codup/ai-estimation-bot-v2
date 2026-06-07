import { createHash } from 'node:crypto';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { prisma } from '@repo/db';
import { auth } from '@/lib/auth';

async function createEstimate(formData: FormData) {
  'use server';

  const session = await auth();
  if (!session?.user) {
    redirect('/login');
  }

  const title = (formData.get('title') as string | null)?.trim();
  const sowText = (formData.get('sowText') as string | null)?.trim();
  if (!title || !sowText) {
    // Minimal guard; the form fields are `required` client-side too.
    redirect('/estimates/new');
  }

  // A DRAFT only needs a valid config version; the agent run (WS22-02) resolves
  // and pins the remaining versions when it executes.
  const activeConfig = await prisma.estimationConfig.findFirst({
    where: { active: true },
    orderBy: { version: 'desc' },
    select: { version: true },
  });

  const estimate = await prisma.estimate.create({
    data: {
      title,
      sowText,
      sowHash: createHash('sha256').update(sowText).digest('hex'),
      status: 'DRAFT',
      configVersion: activeConfig?.version ?? 0,
      taxonomyVersionsPinned: {},
      promptVersionsPinned: {},
      modelConfig: {},
      agentState: {},
      ownerId: session.user.id,
    },
  });

  redirect(`/estimates/${estimate.id}`);
}

export default async function NewEstimatePage() {
  const session = await auth();
  if (!session?.user) {
    redirect('/login');
  }

  return (
    <div data-testid="new-estimate-page">
      <Link href="/dashboard" className="text-sm text-gray-500 hover:underline">
        &larr; Back to estimates
      </Link>
      <h1 className="mt-2 text-2xl font-semibold text-gray-900">New estimate</h1>
      <p className="mt-1 text-sm text-gray-500">
        Paste a Statement of Work to create a draft. You can run the estimate later.
      </p>

      <form action={createEstimate} className="mt-6 max-w-2xl space-y-4">
        <div>
          <label htmlFor="title" className="block text-sm font-medium text-gray-700">
            Title
          </label>
          <input
            id="title"
            name="title"
            type="text"
            required
            className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-gray-500 focus:outline-none"
            placeholder="e.g. Customer Loyalty Mobile App"
          />
        </div>
        <div>
          <label htmlFor="sowText" className="block text-sm font-medium text-gray-700">
            Statement of Work
          </label>
          <textarea
            id="sowText"
            name="sowText"
            required
            rows={12}
            className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-gray-500 focus:outline-none"
            placeholder="Describe the scope, features, and integrations…"
          />
        </div>
        <button
          type="submit"
          className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700"
          data-testid="create-estimate-submit"
        >
          Create draft
        </button>
      </form>
    </div>
  );
}
