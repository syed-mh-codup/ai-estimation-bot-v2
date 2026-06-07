import path from 'node:path';
import { config as loadEnv } from 'dotenv';
import bcrypt from 'bcryptjs';
// Import the generated Prisma client directly to avoid workspace-alias
// resolution issues in Playwright's loader.
import { PrismaClient } from '../../../packages/db/src/generated/client/index.js';

// Playwright's setup runs outside Next, so load the same env the dev server uses.
loadEnv({ path: path.resolve(__dirname, '../.env.local') });

export const TEST_USERS = {
  admin: { email: 'e2e-admin@example.com', password: 'e2e-admin-pw', role: 'ADMIN' as const },
  estimator: {
    email: 'e2e-estimator@example.com',
    password: 'e2e-estimator-pw',
    role: 'ESTIMATOR' as const,
  },
};

export default async function globalSetup() {
  const prisma = new PrismaClient();
  try {
    for (const user of Object.values(TEST_USERS)) {
      const hash = await bcrypt.hash(user.password, 12);
      await prisma.user.upsert({
        where: { email: user.email },
        update: { hash, role: user.role },
        create: { email: user.email, hash, role: user.role, name: user.email },
      });
    }
  } finally {
    await prisma.$disconnect();
  }
}
