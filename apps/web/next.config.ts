import type { NextConfig } from 'next';
import path from 'node:path';

const nextConfig: NextConfig = {
  transpilePackages: ['@repo/shared', '@repo/db', '@repo/core', '@repo/providers', '@repo/agents'],
  // Monorepo: trace from the repo root so files that live outside apps/web (in
  // particular @repo/db's Prisma engine) can be bundled into the serverless
  // functions. Without this the tracer's base is apps/web and it can't reach
  // ../../packages/db.
  outputFileTracingRoot: path.join(__dirname, '..', '..'),
  // Prisma emits its query engine (libquery_engine-<platform>.so.node) into
  // @repo/db's *custom* generated-client dir. Next's file tracer does not
  // auto-detect a native addon in that non-standard location, so on Vercel the
  // .so.node is left out of the function bundle and Prisma throws at runtime:
  //   "Query Engine for runtime rhel-openssl-3.0.x could not be found".
  // Include it explicitly for every server route (any route may touch the DB).
  // Glob is a wildcard because the platform differs (debian locally, rhel on
  // Vercel), so we can't name a single file.
  outputFileTracingIncludes: {
    '**/*': ['../../packages/db/src/generated/client/**/*'],
  },
  webpack: (config) => {
    // Workspace packages use NodeNext-style `.js` extensions in relative imports
    // that actually point to `.ts` sources (e.g. @repo/shared's
    // `export * from './schemas.js'`). Teach webpack to resolve `.js` → `.ts`.
    config.resolve.extensionAlias = {
      ...config.resolve.extensionAlias,
      '.js': ['.ts', '.tsx', '.js'],
    };
    return config;
  },
};

export default nextConfig;
