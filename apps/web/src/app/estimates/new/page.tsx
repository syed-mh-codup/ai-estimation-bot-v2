import Link from 'next/link';
import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import { NewEstimateForm } from './NewEstimateForm';

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
        Upload the client&apos;s material (BRD/SOW as PDF, Word, images) and/or paste text to create a
        draft. You can run the estimate once it&apos;s created.
      </p>

      <NewEstimateForm />
    </div>
  );
}
