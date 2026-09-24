import { normalizeIP } from '@fastify/rate-limit';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  authUserSchema,
  emailLinkOwnerSchema,
  emailLinkSchema,
  forgotPasswordSchema,
  loginSchema,
  oauthResolveSchema,
  registerSchema,
  resendVerificationSchema,
  resetPasswordSchema,
  verifyEmailSchema,
} from '@loons/shared';
import { errorResponses, errors } from '../../lib/errors.ts';
import { CLIENT_IP_HEADER, endUserIp, internalKeyGuard } from '../../lib/internal-auth.ts';
import { HOUR, MINUTE, hashKeyPart, limitGuard, type LimitRule } from '../../lib/rate-limit.ts';

const userResponse = z.object({ user: authUserSchema });
const acceptedResponse = z.object({ ok: z.literal(true) });
const security = [{ internalApiKey: [] }];

/**
 * Caps shared by everyone, whatever the IP: they still hold when the web server can't forward the
 * end user's IP (then only the per-email / per-user rules and these apply). Generous, so normal
 * use never meets them; they bound what one caller rotating addresses or emails can do.
 */
export const GLOBAL_AUTH_LIMITS = {
  register: { max: 100, windowMs: HOUR },
  link: { max: 600, windowMs: 15 * MINUTE },
  verify: { max: 300, windowMs: 15 * MINUTE },
  resend: { max: 100, windowMs: 15 * MINUTE },
} as const;

/**
 * Server-to-server sign-in support for the web app (`/internal/auth/*`).
 * Every route requires `x-internal-api-key`. The global per-IP limit is off here (all calls
 * come from the web server); instead each route is limited per end-user IP taken from
 * `x-client-ip` (+ email where relevant), trusted only after the key is verified. Without that
 * header the per-IP rules are skipped (never keyed on the web server's own address), and the
 * per-email, per-user and global rules still apply.
 */
