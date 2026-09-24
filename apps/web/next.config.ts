import path from 'node:path';
import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';
import { securityHeaders } from './security-headers.ts';

const withNextIntl = createNextIntlPlugin('./i18n/request.ts');

const nextConfig: NextConfig = {
  output: 'standalone',
  outputFileTracingRoot: path.join(import.meta.dirname, '../..'),
  transpilePackages: ['@loons/shared', '@loons/ui'],
  typedRoutes: true,
  poweredByHeader: false,
  reactStrictMode: true,
  // CSP, anti-framing, nosniff, referrer and permissions policies (+ HSTS in production) on every
  // route. What the CSP allows, and why, is documented in security-headers.ts.
  async headers() {
    return [
      {
        source: '/:path*',
        headers: securityHeaders({
          nodeEnv: process.env.NODE_ENV,
          apiUrl: process.env.NEXT_PUBLIC_API_URL,
        }),
      },
    ];
  },
};

export default withNextIntl(nextConfig);
