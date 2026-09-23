// Next.js 16 proxy (Node.js runtime): coarse, role-aware redirects before a page renders.
// Auth.js decodes the session here — which also runs the jwt callback, so the periodic user
// refresh (and its cookie update) happens on navigation. The rules live in lib/auth/routing.ts;
// layouts enforce the same rules again with requireUser().
import type { NextAuthRequest } from 'next-auth';
import { NextResponse, type NextFetchEvent, type NextRequest } from 'next/server';
import { auth } from '@/auth';
import { resolveRedirect, type RoutingUser } from '@/lib/auth/routing';

function routingUser(request: NextAuthRequest): RoutingUser | null {
  const user = request.auth?.user;
  if (!user?.id || !user.role || !user.status) return null;
  return { role: user.role, status: user.status };
}

const withAuth = auth((request: NextAuthRequest, _event: NextFetchEvent) => {
  const target = resolveRedirect(
    { pathname: request.nextUrl.pathname, search: request.nextUrl.search },
    routingUser(request),
  );
  if (!target) return NextResponse.next();
  return NextResponse.redirect(new URL(target, request.nextUrl.origin));
});

export function proxy(request: NextRequest, event: NextFetchEvent) {
  return withAuth(request, event);
}

export const config = {
  // Everything except Next internals, Auth.js endpoints and static files in public/.
  matcher: [
    '/((?!api/auth|_next/static|_next/image|favicon\\.ico|robots\\.txt|sitemap\\.xml|.*\\.(?:svg|png|jpg|jpeg|gif|webp|avif|ico|txt|xml|webmanifest|woff2?|ttf|otf|map)$).*)',
  ],
};
