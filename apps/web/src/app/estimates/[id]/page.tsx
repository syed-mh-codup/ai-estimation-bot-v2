import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { prisma } from '@repo/db';
import { auth } from '@/lib/auth';

export default async function EstimateDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await auth();
  if (!session?.user) {
    redirect('/login');
  }

  const { id } = await params;
  const estimate = await prisma.estimate.findUnique({
    where: { id },
    include: {
      owner: { select: { email: true } },
      menuItems: { include: { lineItems: true } },
    },
  });

  if (!estimate) {
    notFound();
  }

  return (
    <div data-testid="estimate-detail">
      <Link href="/dashboard" className="text-sm text-gray-500 hover:underline">
        &larr; Back to estimates
      </Link>

      <div className="mt-2 flex items-center gap-3">
        <h1 className="text-2xl font-semibold text-gray-900">{estimate.title}</h1>
        <span
          className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-700"
          data-testid="estimate-status"
        >
          {estimate.status}
        </span>
      </div>
      <p className="mt-1 text-sm text-gray-500">
        Owner: {estimate.owner.email} · Created{' '}
        {new Date(estimate.createdAt).toLocaleString()} · Config v{estimate.configVersion}
      </p>

      <section className="mt-6">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500">
          Statement of Work
        </h2>
        <p className="mt-2 whitespace-pre-wrap rounded-md border border-gray-200 bg-white p-4 text-sm text-gray-800">
          {estimate.sowText}
        </p>
      </section>

      {estimate.menuItems.length > 0 && (
        <section className="mt-6">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500">
            Menu Items
          </h2>
          <ul className="mt-2 space-y-1">
            {estimate.menuItems.map((item) => (
              <li key={item.id} className="text-sm text-gray-800">
                {item.title}
                {item.lineItems.length > 0 && (
                  <span className="text-gray-500">
                    {' '}
                    — {item.lineItems.map((li) => `${li.role}: ${li.taxedHours}h`).join(', ')}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      {estimate.menuItems.length === 0 && (
        <p className="mt-6 text-sm text-gray-500" data-testid="estimate-not-run">
          This estimate has not been run yet — no menu items produced.
        </p>
      )}
    </div>
  );
}
