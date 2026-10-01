// Phase 5 — Customers (decisions F8, F9). Staff only (clients get 403).
//
// GET /customers?search=&cursor=&limit=  → CustomerList: one row per active client requester (the
//     requester search staff already use to raise tickets), sorted by name, keyset-paged; open and
//     total ticket counts count only the tickets the caller can see.
// GET /customers/orgs/:id                → { org: CustomerOrg } (the Inbox company view's title)
// A row opens the Inbox company view: GET /tickets?orgId=<org.id> (all statuses).

import { z } from 'zod';
import { CONTRACT_TYPES } from '../enums.ts';
import { cleanText } from './tickets.ts';

export const CUSTOMER_LIMITS = { pageMax: 100, pageDefault: 50, searchMax: 100 } as const;

export const customersQuerySchema = z.object({
  /** Requester name or email, or the organisation's name (English or Arabic). */
  search: cleanText().max(CUSTOMER_LIMITS.searchMax).optional(),
  cursor: z.string().max(2000).optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(CUSTOMER_LIMITS.pageMax)
    .optional()
    .default(CUSTOMER_LIMITS.pageDefault),
});
export type CustomersQuery = z.infer<typeof customersQuerySchema>;

export const customerOrgSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  nameAr: z.string().nullable(),
  contractType: z.enum(CONTRACT_TYPES),
  /** Last day of the AMC ("YYYY-MM-DD"), if recorded. */
  amcExpiry: z.iso.date().nullable(),
  /** An AMC whose expiry day is before today in `business.timezone`. */
  amcExpired: z.boolean(),
  isActive: z.boolean(),
});
export type CustomerOrg = z.infer<typeof customerOrgSchema>;

export const customerRowSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  email: z.email(),
  org: customerOrgSchema,
  /** Open (NEW / OPEN / PENDING) tickets this requester raised that the caller can see. */
  open: z.number().int().nonnegative(),
  /** All tickets this requester raised that the caller can see. */
  total: z.number().int().nonnegative(),
});
export type CustomerRow = z.infer<typeof customerRowSchema>;

export const customerListSchema = z.object({
  items: z.array(customerRowSchema),
  nextCursor: z.string().nullable(),
  /** The whole result of the current search (every page): "N requesters across M companies". */
  totals: z.object({
    requesters: z.number().int().nonnegative(),
    companies: z.number().int().nonnegative(),
  }),
});
export type CustomerList = z.infer<typeof customerListSchema>;

export const customerOrgResponseSchema = z.object({ org: customerOrgSchema });
export type CustomerOrgResponse = z.infer<typeof customerOrgResponseSchema>;
