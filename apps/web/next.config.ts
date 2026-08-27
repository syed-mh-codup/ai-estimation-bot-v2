import type { NextConfig } from 'next';
import path from 'node:path';
import { PrismaPlugin } from '@prisma/nextjs-monorepo-workaround-plugin';

const nextConfig: NextConfig = {
  transpilePackages: ['@repo/shared', '@repo/db', '@repo/providers', '@repo/agents'],
  // Monorepo: trace from the repo root so the standalone/function bundles can
  // reference files outside apps/web (e.g. @repo/db).
  outputFileTracingRoot: path.join(__dirname, '..', '..'),
  webpack: (config, { isServer }) => {
    // Workspace packages use NodeNext-style `.js` extensions in relative imports
    // that actually point to `.ts` sources (e.g. @repo/shared's
    // `export * from './schemas.js'`). Teach webpack to resolve `.js` → `.ts`.
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      '.js': ['.ts', '.tsx', '.js'],
    };
    // Prisma emits its query engine (.so.node) into @repo/db's custom generated
    // client dir. Next bundles the client JS into .next/server, but Prisma then
    // looks for the engine *next to that bundle* — not in packages/db — so on
    // Vercel it throws "Query Engine for rhel-openssl-3.0.x could not be found".
    // This plugin copies the engine next to the server bundle, which is exactly
    // one of the paths Prisma searches at runtime. (Merely file-tracing the
    // engine is not enough: it lands under packages/db/, where Prisma won't look.)
    if (isServer) {
      config.plugins = [...config.plugins, new PrismaPlugin()];
    }
    return config;
  },
};

export default nextConfig;
