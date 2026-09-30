import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { generalSettingsDtoSchema, updateGeneralSettingsSchema } from '@loons/shared';
import { adminContext, adminErrorResponses, adminSchema } from './common.ts';

// Admin — General settings: /admin/settings (E11). Registered by ./index.ts under /admin/settings
// after the auth + section hooks (super admins only). Contract:
// packages/shared/src/schemas/admin/settings.ts.

export const settingsAdminRoutes: FastifyPluginAsyncZod = async (app) => {
  const settings = () => app.services.admin.settings;

  app.get(
    '/',
    {
      schema: {
        ...adminSchema(
          'General settings',
          'Business time zone, SOC phone, auto-close days, P4 digest time and the security category. `updatedAt` is the newest of the five settings (null when none is stored).',
        ),
        response: { 200: generalSettingsDtoSchema, ...adminErrorResponses },
      },
    },
    async (req) => settings().get(adminContext(req)),
  );

  app.patch(
    '/',
    {
      schema: {
        ...adminSchema(
          'Change general settings',
          'Changes the values sent, with the `updatedAt` the form started from (409 `stale`). 400 `validation.timezone` (not an IANA zone), `validation.phone` (not an international number; stored in E.164), `validation.securityCategory` (not an active category with an active sub-type). Announces `config:updated` scope `settings`, plus `ticket-form` (SOC phone, security category) and `calendar` (time zone). A time-zone or digest-time change reschedules the worker within a minute.',
        ),
        body: updateGeneralSettingsSchema,
        response: { 200: generalSettingsDtoSchema, ...adminErrorResponses },
      },
    },
    async (req) => settings().update(adminContext(req), req.body),
  );
};
