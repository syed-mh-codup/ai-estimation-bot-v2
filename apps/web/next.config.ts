import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  transpilePackages: ['@repo/shared', '@repo/db', '@repo/core', '@repo/providers'],
};

export default nextConfig;