export const internalAuthRoutes: FastifyPluginAsyncZod = async (app) => {
  // Wrong / missing keys: 20 per 15 min per source address, then 429.
  const keyFailures = app.createRateLimit({
    max: 20,
    timeWindow: 15 * MINUTE,
    skipOnError: true,
    keyGenerator: (req) => `internal-key-fail:${normalizeIP(req.ip)}`,
  });
  app.addHook(
    'onRequest',
    internalKeyGuard(app.config.internalApiKey, async (req) => {
      const result = await keyFailures(req);
      if (!result.isAllowed && result.isExceeded) throw errors.rateLimited(Math.max(1, result.ttlInSeconds));
    }),
  );
  let warnedMissingClientIp = false;
  app.addHook('onRequest', async (req) => {
    if (!req.headers[CLIENT_IP_HEADER] && !warnedMissingClientIp) {
      warnedMissingClientIp = true;
      req.log.warn('internal call without x-client-ip; per-IP rate limits are skipped (per-email, per-user and global limits still apply)');
    }
  });

  type Key = LimitRule['key'];
  // null (rule skipped) when the web server did not forward the end user's IP.
  const ip: Key = (req) => {
    const address = endUserIp(req);
    return address === null ? null : `ip:${address}`;
  };
  const bodyEmail = (req: Parameters<Key>[0]) => {
    // Already normalised (trimmed, lower-cased) by the body schema.
    const email = (req.body as { email?: unknown } | undefined)?.email;
    return typeof email === 'string' ? email : null;
  };
  const ipAndEmail: Key = (req) => {
    const email = bodyEmail(req);
    const address = endUserIp(req);
    return email === null || address === null ? null : `ip:${address}:email:${hashKeyPart(email)}`;
  };
  // Independent of the IP (which the caller may be able to vary): caps guessing per account.
  const emailOnly: Key = (req) => {
    const email = bodyEmail(req);
    return email === null ? null : `email:${hashKeyPart(email)}`;
  };
  const bodyUserId: Key = (req) => {
    const userId = (req.body as { userId?: unknown } | undefined)?.userId;
    return typeof userId === 'string' ? `user:${userId}` : null;
  };
  const everyone: Key = () => 'all';
  const globalRule = (name: keyof typeof GLOBAL_AUTH_LIMITS): LimitRule => ({
    name: `${name}:global`,
    ...GLOBAL_AUTH_LIMITS[name],
    key: everyone,
  });

  // Fail CLOSED: if the limiter store (Redis) is unreachable these routes answer 503
  // SERVICE_UNAVAILABLE rather than accept unthrottled password / sign-up / reset attempts.
  const failClosed = { onStoreError: 'deny' } as const;
  const loginLimit = limitGuard(
    app,
    [
      { name: 'login:ip-email', max: 10, windowMs: 15 * MINUTE, key: ipAndEmail },
      { name: 'login:ip', max: 50, windowMs: 15 * MINUTE, key: ip },
      { name: 'login:email', max: 30, windowMs: HOUR, key: emailOnly },
    ],
    failClosed,
  );
  const oauthLimit = limitGuard(app, [{ name: 'oauth:ip', max: 60, windowMs: 15 * MINUTE, key: ip }], failClosed);
  const registerLimit = limitGuard(
    app,
    [{ name: 'register:ip', max: 5, windowMs: HOUR, key: ip }, globalRule('register')],
    failClosed,
  );
  const forgotLimit = limitGuard(
    app,
    [
      { name: 'forgot:ip-email', max: 5, windowMs: 15 * MINUTE, key: ipAndEmail },
      { name: 'forgot:email', max: 5, windowMs: HOUR, key: emailOnly },
    ],
    failClosed,
  );
  const resetLimit = limitGuard(app, [{ name: 'reset:ip', max: 10, windowMs: 15 * MINUTE, key: ip }], failClosed);
  const linkLimit = limitGuard(
    app,
    [{ name: 'link:ip', max: 30, windowMs: 15 * MINUTE, key: ip }, globalRule('link')],
    failClosed,
  );
  const verifyLimit = limitGuard(
    app,
    [{ name: 'verify:ip', max: 10, windowMs: 15 * MINUTE, key: ip }, globalRule('verify')],
    failClosed,
  );
  const resendLimit = limitGuard(
    app,
    [
      { name: 'resend:user', max: 3, windowMs: 15 * MINUTE, key: bodyUserId },
      { name: 'resend:ip', max: 10, windowMs: 15 * MINUTE, key: ip },
      globalRule('resend'),
    ],
    failClosed,
  );

  const noGlobalLimit = { rateLimit: false } as const;

  app.post(
    '/login',
    {
      config: noGlobalLimit,
      preHandler: loginLimit,
      schema: {
        tags: ['internal-auth'],
        summary: 'Verify email + password (client or staff sign-in page)',
        security,
        body: loginSchema,
        response: { 200: userResponse, ...errorResponses(400, 401, 403, 429, 503) },
      },
    },
    async (req) => ({ user: await app.services.auth.login(req.body) }),
  );

  app.post(
    '/oauth',
    {
      config: noGlobalLimit,
      preHandler: oauthLimit,
      schema: {
        tags: ['internal-auth'],
        summary: 'Resolve a Google (client) or Microsoft Entra ID (staff) sign-in to a user',
        security,
        body: oauthResolveSchema,
        response: { 200: userResponse, ...errorResponses(400, 401, 403, 429, 503) },
      },
    },
    async (req) => ({ user: await app.services.auth.resolveOAuth(req.body) }),
  );

  app.get(
    '/users/:id',
    {
      config: noGlobalLimit,
      schema: {
        tags: ['internal-auth'],
        summary: 'Current state of a user (session refresh)',
        security,
        params: z.object({ id: z.uuid() }),
        response: { 200: userResponse, ...errorResponses(400, 401, 403, 404) },
      },
    },
    async (req) => ({ user: await app.services.auth.getUser(req.params.id) }),
  );

  app.post(
    '/register',
    {
      config: noGlobalLimit,
      preHandler: registerLimit,
      schema: {
        tags: ['internal-auth'],
        summary:
          'Client self-signup (joins the organisation matching the email domain, else pending approval); emails a verification link',
        security,
        body: registerSchema,
        response: { 201: userResponse, ...errorResponses(400, 401, 403, 409, 429, 503) },
      },
    },
    async (req, reply) => reply.code(201).send({ user: await app.services.auth.register(req.body) }),
  );

  app.post(
    '/password/forgot',
    {
      config: noGlobalLimit,
      preHandler: forgotLimit,
      schema: {
        tags: ['internal-auth'],
        summary: 'Email a password reset link (always 202, whether or not the account exists)',
        security,
        body: forgotPasswordSchema,
        response: { 202: acceptedResponse, ...errorResponses(400, 401, 403, 429, 503) },
      },
    },
    async (req, reply) => {
      const input = req.body;
      // Finished after the response so timing never reveals whether the account exists.
      app.background.run('password-reset-request', () => app.services.passwordReset.requestReset(input));
      return reply.code(202).send({ ok: true });
    },
  );

  app.post(
    '/password/reset',
    {
      config: noGlobalLimit,
      preHandler: resetLimit,
      schema: {
        tags: ['internal-auth'],
        summary: 'Set a new password with a reset token (single use, 30 min)',
        security,
        body: resetPasswordSchema,
        response: { 204: z.undefined(), ...errorResponses(400, 401, 403, 429, 503) },
      },
    },
    async (req, reply) => {
      await app.services.passwordReset.resetPassword(req.body);
      return reply.code(204).send();
    },
  );

  app.post(
    '/email/link',
    {
      config: noGlobalLimit,
      preHandler: linkLimit,
      schema: {
        tags: ['internal-auth'],
        summary: 'Which account an emailed confirmation link belongs to (the link is not used up)',
        security,
        body: emailLinkSchema,
        response: { 200: emailLinkOwnerSchema, ...errorResponses(400, 401, 403, 429, 503) },
      },
    },
    async (req) => app.services.emailVerification.describeLink(req.body.token),
  );

  app.post(
    '/email/verify',
    {
      config: noGlobalLimit,
      preHandler: verifyLimit,
      schema: {
        tags: ['internal-auth'],
        summary:
          'Confirm a client’s email address with the emailed token (single use, 24 h), inside that client’s own session',
        security,
        body: verifyEmailSchema,
        response: { 200: userResponse, ...errorResponses(400, 401, 403, 429, 503) },
      },
    },
    async (req) => ({ user: await app.services.emailVerification.verify(req.body) }),
  );

  app.post(
    '/email/resend',
    {
      config: noGlobalLimit,
      preHandler: resendLimit,
      schema: {
        tags: ['internal-auth'],
        summary: 'Email a new verification link to an unverified client (always 202)',
        security,
        body: resendVerificationSchema,
        response: { 202: acceptedResponse, ...errorResponses(400, 401, 403, 429, 503) },
      },
    },
    async (req, reply) => {
      const input = req.body;
      // Finished after the response, like the password reset request.
      app.background.run('email-verification-resend', () => app.services.emailVerification.requestResend(input));
      return reply.code(202).send({ ok: true });
    },
  );
};
