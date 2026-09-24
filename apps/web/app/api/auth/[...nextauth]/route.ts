// Auth.js endpoints (/api/auth/*). Errors Auth.js raises itself (consent cancelled, provider
// error, misconfiguration…) all redirect to `pages.error` — the client /login. For the staff
// (Microsoft Entra ID) flow they are re-pointed at /staff/login, keeping the `?error=`.
import type { NextRequest } from 'next/server';
import { handlers } from '@/auth';
import { staffAuthErrorLocation } from '@/lib/auth/routing';

type AuthHandler = (request: NextRequest) => Promise<Response>;

async function withStaffErrorPage(handler: AuthHandler, request: NextRequest): Promise<Response> {
  const response = await handler(request);
  const location = staffAuthErrorLocation(
    request.nextUrl.pathname,
    response.headers.get('location'),
  );
  if (!location) return response;
  // Auth.js responses can have immutable headers: copy them (Set-Cookie included) onto a new one.
  const headers = new Headers(response.headers);
  headers.set('location', location);
  return new Response(null, { status: response.status, headers });
}

export function GET(request: NextRequest): Promise<Response> {
  return withStaffErrorPage(handlers.GET, request);
}

export function POST(request: NextRequest): Promise<Response> {
  return withStaffErrorPage(handlers.POST, request);
}
