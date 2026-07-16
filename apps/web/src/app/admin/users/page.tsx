import { revalidatePath } from 'next/cache';
import { Prisma, prisma } from '@repo/db';
import { auth } from '@/lib/auth';
import { requireAdmin } from '@/lib/rbac';
import { hashPassword } from '@/lib/password';
import { CreateUserForm, type CreateUserState } from './CreateUserForm';

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
    await prisma.user.create({
      data: { email, hash, role, name: name || null },
    });
  } catch (err) {
    // Unique-constraint violation on email.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      return { error: 'A user with that email already exists.' };
    }
    throw err;
  }

  revalidatePath('/admin/users');
  return { ok: true };
}

async function deleteUser(formData: FormData) {
  'use server';

  const { id: actingUserId } = await requireAdmin();

  const userId = formData.get('userId');
  if (typeof userId !== 'string') return;

  // Never delete your own account (would lock the acting admin out mid-session).
  if (userId === actingUserId) return;

  // Estimate.ownerId is a required FK — deleting an owner would violate it.
  // Block instead of orphaning/cascading estimates.
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
      <h1 className="text-2xl font-semibold text-gray-900">Users</h1>
      <p className="mt-1 text-sm text-gray-500">Add users, manage roles, and remove accounts.</p>

      <CreateUserForm action={createUser} />

      <table className="mt-6 w-full border-collapse text-sm" data-testid="users-table">
        <thead>
          <tr className="border-b border-gray-200 text-left text-gray-500">
            <th className="py-2 font-medium">Email</th>
            <th className="py-2 font-medium">Role</th>
            <th className="py-2 font-medium">Estimates</th>
            <th className="py-2 font-medium">Created</th>
            <th className="py-2 font-medium text-right">Actions</th>
          </tr>
        </thead>
        <tbody>
          {users.map((u) => {
            const nextRole = u.role === 'ADMIN' ? 'ESTIMATOR' : 'ADMIN';
            // Block the acting admin from demoting their own account.
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
                className="border-b border-gray-100"
                data-testid={`user-row-${u.id}`}
              >
                <td className="py-3 text-gray-900">{u.email}</td>
                <td className="py-3">
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-medium ${
                      u.role === 'ADMIN'
                        ? 'bg-indigo-100 text-indigo-800'
                        : 'bg-gray-100 text-gray-700'
                    }`}
                    data-testid={`role-${u.id}`}
                  >
                    {u.role}
                  </span>
                </td>
                <td className="py-3 text-gray-500" data-testid={`estimate-count-${u.id}`}>
                  {u._count.estimates}
                </td>
                <td className="py-3 text-gray-500">
                  {new Date(u.createdAt).toLocaleDateString()}
                </td>
                <td className="py-3">
                  <div className="flex items-center justify-end gap-2">
                    <form action={setUserRole} className="inline">
                      <input type="hidden" name="userId" value={u.id} />
                      <input type="hidden" name="role" value={nextRole} />
                      <button
                        type="submit"
                        disabled={isSelfDemotion}
                        title={isSelfDemotion ? "You can't demote your own account" : undefined}
                        className="rounded-md border border-gray-300 px-3 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-40"
                        data-testid={`set-role-${u.id}`}
                      >
                        {nextRole === 'ADMIN' ? 'Make admin' : 'Make estimator'}
                      </button>
                    </form>
                    <form action={deleteUser} className="inline">
                      <input type="hidden" name="userId" value={u.id} />
                      <button
                        type="submit"
                        disabled={Boolean(deleteBlockedReason)}
                        title={deleteBlockedReason}
                        className="rounded-md border border-red-200 px-3 py-1 text-xs font-medium text-red-700 hover:bg-red-50 disabled:cursor-not-allowed disabled:border-gray-300 disabled:text-gray-400 disabled:opacity-60"
                        data-testid={`delete-user-${u.id}`}
                      >
                        Delete
                      </button>
                    </form>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
