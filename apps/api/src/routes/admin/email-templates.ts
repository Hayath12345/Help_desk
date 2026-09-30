import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import {
  emailTemplateKeyParamSchema,
  emailTemplateListSchema,
  emailTemplatePreviewDtoSchema,
  emailTemplateResponseSchema,
  previewEmailTemplateSchema,
  resetEmailTemplateSchema,
  updateEmailTemplateSchema,
} from '@loons/shared';
import { adminContext, adminErrorResponses, adminSchema } from './common.ts';

// Admin — Email templates: /admin/email-templates/* (spec §10.9; decision E14). Super admins only
// (the section check in ./index.ts). Contract: packages/shared/src/schemas/admin/email-templates.ts.
// The twelve keys are fixed in code: list, read, save, reset to the built-in text and preview.

export const emailTemplatesAdminRoutes: FastifyPluginAsyncZod = async (app) => {
  const service = () => app.services.admin.emailTemplates;

  app.get(
    '/',
    {
      schema: {
        ...adminSchema(
          'List the email templates',
          'The twelve fixed templates in code order, each with the text the senders use (the stored row, or the built-in text when there is none), its variables and block variables.',
        ),
        response: { 200: emailTemplateListSchema, ...adminErrorResponses },
      },
    },
    async (req) => ({ items: await service().list(adminContext(req)) }),
  );

  app.get(
    '/:key',
    {
      schema: {
        ...adminSchema('Read one email template'),
        params: emailTemplateKeyParamSchema,
        response: { 200: emailTemplateResponseSchema, ...adminErrorResponses },
      },
    },
    async (req) => ({ item: await service().get(adminContext(req), req.params.key) }),
  );

  app.put(
    '/:key',
    {
      schema: {
        ...adminSchema(
          'Save an email template',
          'Saves the English and Arabic subject and body (Arabic may stay empty: the English text is sent). `expectedUpdatedAt` is the `updatedAt` the edit started from, or null when no row was stored. Placeholders the template does not provide are refused (400 `unknown_variable`), and block variables are allowed in the body only (400 `block_in_subject`).',
        ),
        params: emailTemplateKeyParamSchema,
        body: updateEmailTemplateSchema,
        response: { 200: emailTemplateResponseSchema, ...adminErrorResponses },
      },
    },
    async (req) => ({
      item: await service().update(adminContext(req), req.params.key, req.body),
    }),
  );

  app.post(
    '/:key/reset',
    {
      schema: {
        ...adminSchema('Reset an email template to its built-in text'),
        params: emailTemplateKeyParamSchema,
        body: resetEmailTemplateSchema,
        response: { 200: emailTemplateResponseSchema, ...adminErrorResponses },
      },
    },
    async (req) => ({
      item: await service().reset(adminContext(req), req.params.key, req.body),
    }),
  );

  app.post(
    '/:key/preview',
    {
      schema: {
        ...adminSchema(
          'Preview unsaved template text',
          'Renders the given subject and body in one language exactly like a sent email (layout, button, greeting rules), with sample values. Nothing is saved.',
        ),
        params: emailTemplateKeyParamSchema,
        body: previewEmailTemplateSchema,
        response: { 200: emailTemplatePreviewDtoSchema, ...adminErrorResponses },
      },
    },
    async (req) => service().preview(adminContext(req), req.params.key, req.body),
  );
};
