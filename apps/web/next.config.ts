import path from 'node:path';
import type { NextConfig } from 'next';
import createNextIntlPlugin from 'next-intl/plugin';
import { withUploadConnectSrc } from './lib/uploads/csp.ts';
import { securityHeaders } from './security-headers.ts';

const withNextIntl = createNextIntlPlugin('./i18n/request.ts');

const nextConfig: NextConfig = {
  output: 'standalone',
  outputFileTracingRoot: path.join(import.meta.dirname, '../..'),
  transpilePackages: ['@loons/shared', '@loons/ui'],
  typedRoutes: true,
  poweredByHeader: false,
  reactStrictMode: true,
  // Dev server only: other devices on the LAN reach it by IP, and Next blocks their dev assets / HMR
  // unless the host is listed. Comma-separated hostnames or IPs (e.g. 192.168.1.22).
  allowedDevOrigins: (process.env.DEV_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean),
  // CSP, anti-framing, nosniff, referrer and permissions policies (+ HSTS in production) on every
  // route. What the CSP allows, and why, is documented in security-headers.ts. connect-src also
  // allows the attachment storage origin (NEXT_PUBLIC_UPLOAD_ORIGIN): browsers POST files straight
  // to the pre-signed storage URL (lib/uploads).
  async headers() {
    return [
      {
        source: '/:path*',
        headers: withUploadConnectSrc(
          securityHeaders({
            nodeEnv: process.env.NODE_ENV,
            apiUrl: process.env.NEXT_PUBLIC_API_URL,
          }),
          process.env.NEXT_PUBLIC_UPLOAD_ORIGIN,
        ),
      },
    ];
  },
};

export default withNextIntl(nextConfig);
