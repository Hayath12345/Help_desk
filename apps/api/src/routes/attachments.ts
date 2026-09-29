import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import {
  attachmentDownloadSchema,
  completeAttachmentResponseSchema,
  idParamSchema,
  presignAttachmentResponseSchema,
  presignAttachmentSchema,
} from '@loons/shared';
import { errorResponses } from '../lib/errors.ts';
import { MINUTE, limitGuard } from '../lib/rate-limit.ts';
import { actorOf, requireAuth } from '../plugins/auth.ts';

/** Per-user cap on upload reservations. */
export const PRESIGN_LIMIT = { max: 60, windowMs: 10 * MINUTE } as const;

/**
 * Attachments: reserve an upload (pre-signed POST straight to S3 / MinIO), confirm it, and get a
 * short-lived download link. Files are linked to tickets when a ticket or message is posted.
 */
export const attachmentRoutes: FastifyPluginAsyncZod = async (app) => {
  const auth = requireAuth();
  const security = [{ bearerAuth: [] }];
  const presignLimit = limitGuard(
    app,
    [
      {
        name: 'attachments:presign:user',
        ...PRESIGN_LIMIT,
        key: (req) => (req.actor ? `user:${req.actor.id}` : null),
      },
    ],
    { onStoreError: 'allow' },
  );

  app.post(
    '/attachments/presign',
    {
      preHandler: [auth, presignLimit],
      schema: {
        tags: ['attachments'],
        summary: 'Reserve an upload: returns a pre-signed POST (15 min) for the browser',
        description:
          'The browser POSTs multipart form data (the returned fields, then the file last) to `upload.url`, then calls `/attachments/{id}/complete`. Allowed: images, video, PDF, text/log and zip up to 25 MB.',
        security,
        body: presignAttachmentSchema,
        response: {
          201: presignAttachmentResponseSchema,
          ...errorResponses(400, 401, 403, 404, 409, 429),
        },
      },
    },
    async (req, reply) => {
      const result = await app.services.attachments.presign(actorOf(req), req.body);
      return reply.code(201).send(result);
    },
  );

  app.post(
    '/attachments/:id/complete',
    {
      preHandler: auth,
      schema: {
        tags: ['attachments'],
        summary: 'Confirm an upload: checks the stored object and runs the virus-scan hook',
        security,
        params: idParamSchema,
        response: {
          200: completeAttachmentResponseSchema,
          ...errorResponses(400, 401, 403, 404, 409, 429, 503),
        },
      },
    },
    async (req) => ({
      attachment: await app.services.attachments.complete(actorOf(req), req.params.id),
    }),
  );

  app.get(
    '/attachments/:id/download',
    {
      preHandler: auth,
      schema: {
        tags: ['attachments'],
        summary: 'A 5-minute signed download link (viewers of the ticket; notes: staff only)',
        security,
        params: idParamSchema,
        response: { 200: attachmentDownloadSchema, ...errorResponses(401, 403, 404, 409, 429) },
      },
    },
    async (req) => app.services.attachments.download(actorOf(req), req.params.id),
  );
};
