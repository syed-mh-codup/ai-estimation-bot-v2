import Link from 'next/link';
import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import { Heading } from '@/components/ui/card';
import { NewEstimateForm } from './NewEstimateForm';

export default async function NewEstimatePage() {
  const session = await auth();
  if (!session?.user) {
    redirect('/login');
  }

  return (
    <div data-testid="new-estimate-page">
      <Link href="/dashboard" className="text-[12.5px] text-ink-3 hover:text-ink hover:underline">
        ← Estimates
      </Link>

      <Heading level={1} className="mt-3">
        New estimate
      </Heading>
      <p className="mt-2 max-w-2xl text-[13.5px] leading-relaxed text-ink-3">
        Attach the client&rsquo;s material — a BRD or SOW as PDF, Word or images — and paste any
        scope you have as text. Both together read best. We turn it into a draft you can run.
      </p>

      <NewEstimateForm />
    </div>
  );
}
