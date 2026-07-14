/**
 * Production admin seed. Creates (or re-points) a single ADMIN user from the
 * environment — deliberately separate from `db:seed`, which carries the
 * publicly-known dev credentials and therefore refuses to run its user seed in
 * production.
 *
 * There are no defaults here on purpose: a missing or weak password is a hard
 * error, never a silently-created account.
 *
 * Run: ADMIN_EMAIL=you@codup.co ADMIN_PASSWORD='…' pnpm db:seed:admin
 * Idempotent — re-running resets the password of an existing admin.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import { PrismaClient } from './generated/client/index.js';

// Same dependency-free .env fallback as seed.ts (tsx does not auto-load it).
if (!process.env['DATABASE_URL']) {
  try {
    const envFile = readFileSync(path.resolve(__dirname, '../.env'), 'utf8');
    for (const line of envFile.split('\n')) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m && m[1] && !process.env[m[1]]) {
        process.env[m[1]] = m[2]!.replace(/^["']|["']$/g, '');
      }
    }
  } catch {
    // fall through — Prisma reports a clear error if the URL is missing
  }
}

const SALT_ROUNDS = 12;
const MIN_PASSWORD_LENGTH = 12;

async function main() {
  const email = process.env['ADMIN_EMAIL']?.trim();
  const password = process.env['ADMIN_PASSWORD'];

  if (!email || !password) {
    throw new Error(
      'ADMIN_EMAIL and ADMIN_PASSWORD must both be set.\n' +
        'Example: ADMIN_EMAIL=you@codup.co ADMIN_PASSWORD="$(openssl rand -base64 24)" pnpm db:seed:admin',
    );
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`ADMIN_PASSWORD must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }

  const prisma = new PrismaClient();
  try {
    const hash = await bcrypt.hash(password, SALT_ROUNDS);
    const user = await prisma.user.upsert({
      where: { email },
      update: { hash, role: 'ADMIN' },
      create: { email, hash, role: 'ADMIN', name: email },
    });
    console.log(`Admin ready: ${user.email} (${user.id})`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(String(err instanceof Error ? err.message : err));
  process.exit(1);
});
