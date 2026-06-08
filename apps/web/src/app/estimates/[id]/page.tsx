import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { prisma } from '@repo/db';
import { createModelProvider } from '@repo/providers';
import { runEstimate } from '@repo/agents';
import { auth } from '@/lib/auth';

const ROLES = ['DEV', 'QA', 'PM', 'BA'] as const;

async function runEstimateAction(formData: FormData) {
  'use server';
  const session = await auth();
  if (!session?.user) {
    redirect('/login');
  }
  const id = formData.get('id');
  if (typeof id !== 'string') return;

  try {
    const modelProvider = createModelProvider();
    await runEstimate(id, { db: prisma, modelProvider });
  } catch (err) {
    // Surface the failure (e.g. OpenRouter 402) instead of a stack trace — this
    // is exactly the signal that the wiring is correct and only awaiting credits.
    const msg = err instanceof Error ? err.message : String(err);
    redirect(`/estimates/${id}?runError=${encodeURIComponent(msg.slice(0, 400))}`);
  }
  redirect(`/estimates/${id}`);
}

export default async function EstimateDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ runError?: string }>;
}) {
  const session = await auth();
  if (!session?.user) {
    redirect('/login');
  }

  const { id } = await params;
  const { runError } = await searchParams;
  const estimate = await prisma.estimate.findUnique({
    where: { id },
    include: {
      owner: { select: { email: true } },
      menuItems: { include: { lineItems: true }, orderBy: { id: 'asc' } },
    },
  });

  if (!estimate) {
    notFound();
  }

  // Roll-up totals per role + grand total (enabled items only).
  const roleTotals: Record<string, number> = { DEV: 0, QA: 0, PM: 0, BA: 0 };
  let grandTotal = 0;
  for (const item of estimate.menuItems) {
    if (!item.enabled) continue;
    for (const li of item.lineItems) {
      roleTotals[li.role] = (roleTotals[li.role] ?? 0) + li.taxedHours;
      grandTotal += li.taxedHours;
    }
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
        {estimate.complexityScore != null && (
          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-800">
            complexity {estimate.complexityScore}/5
          </span>
        )}
      </div>
      <p className="mt-1 text-sm text-gray-500">
        Owner: {estimate.owner.email} · Created{' '}
        {new Date(estimate.createdAt).toLocaleString()} · Config v{estimate.configVersion}
      </p>

      <form action={runEstimateAction} className="mt-4">
        <input type="hidden" name="id" value={estimate.id} />
        <button
          type="submit"
          className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700"
          data-testid="run-estimate"
        >
          {estimate.menuItems.length > 0 ? 'Re-run estimate' : 'Run estimate'}
        </button>
      </form>

      {runError && (
        <div
          data-testid="run-error"
          className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
        >
          <span className="font-medium">Run failed:</span> {runError}
        </div>
      )}

      <section className="mt-6">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500">
          Statement of Work
        </h2>
        <p className="mt-2 whitespace-pre-wrap rounded-md border border-gray-200 bg-white p-4 text-sm text-gray-800">
          {estimate.sowText}
        </p>
      </section>

      {estimate.narrative.length > 0 && (
        <section className="mt-6">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500">Narrative</h2>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-gray-800">
            {estimate.narrative.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        </section>
      )}

      {estimate.assumptions.length > 0 && (
        <section className="mt-6">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500">
            Assumptions
          </h2>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-gray-800">
            {estimate.assumptions.map((a, i) => (
              <li key={i}>{a}</li>
            ))}
          </ul>
        </section>
      )}

      {estimate.menuItems.length > 0 ? (
        <section className="mt-6">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-gray-500">
            Menu Card
          </h2>
          <table className="mt-2 w-full border-collapse text-sm" data-testid="menu-card">
            <thead>
              <tr className="border-b border-gray-200 text-left text-gray-500">
                <th className="py-2 font-medium">Item</th>
                {ROLES.map((r) => (
                  <th key={r} className="py-2 text-right font-medium">
                    {r}
                  </th>
                ))}
                <th className="py-2 text-right font-medium">Total</th>
              </tr>
            </thead>
            <tbody>
              {estimate.menuItems.map((item) => {
                const byRole: Record<string, number> = {};
                let itemTotal = 0;
                for (const li of item.lineItems) {
                  byRole[li.role] = li.taxedHours;
                  itemTotal += li.taxedHours;
                }
                return (
                  <tr key={item.id} className="border-b border-gray-100">
                    <td className="py-2 text-gray-900">{item.title}</td>
                    {ROLES.map((r) => (
                      <td key={r} className="py-2 text-right text-gray-600">
                        {byRole[r] ?? 0}
                      </td>
                    ))}
                    <td className="py-2 text-right font-medium text-gray-900">{itemTotal}</td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-gray-300 font-semibold text-gray-900">
                <td className="py-2">Total (taxed hours)</td>
                {ROLES.map((r) => (
                  <td key={r} className="py-2 text-right" data-testid={`total-${r}`}>
                    {roleTotals[r] ?? 0}
                  </td>
                ))}
                <td className="py-2 text-right" data-testid="total-all">
                  {grandTotal}
                </td>
              </tr>
            </tfoot>
          </table>
        </section>
      ) : (
        <p className="mt-6 text-sm text-gray-500" data-testid="estimate-not-run">
          This estimate has not been run yet — click “Run estimate” to generate a Menu Card.
        </p>
      )}
    </div>
  );
}
