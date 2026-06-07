import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { prisma } from '@repo/db';
import { LiveMcpProvider } from '@repo/providers';
import { requireAdmin } from '@/lib/rbac';

async function addConnector(formData: FormData) {
  'use server';
  await requireAdmin();

  const name = (formData.get('name') as string | null)?.trim();
  const transport = (formData.get('transport') as string | null)?.trim();
  const endpoint = (formData.get('endpoint') as string | null)?.trim();
  if (!name || !transport || !endpoint) return;

  await prisma.mcpConnector.create({
    data: { name, transport, endpoint, enabled: false },
  });
  revalidatePath('/admin/mcp');
}

async function toggleConnector(formData: FormData) {
  'use server';
  await requireAdmin();

  const id = formData.get('id');
  const enabled = formData.get('enabled') === 'true';
  if (typeof id !== 'string') return;

  await prisma.mcpConnector.update({ where: { id }, data: { enabled } });
  revalidatePath('/admin/mcp');
}

async function testConnector(formData: FormData) {
  'use server';
  await requireAdmin();

  const id = formData.get('id');
  if (typeof id !== 'string') return;

  const connector = await prisma.mcpConnector.findUnique({ where: { id } });
  if (!connector) return;

  // Actually connect to the MCP server and list its tools.
  const result = await new LiveMcpProvider().testConnector(
    connector.endpoint,
    connector.transport,
  );
  await prisma.mcpConnector.update({ where: { id }, data: { lastTestOk: result.ok } });

  const detail = result.ok
    ? `Connected — ${result.tools.length} tool(s)${
        result.tools.length ? `: ${result.tools.map((t) => t.name).join(', ')}` : ''
      }`
    : result.error;
  redirect(
    `/admin/mcp?tested=${encodeURIComponent(connector.name)}&ok=${result.ok}&detail=${encodeURIComponent(
      detail.slice(0, 400),
    )}`,
  );
}

async function deleteConnector(formData: FormData) {
  'use server';
  await requireAdmin();

  const id = formData.get('id');
  if (typeof id !== 'string') return;

  await prisma.mcpConnector.delete({ where: { id } });
  revalidatePath('/admin/mcp');
}

export default async function McpAdminPage({
  searchParams,
}: {
  searchParams: Promise<{ tested?: string; ok?: string; detail?: string }>;
}) {
  const sp = await searchParams;
  const connectors = await prisma.mcpConnector.findMany({ orderBy: { createdAt: 'asc' } });

  return (
    <div data-testid="admin-mcp">
      <h1 className="text-2xl font-semibold text-gray-900">MCP Connectors</h1>
      <p className="mt-1 text-sm text-gray-500">Add a connector, test it, then enable it.</p>

      {sp.tested && (
        <div
          data-testid="mcp-test-result"
          className={`mt-4 rounded-md border px-3 py-2 text-sm ${
            sp.ok === 'true'
              ? 'border-green-200 bg-green-50 text-green-800'
              : 'border-red-200 bg-red-50 text-red-700'
          }`}
        >
          <span className="font-medium">{sp.tested}:</span>{' '}
          {sp.ok === 'true' ? sp.detail : `Test failed — ${sp.detail}`}
        </div>
      )}

      <form action={addConnector} className="mt-6 flex flex-wrap items-end gap-3">
        <div>
          <label htmlFor="name" className="block text-xs font-medium text-gray-600">
            Name
          </label>
          <input
            id="name"
            name="name"
            required
            className="mt-1 rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-gray-500 focus:outline-none"
          />
        </div>
        <div>
          <label htmlFor="transport" className="block text-xs font-medium text-gray-600">
            Transport
          </label>
          <select
            id="transport"
            name="transport"
            defaultValue="sse"
            className="mt-1 rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-gray-500 focus:outline-none"
          >
            <option value="sse">sse</option>
            <option value="http">http</option>
            <option value="stdio">stdio</option>
          </select>
        </div>
        <div className="flex-1">
          <label htmlFor="endpoint" className="block text-xs font-medium text-gray-600">
            Endpoint
          </label>
          <input
            id="endpoint"
            name="endpoint"
            required
            placeholder="https://…"
            className="mt-1 w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-gray-500 focus:outline-none"
          />
        </div>
        <button
          type="submit"
          className="rounded-md bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700"
          data-testid="add-connector"
        >
          Add connector
        </button>
      </form>

      {connectors.length === 0 ? (
        <p className="mt-8 text-sm text-gray-500" data-testid="connectors-empty">
          No connectors yet.
        </p>
      ) : (
        <table className="mt-6 w-full border-collapse text-sm" data-testid="connectors-table">
          <thead>
            <tr className="border-b border-gray-200 text-left text-gray-500">
              <th className="py-2 font-medium">Name</th>
              <th className="py-2 font-medium">Transport</th>
              <th className="py-2 font-medium">Test</th>
              <th className="py-2 font-medium">Enabled</th>
              <th className="py-2 font-medium text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {connectors.map((c) => (
              <tr
                key={c.id}
                className="border-b border-gray-100"
                data-testid={`connector-row-${c.id}`}
              >
                <td className="py-3 text-gray-900">{c.name}</td>
                <td className="py-3 text-gray-600">{c.transport}</td>
                <td className="py-3" data-testid={`connector-test-${c.id}`}>
                  {c.lastTestOk == null ? (
                    <span className="text-gray-400">untested</span>
                  ) : c.lastTestOk ? (
                    <span className="text-green-700">OK</span>
                  ) : (
                    <span className="text-red-700">failed</span>
                  )}
                </td>
                <td className="py-3" data-testid={`connector-enabled-${c.id}`}>
                  {c.enabled ? (
                    <span className="text-green-700">enabled</span>
                  ) : (
                    <span className="text-gray-500">disabled</span>
                  )}
                </td>
                <td className="py-3">
                  <div className="flex justify-end gap-2">
                    <form action={testConnector}>
                      <input type="hidden" name="id" value={c.id} />
                      <button
                        type="submit"
                        className="rounded-md border border-gray-300 px-3 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50"
                        data-testid={`test-connector-${c.id}`}
                      >
                        Test
                      </button>
                    </form>
                    <form action={toggleConnector}>
                      <input type="hidden" name="id" value={c.id} />
                      <input type="hidden" name="enabled" value={(!c.enabled).toString()} />
                      <button
                        type="submit"
                        className="rounded-md border border-gray-300 px-3 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50"
                        data-testid={`toggle-connector-${c.id}`}
                      >
                        {c.enabled ? 'Disable' : 'Enable'}
                      </button>
                    </form>
                    <form action={deleteConnector}>
                      <input type="hidden" name="id" value={c.id} />
                      <button
                        type="submit"
                        className="rounded-md border border-red-200 px-3 py-1 text-xs font-medium text-red-700 hover:bg-red-50"
                        data-testid={`delete-connector-${c.id}`}
                      >
                        Delete
                      </button>
                    </form>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
