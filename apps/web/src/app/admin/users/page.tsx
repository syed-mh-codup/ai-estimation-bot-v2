import { revalidatePath } from 'next/cache';
import { prisma } from '@repo/db';
import { requireAdmin } from '@/lib/rbac';

async function setUserRole(formData: FormData) {
  'use server';

  // Re-check admin here: the layout guard only protects page render, not a
  // server action (which can be invoked independently).
  await requireAdmin();

  const userId = formData.get('userId');
  const role = formData.get('role');
  if (typeof userId !== 'string' || (role !== 'ADMIN' && role !== 'ESTIMATOR')) {
    return;
  }

  await prisma.user.update({ where: { id: userId }, data: { role } });
  revalidatePath('/admin/users');
}

export default async function UsersAdminPage() {
  const users = await prisma.user.findMany({
    orderBy: { createdAt: 'asc' },
    select: { id: true, email: true, role: true, createdAt: true },
  });

  return (
    <div data-testid="admin-users">
      <h1 className="text-2xl font-semibold text-gray-900">Users</h1>
      <p className="mt-1 text-sm text-gray-500">Manage user roles.</p>

      <table className="mt-6 w-full border-collapse text-sm" data-testid="users-table">
        <thead>
          <tr className="border-b border-gray-200 text-left text-gray-500">
            <th className="py-2 font-medium">Email</th>
            <th className="py-2 font-medium">Role</th>
            <th className="py-2 font-medium">Created</th>
            <th className="py-2 font-medium text-right">Action</th>
          </tr>
        </thead>
        <tbody>
          {users.map((u) => {
            const nextRole = u.role === 'ADMIN' ? 'ESTIMATOR' : 'ADMIN';
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
                <td className="py-3 text-gray-500">
                  {new Date(u.createdAt).toLocaleDateString()}
                </td>
                <td className="py-3 text-right">
                  <form action={setUserRole} className="inline">
                    <input type="hidden" name="userId" value={u.id} />
                    <input type="hidden" name="role" value={nextRole} />
                    <button
                      type="submit"
                      className="rounded-md border border-gray-300 px-3 py-1 text-xs font-medium text-gray-700 hover:bg-gray-50"
                      data-testid={`set-role-${u.id}`}
                    >
                      {nextRole === 'ADMIN' ? 'Make admin' : 'Make estimator'}
                    </button>
                  </form>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
