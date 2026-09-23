import { normalizeIP } from '@fastify/rate-limit';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  authUserSchema,
  forgotPasswordSchema,
  loginSchema,
  oauthResolveSchema,
  registerSchema,
  resetPasswordSchema,
} from '@loons/shared';
import { errorResponses, errors } from '../../lib/errors.ts';
import { CLIENT_IP_HEADER, clientIp, internalKeyGuard } from '../../lib/internal-auth.ts';
import { HOUR, MINUTE, hashKeyPart, limitGuard } from '../../lib/rate-limit.ts';

const userResponse = z.object({ user: authUserSchema });
const security = [{ internalApiKey: [] }];

/**
 * Server-to-server sign-in support for the web app (`/internal/auth/*`).
 * Every route requires `x-internal-api-key`. The global per-IP limit is off here (all calls
 * come from the web server); instead each route is limited per end-user IP taken from
 * `x-client-ip` (+ email where relevant), trusted only after the key is verified.
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
      req.log.warn('internal call without x-client-ip; rate limits fall back to the caller address');
    }
  });

  const ip = (req: Parameters<typeof clientIp>[0]) => `ip:${clientIp(req)}`;
  const ipAndEmail = (req: Parameters<typeof clientIp>[0]) => {
    const email = (req.body as { email?: unknown } | undefined)?.email;
    return typeof email === 'string' ? `ip:${clientIp(req)}:email:${hashKeyPart(email)}` : null;
  };

  // Fail CLOSED: if the limiter store (Redis) is unreachable these routes answer 503
  // SERVICE_UNAVAILABLE rather than accept unthrottled password / sign-up / reset attempts.
  const failClosed = { onStoreError: 'deny' } as const;
  const loginLimit = limitGuard(
    app,
    [
      { name: 'login:ip-email', max: 10, windowMs: 15 * MINUTE, key: ipAndEmail },
      { name: 'login:ip', max: 50, windowMs: 15 * MINUTE, key: ip },
    ],
    failClosed,
  );
  const oauthLimit = limitGuard(app, [{ name: 'oauth:ip', max: 60, windowMs: 15 * MINUTE, key: ip }], failClosed);
  const registerLimit = limitGuard(app, [{ name: 'register:ip', max: 5, windowMs: HOUR, key: ip }], failClosed);
  const forgotLimit = limitGuard(
    app,
    [{ name: 'forgot:ip-email', max: 5, windowMs: 15 * MINUTE, key: ipAndEmail }],
    failClosed,
  );
  const resetLimit = limitGuard(app, [{ name: 'reset:ip', max: 10, windowMs: 15 * MINUTE, key: ip }], failClosed);

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
        summary: 'Client self-signup (joins the organisation matching the email domain, else pending approval)',
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
        response: { 202: z.object({ ok: z.literal(true) }), ...errorResponses(400, 401, 403, 429, 503) },
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
};
