import { revalidatePath } from 'next/cache';
import { Prisma, prisma } from '@repo/db';
import { auth } from '@/lib/auth';
import { requireAdmin } from '@/lib/rbac';
import { hashPassword } from '@/lib/password';
import { sendWelcomeEmail } from '@/lib/email';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Card, Heading } from '@/components/ui/card';
import { Pill } from '@/components/ui/pill';
import { Button } from '@/components/ui/button';
import { CreateUserDialog, type CreateUserState } from './CreateUserDialog';

const MIN_PASSWORD_LENGTH = 8;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function setUserRole(formData: FormData) {
  'use server';

  // Re-check admin here: the layout guard only protects page render, not a
  // server action (which can be invoked independently).
  const { id: actingUserId } = await requireAdmin();

  const userId = formData.get('userId');
  const role = formData.get('role');
  if (typeof userId !== 'string' || (role !== 'ADMIN' && role !== 'ESTIMATOR')) {
    return;
  }

  // Guard: an admin cannot demote themselves (would lock them out of admin).
  if (userId === actingUserId && role !== 'ADMIN') {
    return;
  }

  await prisma.user.update({ where: { id: userId }, data: { role } });
  revalidatePath('/admin/users');
}

async function createUser(_state: CreateUserState, formData: FormData): Promise<CreateUserState> {
  'use server';

  await requireAdmin();

  const email = (formData.get('email') ?? '').toString().trim().toLowerCase();
  const name = (formData.get('name') ?? '').toString().trim();
  const password = (formData.get('password') ?? '').toString();
  const role = formData.get('role');

  if (!EMAIL_RE.test(email)) return { error: 'Enter a valid email address.' };
  if (password.length < MIN_PASSWORD_LENGTH) {
    return { error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` };
  }
  if (role !== 'ADMIN' && role !== 'ESTIMATOR') return { error: 'Pick a valid role.' };

  try {
    const hash = await hashPassword(password);
    await prisma.user.create({ data: { email, hash, role, name: name || null } });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      return { error: 'A user with that email already exists.' };
    }
    throw err;
  }

  // Best-effort welcome email with the temp password — never fail creation on it.
  const { sent } = await sendWelcomeEmail({ to: email, name: name || null, tempPassword: password, role });

  revalidatePath('/admin/users');
  return { ok: true, emailed: sent };
}

async function deleteUser(formData: FormData) {
  'use server';

  const { id: actingUserId } = await requireAdmin();

  const userId = formData.get('userId');
  if (typeof userId !== 'string') return;

  // Never delete your own account (would lock the acting admin out mid-session).
  if (userId === actingUserId) return;

  // Estimate.ownerId is a required FK — deleting an owner would violate it.
  const owned = await prisma.estimate.count({ where: { ownerId: userId } });
  if (owned > 0) return;

  await prisma.user.delete({ where: { id: userId } });
  revalidatePath('/admin/users');
}

export default async function UsersAdminPage() {
  const session = await auth();
  const currentUserId = session?.user?.id;

  const users = await prisma.user.findMany({
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      email: true,
      role: true,
      createdAt: true,
      _count: { select: { estimates: true } },
    },
  });

  return (
    <div data-testid="admin-users">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <Heading level={1} className="text-[28px]">
            Users
          </Heading>
          <p className="mt-1 text-[13px] text-ink-3">
            Add users, manage roles, and remove accounts.
          </p>
        </div>
        <CreateUserDialog action={createUser} />
      </div>

      <Card className="mt-5 overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[13px]" data-testid="users-table">
            <thead>
              <tr className="border-b border-line bg-surface-2 text-left">
                <th className="eyebrow px-4 py-2.5 font-bold">Email</th>
                <th className="eyebrow px-4 py-2.5 font-bold">Role</th>
                <th className="eyebrow px-4 py-2.5 font-bold text-right">Estimates</th>
                <th className="eyebrow px-4 py-2.5 font-bold">Created</th>
                <th className="eyebrow px-4 py-2.5 font-bold text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => {
                const nextRole = u.role === 'ADMIN' ? 'ESTIMATOR' : 'ADMIN';
                const isSelf = u.id === currentUserId;
                const isSelfDemotion = isSelf && nextRole !== 'ADMIN';
                const ownsEstimates = u._count.estimates > 0;
                const deleteBlockedReason = isSelf
                  ? "You can't delete your own account"
                  : ownsEstimates
                    ? `Owns ${u._count.estimates} estimate(s) — reassign or remove them first`
                    : undefined;
                return (
                  <tr
                    key={u.id}
                    className="border-b border-line-soft last:border-0"
                    data-testid={`user-row-${u.id}`}
                  >
                    <td className="px-4 py-3 text-ink">
                      <span className="whitespace-nowrap">{u.email}</span>
                      {isSelf && <span className="ml-2 text-[11px] text-ink-4">you</span>}
                    </td>
                    <td className="px-4 py-3">
                      <Pill
                        tone={u.role === 'ADMIN' ? 'green' : 'neutral'}
                        data-testid={`role-${u.id}`}
                      >
                        {u.role}
                      </Pill>
                    </td>
                    <td
                      className="num px-4 py-3 text-right text-ink-2"
                      data-testid={`estimate-count-${u.id}`}
                    >
                      {u._count.estimates}
                    </td>
                    <td className="num whitespace-nowrap px-4 py-3 text-ink-3">
                      {new Date(u.createdAt).toLocaleDateString()}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-2">
                        <form action={setUserRole} className="inline">
                          <input type="hidden" name="userId" value={u.id} />
                          <input type="hidden" name="role" value={nextRole} />
                          <Button
                            type="submit"
                            variant="outline"
                            size="xs"
                            disabled={isSelfDemotion}
                            title={isSelfDemotion ? "You can't demote your own account" : undefined}
                            data-testid={`set-role-${u.id}`}
                          >
                            {nextRole === 'ADMIN' ? 'Make admin' : 'Make estimator'}
                          </Button>
                        </form>
                        <ConfirmDialog
                          action={deleteUser}
                          hidden={{ userId: u.id }}
                          title="Delete user?"
                          description={
                            <>
                              <span className="font-medium text-ink">{u.email}</span> will be
                              permanently removed. This can&rsquo;t be undone.
                            </>
                          }
                          confirmLabel="Delete user"
                          trigger={
                            <button
                              type="button"
                              disabled={Boolean(deleteBlockedReason)}
                              title={deleteBlockedReason}
                              className="rounded-md px-2 py-1 text-[11px] font-semibold text-ink-3 hover:text-brick disabled:cursor-not-allowed disabled:text-ink-4 disabled:hover:text-ink-4"
                              data-testid={`delete-user-${u.id}`}
                            >
                              Delete
                            </button>
                          }
                        />
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
