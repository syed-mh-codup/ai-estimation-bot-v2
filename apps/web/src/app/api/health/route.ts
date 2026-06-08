import { NextResponse } from 'next/server';
import { prisma } from '@repo/db';
import { checkServerEnv } from '@/lib/env';

/**
 * WS28-03: public health check (allowed pre-auth in auth.config). Reports DB
 * connectivity + required-env presence. Returns 503 if the DB is unreachable or
 * required env is missing, so a load balancer / deploy probe can gate traffic.
 */
export async function GET() {
  const env = checkServerEnv();
  let db = false;
  try {
    await prisma.$queryRaw`SELECT 1`;
    db = true;
  } catch {
    db = false;
  }

  const ok = db && env.ok;
  return NextResponse.json(
    {
      status: ok ? 'ok' : 'degraded',
      db: db ? 'up' : 'down',
      env: { ok: env.ok, missingRequired: env.missingRequired, integrations: env.presentOptional },
      time: new Date().toISOString(),
    },
    { status: ok ? 200 : 503 },
  );
}
