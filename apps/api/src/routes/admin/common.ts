import type { FastifyReply, FastifyRequest } from 'fastify';
import { canAccessAdmin, canAccessAdminSection, type AdminSection } from '@loons/shared';
import { errorResponses, errors } from '../../lib/errors.ts';
import { actorOf, requireAuth } from '../../plugins/auth.ts';
import { requireSuperAdmin } from '../../services/admin/authz.ts';
import type { AdminContext } from '../../services/admin/write.ts';

// Shared bits of the /admin/* routes (decision E20). Authentication, admin access and the section
// check run as onRequest hooks registered by ./index.ts — before body validation, so a caller
// without access gets 401 / 403 whatever they send. Section routes only check the row they touch
// (services/admin/authz.ts).

/** OpenAPI tag of every admin route. */
export const ADMIN_TAG = 'admin';

/** `schema.security` of every admin route (Bearer tokens, like the rest of the API). */
export const adminSecurity = [{ bearerAuth: [] }];

/**
 * Error responses every admin route may give: 400 validation, 401, 403, 404, 409 (stale, duplicate,
 * in use, order changed, guard), 429 (per-user write limit).
 */
export const adminErrorResponses = errorResponses(400, 401, 403, 404, 409, 429);

/**
 * `schema` fields shared by admin routes:
 * `schema: { ...adminSchema('Create a category'), body, response: { 201: …, ...adminErrorResponses } }`.
 */
export function adminSchema(summary: string, description?: string) {
  return {
    tags: [ADMIN_TAG],
    summary,
    ...(description ? { description } : {}),
    security: adminSecurity,
  };
}

/** Who is writing and the request id (stored on audit rows). */
export function adminContext(req: FastifyRequest): AdminContext {
  return { actor: actorOf(req), requestId: req.id };
}

const authenticate = requireAuth();

/** onRequest: a signed-in super admin or team lead (401 / 403 otherwise). */
export async function requireAdminAccess(req: FastifyRequest, reply: FastifyReply): Promise<void> {
  await authenticate(req, reply);
  if (!canAccessAdmin(actorOf(req))) throw errors.forbidden('Admin access only.');
}

/** onRequest: the caller may open this section (team leads: teams and macros only, E7). */
export function requireAdminSection(section: AdminSection) {
  return async function requireAdminSectionHandler(req: FastifyRequest): Promise<void> {
    if (!canAccessAdminSection(actorOf(req), section)) {
      throw errors.forbidden('You do not have access to this part of the admin.');
    }
  };
}

/**
 * Route onRequest hook for routes of a team-lead section that only super admins may use (e.g.
 * creating or archiving a team): 403 before the body is read, like the section check, so a team
 * lead never learns the body's validation rules. The service checks again.
 */
export async function superAdminOnly(req: FastifyRequest): Promise<void> {
  requireSuperAdmin(actorOf(req));
}

/** Mutating requests (the per-user admin write limit counts these). */
export function isWriteRequest(req: FastifyRequest): boolean {
  return req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS';
}
