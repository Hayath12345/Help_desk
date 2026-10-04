import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { ADMIN_SECTIONS, type AdminSection } from '@loons/shared';
import { MINUTE, limitGuard } from '../../lib/rate-limit.ts';
import { auditLogAdminRoutes } from './audit-log.ts';
import { businessHoursAdminRoutes } from './business-hours.ts';
import { categoriesAdminRoutes } from './categories.ts';
import { clientsAdminRoutes } from './clients.ts';
import { isWriteRequest, requireAdminAccess, requireAdminSection } from './common.ts';
import { customFieldsAdminRoutes } from './custom-fields.ts';
import { emailTemplatesAdminRoutes } from './email-templates.ts';
import { escalationAdminRoutes } from './escalation.ts';
import { helpCenterAdminRoutes } from './help-center.ts';
import { macrosAdminRoutes } from './macros.ts';
import { settingsAdminRoutes } from './settings.ts';
import { slaAdminRoutes } from './sla.ts';
import { staffDirectoryRoutes } from './staff-directory.ts';
import { skillsAdminRoutes } from './skills.ts';
import { staffAdminRoutes } from './staff.ts';
import { teamsAdminRoutes } from './teams.ts';

// The admin API (decision E20), registered under /admin. Bearer tokens like the rest of the API:
// the API never reads cookies, so cross-site requests can't act as the admin (CSRF-safe by design,
// spec §12). For every /admin/* request, in order (onRequest, before the body is read):
//   1. requireAuth, then super admin or team lead            → 401 / 403
//   2. per-user write limit on POST / PUT / PATCH / DELETE    → 429 (fails open when Redis is down)
//   3. the section check (team leads: teams and macros, E7)   → 403
// Each section's routes are one plugin (./<section>.ts) mounted at /admin/<section>.

/** Per-user admin write limit (E20). */
export const ADMIN_WRITE_RATE_LIMIT = { max: 120, windowMs: MINUTE } as const;

export interface AdminRoutesOptions {
  /** Overrides ADMIN_WRITE_RATE_LIMIT (tests). */
  writeLimit?: { max: number; windowMs: number };
}

/** The routes plugin of each section. */
export const ADMIN_SECTION_ROUTES: Record<AdminSection, FastifyPluginAsyncZod> = {
  categories: categoriesAdminRoutes,
  'custom-fields': customFieldsAdminRoutes,
  macros: macrosAdminRoutes,
  sla: slaAdminRoutes,
  'business-hours': businessHoursAdminRoutes,
  escalation: escalationAdminRoutes,
  teams: teamsAdminRoutes,
  staff: staffAdminRoutes,
  skills: skillsAdminRoutes,
  clients: clientsAdminRoutes,
  'email-templates': emailTemplatesAdminRoutes,
  'help-center': helpCenterAdminRoutes,
  settings: settingsAdminRoutes,
  'audit-log': auditLogAdminRoutes,
};

export const adminRoutes: FastifyPluginAsyncZod<AdminRoutesOptions> = async (app, options) => {
  app.addHook('onRequest', requireAdminAccess);
  app.addHook(
    'onRequest',
    limitGuard(
      app,
      [
        {
          name: 'admin:write:user',
          ...(options.writeLimit ?? ADMIN_WRITE_RATE_LIMIT),
          key: (req) => (req.actor && isWriteRequest(req) ? `user:${req.actor.id}` : null),
        },
      ],
      // Like ticket writes: a Redis outage must not stop admin work (the global limit also fails open).
      { onStoreError: 'allow' },
    ),
  );

  await app.register(staffDirectoryRoutes);

  for (const section of ADMIN_SECTIONS) {
    const routes = ADMIN_SECTION_ROUTES[section];
    await app.register(
      async (scoped) => {
        scoped.addHook('onRequest', requireAdminSection(section));
        await scoped.register(routes);
      },
      { prefix: `/${section}` },
    );
  }
};
