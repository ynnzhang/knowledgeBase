import path from 'node:path';
import type { NextConfig } from 'next';
import { localApiPort } from './scripts/local-config.mjs';

const nextConfig: NextConfig = {
  outputFileTracingRoot: path.resolve(import.meta.dirname),
  poweredByHeader: false,
  compress: true,
  async rewrites() {
    return [{ source: '/local-api/:path*', destination: `http://127.0.0.1:${localApiPort}/:path*` }];
  },
  async headers() {
    return [{ source: '/:path*', headers: [
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'Referrer-Policy', value: 'same-origin' },
      { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
    ] }];
  },
};
export default nextConfig;
