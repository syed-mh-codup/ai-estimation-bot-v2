import { serve } from 'inngest/next';
import { inngest } from '@/lib/inngest';
import { inngestFunctions } from '@/inngest/functions';

// Functions touch Prisma + the model provider — Node runtime, never cached.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: inngestFunctions,
});
