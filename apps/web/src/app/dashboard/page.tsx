import Link from 'next/link';
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { prisma } from '@repo/db';
import { auth } from '@/lib/auth';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';

const STATUS_STYLES: Record<string, string> = {
  DRAFT: 'bg-gray-100 text-gray-700',
  REVIEW: 'bg-amber-100 text-amber-800',
  FINALISED: 'bg-green-100 text-green-800',
};

async function deleteEstimateAction(formData: FormData) {
  'use server';
  const session = await auth();
  if (!session?.user) return;
  const id = formData.get('id');
  if (typeof id !== 'string') return;
  await prisma.estimate.delete({ where: { id } });
  revalidatePath('/dashboard');
}

export default async function DashboardPage() {
  const session = await auth();
  if (!session?.user) {
    redirect('/login');
  }

  const estimates = await prisma.estimate.findMany({
    orderBy: { createdAt: 'desc' },
    include: { owner: { select: { email: true } } },
  });

  return (
    <div data-testid="dashboard">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-gray-900">Estimates</h1>
        <Link
          href="/estimates/new"
          className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700"
          data-testid="new-estimate"
        >
          New estimate
        </Link>
      </div>

      {estimates.length === 0 ? (
        <p className="mt-8 text-gray-500" data-testid="estimates-empty">
          No estimates yet. Create your first one.
        </p>
      ) : (
        <table className="mt-6 w-full border-collapse text-sm" data-testid="estimates-table">
          <thead>
            <tr className="border-b border-gray-200 text-left text-gray-500">
              <th className="py-2 font-medium">Title</th>
              <th className="py-2 font-medium">Status</th>
              <th className="py-2 font-medium">Owner</th>
              <th className="py-2 font-medium">Created</th>
              <th className="py-2 font-medium text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {estimates.map((e) => (
              <tr key={e.id} className="border-b border-gray-100 hover:bg-gray-50">
                <td className="py-3">
                  <Link
                    href={`/estimates/${e.id}`}
                    className="font-medium text-gray-900 hover:underline"
                    data-testid={`estimate-row-${e.id}`}
                  >
                    {e.title}
                  </Link>
                </td>
                <td className="py-3">
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                      STATUS_STYLES[e.status] ?? 'bg-gray-100 text-gray-700'
                    }`}
                  >
                    {e.status}
                  </span>
                </td>
                <td className="py-3 text-gray-600">{e.owner.email}</td>
                <td className="py-3 text-gray-500">
                  {new Date(e.createdAt).toLocaleDateString()}
                </td>
                <td className="py-3 text-right">
                  <ConfirmDialog
                    action={deleteEstimateAction}
                    hidden={{ id: e.id }}
                    title="Delete estimate?"
                    description={
                      <>
                        <span className="font-medium text-gray-700">{e.title}</span> and everything
                        under it will be permanently deleted. This can&rsquo;t be undone.
                      </>
                    }
                    confirmLabel="Delete estimate"
                    trigger={
                      <button
                        type="button"
                        className="rounded-md border border-red-200 px-3 py-1 text-xs font-medium text-red-700 hover:bg-red-50"
                        data-testid={`delete-estimate-${e.id}`}
                      >
                        Delete
                      </button>
                    }
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
