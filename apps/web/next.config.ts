import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: 'standalone',
  transpilePackages: ['@nexus/types'],
  typescript: {
    ignoreBuildErrors: true,
  },
};

export default nextConfig;
