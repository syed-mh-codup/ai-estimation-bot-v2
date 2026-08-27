import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { prisma } from '@repo/db';
import { LiveMcpProvider, encryptSecret, decryptSecret } from '@repo/providers';
import { requireAdmin } from '@/lib/rbac';
import { Card, CardBody, Heading } from '@/components/ui/card';
import { Pill } from '@/components/ui/pill';
import { Button } from '@/components/ui/button';
import { Input, Select, FieldLabel } from '@/components/ui/input';

async function addConnector(formData: FormData) {
  'use server';
  await requireAdmin();

  const name = (formData.get('name') as string | null)?.trim();
  const transport = (formData.get('transport') as string | null)?.trim();
  const endpoint = (formData.get('endpoint') as string | null)?.trim();
  const secret = (formData.get('authSecret') as string | null)?.trim();
  if (!name || !transport || !endpoint) return;

  // Optional: plenty of MCP servers are open, and requiring a token would make
  // the common case harder for no benefit. Stored encrypted when given —
  // `authRef` holds the ciphertext, never the token.
  let authRef: string | null = null;
  if (secret) {
    const masterKey = process.env['ENCRYPTION_KEY'];
    if (!masterKey) {
      redirect(
        `/admin/mcp?tested=${encodeURIComponent(name)}&ok=false&detail=${encodeURIComponent(
          'ENCRYPTION_KEY is not set on this environment, so a connector secret cannot be stored.',
        )}`,
      );
    }
    authRef = encryptSecret(secret, masterKey);
  }

  await prisma.mcpConnector.create({
    data: { name, transport, endpoint, authRef, enabled: false },
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

  // Actually connect to the MCP server and list its tools — authenticating the
  // same way a run will, so a green Test means the estimate path will work
  // rather than only that the host answers.
  let authSecret: string | undefined;
  if (connector.authRef) {
    const masterKey = process.env['ENCRYPTION_KEY'];
    if (!masterKey) {
      redirect(
        `/admin/mcp?tested=${encodeURIComponent(connector.name)}&ok=false&detail=${encodeURIComponent(
          'This connector has a stored secret but ENCRYPTION_KEY is not set on this environment.',
        )}`,
      );
    }
    authSecret = decryptSecret(connector.authRef, masterKey);
  }

  const result = await new LiveMcpProvider().testConnector(
    connector.endpoint,
    connector.transport,
    authSecret,
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
      <Heading level={1} className="text-[28px]">
        MCP connectors
      </Heading>
      <p className="mt-1 text-[13px] text-ink-3">
        Add a connector, test it, then enable it. A connector stays disabled until you turn it on.
      </p>

      {sp.tested && (
        <div
          data-testid="mcp-test-result"
          className={`mt-4 rounded-md border px-3.5 py-2.5 text-[13px] leading-relaxed ${
            sp.ok === 'true'
              ? 'border-green-line bg-green-tint text-green'
              : 'border-brick-line bg-brick-tint text-brick'
          }`}
        >
          <span className="font-semibold">{sp.tested}:</span>{' '}
          {sp.ok === 'true' ? sp.detail : `Test failed — ${sp.detail}`}
        </div>
      )}

      <Card className="mt-5">
        <CardBody>
          <form action={addConnector} className="flex flex-wrap items-end gap-3">
            <div className="min-w-[160px]">
              <FieldLabel htmlFor="name">Name</FieldLabel>
              <Input id="name" name="name" required />
            </div>
            <div>
              <FieldLabel htmlFor="transport">Transport</FieldLabel>
              <Select id="transport" name="transport" defaultValue="sse" className="num h-9 py-2">
                <option value="sse">sse</option>
                <option value="http">http</option>
                <option value="stdio">stdio</option>
              </Select>
            </div>
            <div className="min-w-[220px] flex-1">
              <FieldLabel htmlFor="endpoint">Endpoint</FieldLabel>
              <Input id="endpoint" name="endpoint" required placeholder="https://…" className="num" />
            </div>
            <div className="min-w-[180px]">
              <FieldLabel htmlFor="authSecret">Token (optional)</FieldLabel>
              <Input
                id="authSecret"
                name="authSecret"
                type="password"
                autoComplete="off"
                placeholder="leave blank if open"
                data-testid="connector-secret"
              />
            </div>
            <Button type="submit" data-testid="add-connector">
              Add connector
            </Button>
          </form>
        </CardBody>
      </Card>

      {connectors.length === 0 ? (
        <div
          className="mt-3.5 rounded-[10px] border border-dashed border-line bg-surface px-6 py-10 text-center"
          data-testid="connectors-empty"
        >
          <div className="font-serif text-[20px] text-ink">No connectors yet</div>
          <p className="mx-auto mt-1.5 max-w-[400px] text-[13px] leading-relaxed text-ink-3">
            Add one above to let the estimation crew pull context from an MCP server — the
            endpoint and transport are all it needs to start.
          </p>
        </div>
      ) : (
        <Card className="mt-3.5 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[13px]" data-testid="connectors-table">
              <thead>
                <tr className="border-b border-line bg-surface-2 text-left">
                  <th className="eyebrow px-4 py-2.5 font-bold">Name</th>
                  <th className="eyebrow px-4 py-2.5 font-bold">Transport</th>
                  <th className="eyebrow px-4 py-2.5 font-bold">Test</th>
                  <th className="eyebrow px-4 py-2.5 font-bold">Enabled</th>
                  <th className="eyebrow px-4 py-2.5 font-bold text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {connectors.map((c) => (
                  <tr
                    key={c.id}
                    className="border-b border-line-soft last:border-0"
                    data-testid={`connector-row-${c.id}`}
                  >
                    <td className="px-4 py-3 text-ink">
                      {c.name}
                      {/* Whether a token is stored, never the token. */}
                      {c.authRef && (
                        <span
                          className="ml-2 rounded border border-line bg-surface px-1 text-[9.5px] font-bold tracking-[0.07em] text-ink-3 uppercase"
                          title="A bearer token is stored for this connector, encrypted at rest"
                          data-testid={`connector-authed-${c.id}`}
                        >
                          Token
                        </span>
                      )}
                    </td>
                    <td className="num px-4 py-3 text-ink-2">{c.transport}</td>
                    <td className="px-4 py-3" data-testid={`connector-test-${c.id}`}>
                      {c.lastTestOk == null ? (
                        <Pill tone="neutral">untested</Pill>
                      ) : c.lastTestOk ? (
                        <Pill tone="green">OK</Pill>
                      ) : (
                        <Pill tone="brick">failed</Pill>
                      )}
                    </td>
                    <td className="px-4 py-3" data-testid={`connector-enabled-${c.id}`}>
                      {c.enabled ? (
                        <Pill tone="green">enabled</Pill>
                      ) : (
                        <Pill tone="neutral">disabled</Pill>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex justify-end gap-2">
                        <form action={testConnector}>
                          <input type="hidden" name="id" value={c.id} />
                          <Button
                            type="submit"
                            variant="outline"
                            size="xs"
                            data-testid={`test-connector-${c.id}`}
                          >
                            Test
                          </Button>
                        </form>
                        <form action={toggleConnector}>
                          <input type="hidden" name="id" value={c.id} />
                          <input type="hidden" name="enabled" value={(!c.enabled).toString()} />
                          <Button
                            type="submit"
                            variant="outline"
                            size="xs"
                            data-testid={`toggle-connector-${c.id}`}
                          >
                            {c.enabled ? 'Disable' : 'Enable'}
                          </Button>
                        </form>
                        <form action={deleteConnector}>
                          <input type="hidden" name="id" value={c.id} />
                          <Button
                            type="submit"
                            variant="quiet"
                            size="xs"
                            className="hover:text-brick"
                            data-testid={`delete-connector-${c.id}`}
                          >
                            Delete
                          </Button>
                        </form>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
