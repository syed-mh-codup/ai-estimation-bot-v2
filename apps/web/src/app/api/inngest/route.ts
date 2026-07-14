import { serve } from 'inngest/next';
import { inngest } from '@/lib/inngest';
import { inngestFunctions } from '@/inngest/functions';

// Functions touch Prisma + the model provider — Node runtime, never cached.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Inngest invokes one `step.run()` per HTTP request, so a single step must fit
// inside this budget. 300s is Vercel's Hobby ceiling (and the Pro default);
// Pro can raise it to 800s. Steps are kept per-agent so none approaches it.
export const maxDuration = 300;

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: inngestFunctions,
});
