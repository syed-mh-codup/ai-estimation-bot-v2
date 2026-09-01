import { PrismaClient } from './generated/client/index.js';

const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma = globalForPrisma.prisma ?? new PrismaClient();

if (process.env['NODE_ENV'] !== 'production') {
  globalForPrisma.prisma = prisma;
}

export * from './generated/client/index.js';
export * from './vector';
export * from './preset-code';
export * from './changelog';
export * from './menu-item-mapping';
export * from './agent-catalogue';
export * from './usage-catalogue';
