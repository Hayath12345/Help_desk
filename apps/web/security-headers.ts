// Security headers for every web route (next.config.ts `headers()`): the Next.js tier's
// equivalent of the Helmet headers the Fastify API sends (spec §12).
//
// Content-Security-Policy — what is allowed, and why:
// - default-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none' (no framing,
//   no plugins, no <base> hijacking).
// - script-src 'self' 'unsafe-inline': the App Router bootstraps every page with inline <script>
//   tags (the streamed RSC payload). A header set here is static, so it cannot carry per-request
//   nonces; a nonce-based policy would have to be generated in proxy.ts and force every page to
//   render dynamically. Development adds 'unsafe-eval' (React's dev tooling needs it).
// - style-src 'self' 'unsafe-inline': React style attributes (Radix positioning, motion) and the
//   @font-face rules next/font inlines.
// - img-src 'self' data: blob:; font-src 'self' (next/font self-hosts every font).
// - connect-src 'self' + the browser API origin (NEXT_PUBLIC_API_URL, REST and the Socket.IO
//   WebSocket). Development also allows ws:/wss: for hot reloading.
// - form-action 'self' + the Google and Microsoft sign-in origins: the OAuth buttons are forms
//   whose server action answers with a redirect to the provider, and browsers apply form-action
//   to that redirect (it matters when a button is used before JavaScript has loaded).

/** Where the OAuth sign-in forms may redirect (Google for clients, Entra ID for staff). */
export const OAUTH_FORM_ACTION_ORIGINS = [
  'https://accounts.google.com',
  'https://login.microsoftonline.com',
] as const;

export interface SecurityHeaderOptions {
  /** process.env.NODE_ENV */
  nodeEnv: string | undefined;
  /** process.env.NEXT_PUBLIC_API_URL: the API origin browsers call (REST + Socket.IO). */
  apiUrl?: string | undefined;
}

export interface HeaderEntry {
  key: string;
  value: string;
}

/** The API's HTTP origin plus its WebSocket twin, e.g. https://api.x + wss://api.x. */
function apiOrigins(apiUrl: string | undefined): string[] {
  if (!apiUrl?.trim()) return [];
  let url: URL;
  try {
    url = new URL(apiUrl.trim());
  } catch {
    return [];
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return [];
  const socket = `${url.protocol === 'https:' ? 'wss:' : 'ws:'}//${url.host}`;
  return [url.origin, socket];
}

export function contentSecurityPolicy({ nodeEnv, apiUrl }: SecurityHeaderOptions): string {
  const dev = nodeEnv === 'development';
  const directives: Record<string, string[]> = {
    'default-src': ["'self'"],
    'script-src': ["'self'", "'unsafe-inline'", ...(dev ? ["'unsafe-eval'"] : [])],
    'style-src': ["'self'", "'unsafe-inline'"],
    'img-src': ["'self'", 'data:', 'blob:'],
    'font-src': ["'self'"],
    'connect-src': ["'self'", ...apiOrigins(apiUrl), ...(dev ? ['ws:', 'wss:'] : [])],
    'object-src': ["'none'"],
    'base-uri': ["'self'"],
    'form-action': ["'self'", ...OAUTH_FORM_ACTION_ORIGINS],
    'frame-ancestors': ["'none'"],
  };
  return Object.entries(directives)
    .map(([name, sources]) => `${name} ${[...new Set(sources)].join(' ')}`)
    .join('; ');
}

/** Headers sent with every response of the web app. HSTS only in production (HTTPS). */
export function securityHeaders(options: SecurityHeaderOptions): HeaderEntry[] {
  const headers: HeaderEntry[] = [
    { key: 'Content-Security-Policy', value: contentSecurityPolicy(options) },
    { key: 'X-Frame-Options', value: 'DENY' },
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
    {
      key: 'Permissions-Policy',
      value: 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    },
    { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
  ];
  if (options.nodeEnv === 'production') {
    headers.push({
      key: 'Strict-Transport-Security',
      value: 'max-age=31536000; includeSubDomains',
    });
  }
  return headers;
}
