// GET /api/token → { token, expiresAt } — a short-lived API access token for the browser.
// Pending-approval users and clients with an unverified email get one too: the API only lets
// them call GET/PATCH /me.
import { NextResponse } from 'next/server';
import { mintApiToken } from '@/lib/api/token';
import { getCurrentUser } from '@/lib/session';

const NO_STORE_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0',
  Pragma: 'no-cache',
  'X-Content-Type-Options': 'nosniff',
} as const;

export async function GET() {
  const user = await getCurrentUser();
  if (!user || (user.status !== 'ACTIVE' && user.status !== 'PENDING_APPROVAL')) {
    return NextResponse.json(
      { error: { code: 'UNAUTHENTICATED', message: 'Not signed in' } },
      { status: 401, headers: NO_STORE_HEADERS },
    );
  }
  const { token, expiresAt } = await mintApiToken(user);
  return NextResponse.json({ token, expiresAt }, { headers: NO_STORE_HEADERS });
}
