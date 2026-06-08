import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  transpilePackages: ['@repo/shared', '@repo/db', '@repo/core', '@repo/providers', '@repo/agents'],
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
