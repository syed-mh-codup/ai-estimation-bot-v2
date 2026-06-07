import { auth } from '@/lib/auth';
import { redirect } from 'next/navigation';

export default async function DashboardPage() {
  const session = await auth();
  if (!session?.user) {
    redirect('/login');
  }

  return (
    <div data-testid="dashboard">
      <h1 className="text-2xl font-semibold text-gray-900">Dashboard</h1>
      <p className="mt-2 text-gray-600">Welcome, {session.user.email}</p>
      <p className="text-gray-600">Role: {session.user.role}</p>
    </div>
  );
}
