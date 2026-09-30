// Admin — Clients & sites (spec §10.7; decision E10), including pending sign-ups.
//
// GET    /admin/clients?status=&search=&cursor=&limit=          → { items, nextCursor }
// POST   /admin/clients                                         → 201 { item }
// PATCH  /admin/clients/:id                                     → { item }
// POST   /admin/clients/:id/archive | /restore                  → { item }
// POST   /admin/clients/:id/sites                               → 201 { item: SiteAdminDto }
// PATCH  /admin/clients/:id/sites/:siteId                       → { item: SiteAdminDto }
// POST   /admin/clients/:id/sites/:siteId/archive | /restore    → { item: SiteAdminDto }
// POST   /admin/clients/:id/sites/reorder                       → 204
// GET    /admin/clients/pending-signups?status=&search=&cursor=&limit= → { items, nextCursor }
// POST   /admin/clients/pending-signups/:id/approve             → { item: PendingSignupDto }
// POST   /admin/clients/pending-signups/:id/reject              → { item: PendingSignupDto }
// A rejected sign-up stays listed (status=rejected) and can still be approved: the way back.
// Scope `form-context`. Email domains are lower-case hostnames, unique across every organisation
// (archived included), never the staff domain or a public mail domain. Approving / rejecting a
// sign-up, archiving an organisation or moving a client invalidates the affected principals.

import { z } from 'zod';
import { CONTRACT_TYPES, USER_STATUSES } from '../../enums.ts';
import {
  NOTHING_TO_CHANGE,
  adminKeySchema,
  adminPagedQuerySchema,
  adminUserRefSchema,
  expectedUpdatedAtSchema,
  hasChanges,
  isoDateTime,
  isoDay,
  itemResponseSchema,
  labelArSchema,
  labelEnSchema,
  optionalText,
  pagedListSchema,
  ADMIN_LIMITS,
} from './common.ts';
import { cleanText } from '../tickets.ts';

export const CLIENT_LIMITS = { emailDomainsMax: 20, phoneMax: 40 } as const;

/**
 * Consumer mail providers: an organisation can't claim them (every sign-up from them would join
 * it). A static list of exact hostnames, regional variants included (hotmail.co.uk, outlook.sa,
 * yahoo.fr…), plus any provider name on PUBLIC_EMAIL_PROVIDER_LABELS under a public suffix (see
 * isPublicEmailDomain). The API also refuses the staff domain.
 */
export const PUBLIC_EMAIL_DOMAINS = [
  // Google
  'gmail.com',
  'googlemail.com',
  // Microsoft (Outlook, Hotmail, Live, MSN)
  'outlook.com',
  'outlook.ae',
  'outlook.at',
  'outlook.be',
  'outlook.cl',
  'outlook.co.id',
  'outlook.co.il',
  'outlook.co.nz',
  'outlook.co.th',
  'outlook.com.ar',
  'outlook.com.au',
  'outlook.com.br',
  'outlook.com.eg',
  'outlook.com.gr',
  'outlook.com.kw',
  'outlook.com.qa',
  'outlook.com.tr',
  'outlook.com.vn',
  'outlook.cz',
  'outlook.de',
  'outlook.dk',
  'outlook.es',
  'outlook.fr',
  'outlook.hu',
  'outlook.ie',
  'outlook.in',
  'outlook.it',
  'outlook.jp',
  'outlook.kr',
  'outlook.lv',
  'outlook.my',
  'outlook.ph',
  'outlook.pt',
  'outlook.sa',
  'outlook.sg',
  'outlook.sk',
  'hotmail.com',
  'hotmail.ae',
  'hotmail.at',
  'hotmail.be',
  'hotmail.ca',
  'hotmail.ch',
  'hotmail.cl',
  'hotmail.co.id',
  'hotmail.co.il',
  'hotmail.co.in',
  'hotmail.co.jp',
  'hotmail.co.kr',
  'hotmail.co.nz',
  'hotmail.co.th',
  'hotmail.co.uk',
  'hotmail.co.za',
  'hotmail.com.ar',
  'hotmail.com.au',
  'hotmail.com.br',
  'hotmail.com.mx',
  'hotmail.com.sa',
  'hotmail.com.tr',
  'hotmail.de',
  'hotmail.dk',
  'hotmail.es',
  'hotmail.fi',
  'hotmail.fr',
  'hotmail.gr',
  'hotmail.hu',
  'hotmail.ie',
  'hotmail.it',
  'hotmail.my',
  'hotmail.nl',
  'hotmail.no',
  'hotmail.ph',
  'hotmail.pt',
  'hotmail.se',
  'hotmail.sg',
  'live.com',
  'live.at',
  'live.be',
  'live.ca',
  'live.cl',
  'live.co.uk',
  'live.co.za',
  'live.com.ar',
  'live.com.au',
  'live.com.mx',
  'live.com.my',
  'live.com.pt',
  'live.com.sg',
  'live.de',
  'live.dk',
  'live.fr',
  'live.ie',
  'live.in',
  'live.it',
  'live.jp',
  'live.nl',
  'live.no',
  'live.ru',
  'live.se',
  'msn.com',
  'passport.com',
  'windowslive.com',
  // Yahoo
  'yahoo.com',
  'yahoo.at',
  'yahoo.be',
  'yahoo.ca',
  'yahoo.cl',
  'yahoo.cn',
  'yahoo.co.id',
  'yahoo.co.in',
  'yahoo.co.jp',
  'yahoo.co.kr',
  'yahoo.co.nz',
  'yahoo.co.th',
  'yahoo.co.uk',
  'yahoo.co.za',
  'yahoo.com.ar',
  'yahoo.com.au',
  'yahoo.com.br',
  'yahoo.com.hk',
  'yahoo.com.mx',
  'yahoo.com.my',
  'yahoo.com.ph',
  'yahoo.com.sg',
  'yahoo.com.tr',
  'yahoo.com.tw',
  'yahoo.com.vn',
  'yahoo.de',
  'yahoo.dk',
  'yahoo.es',
  'yahoo.fr',
  'yahoo.gr',
  'yahoo.ie',
  'yahoo.in',
  'yahoo.it',
  'yahoo.nl',
  'yahoo.no',
  'yahoo.pl',
  'yahoo.ro',
  'yahoo.se',
  'ymail.com',
  'rocketmail.com',
  'myyahoo.com',
  'maktoob.com',
  // Apple
  'icloud.com',
  'me.com',
  'mac.com',
  // AOL
  'aol.com',
  'aol.co.uk',
  'aol.de',
  'aol.fr',
  'aol.it',
  'aim.com',
  // Proton
  'proton.me',
  'protonmail.com',
  'protonmail.ch',
  'pm.me',
  // GMX, Web.de, mail.com
  'gmx.com',
  'gmx.net',
  'gmx.de',
  'gmx.at',
  'gmx.ch',
  'gmx.co.uk',
  'gmx.es',
  'gmx.fr',
  'gmx.it',
  'gmx.us',
  'web.de',
  'mail.com',
  // Yandex, Mail.ru, Rambler
  'yandex.com',
  'yandex.ru',
  'yandex.by',
  'yandex.kz',
  'yandex.ua',
  'yandex.com.tr',
  'ya.ru',
  'mail.ru',
  'inbox.ru',
  'list.ru',
  'bk.ru',
  'internet.ru',
  'rambler.ru',
  // Other consumer providers
  'zoho.com',
  'zohomail.com',
  'fastmail.com',
  'tutanota.com',
  'tuta.io',
  'hey.com',
  'qq.com',
  '163.com',
  '126.com',
  'yeah.net',
  'sina.com',
  'naver.com',
  'daum.net',
  'hanmail.net',
  'rediffmail.com',
  't-online.de',
  'freenet.de',
  'orange.fr',
  'wanadoo.fr',
  'free.fr',
  'laposte.net',
  'sfr.fr',
  'libero.it',
  'virgilio.it',
  'btinternet.com',
  'sky.com',
  'comcast.net',
  'verizon.net',
  'att.net',
  'sbcglobal.net',
  'seznam.cz',
  'wp.pl',
  'o2.pl',
  'interia.pl',
  // Gulf ISP mail
  'qatar.net.qa',
  'emirates.net.ae',
] as const;

const PUBLIC_EMAIL_DOMAIN_SET: ReadonlySet<string> = new Set(PUBLIC_EMAIL_DOMAINS);

/**
 * The big consumer providers run a mail domain in many countries (hotmail.co.th, yahoo.com.ar,
 * outlook.com.vn, gmx.at…): the exact list above can't name them all, so a domain made of one of
 * these provider names plus a public suffix (a TLD, or a country second level such as co.xx /
 * com.xx) is public too. A company name that merely contains one (outlook-partners.com,
 * mail.live-events.qa) is not.
 */
export const PUBLIC_EMAIL_PROVIDER_LABELS = [
  'gmail',
  'googlemail',
  'hotmail',
  'outlook',
  'live',
  'msn',
  'windowslive',
  'yahoo',
  'ymail',
  'rocketmail',
  'aol',
  'gmx',
  'yandex',
  'protonmail',
  'proton',
  'icloud',
] as const;

const PROVIDER_LABEL_SET: ReadonlySet<string> = new Set(PUBLIC_EMAIL_PROVIDER_LABELS);
/** A TLD ("com", "fr") or a country second level ("co.uk", "com.qa", "ne.jp", "or.kr"). */
const PUBLIC_SUFFIX_SHAPE = /^(?:[a-z]{2,63}|(?:co|com|net|org|ne|or|gen|ltd|web)\.[a-z]{2})$/;

/** A consumer mail domain an organisation can't claim (E10). Expects a lower-case hostname. */
export function isPublicEmailDomain(domain: string): boolean {
  if (PUBLIC_EMAIL_DOMAIN_SET.has(domain)) return true;
  const dot = domain.indexOf('.');
  if (dot <= 0) return false;
  return (
    PROVIDER_LABEL_SET.has(domain.slice(0, dot)) && PUBLIC_SUFFIX_SHAPE.test(domain.slice(dot + 1))
  );
}

/** A lower-case hostname with at least one dot (e.g. "hamad.qa"). */
export const EMAIL_DOMAIN_PATTERN =
  /^(?=.{3,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export const emailDomainSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(EMAIL_DOMAIN_PATTERN, { error: 'validation.emailDomain' })
  .refine((d) => !isPublicEmailDomain(d), {
    error: 'validation.publicEmailDomain',
  });

/** Lower-cased hostnames, duplicates dropped (first one kept). */
export const emailDomainsSchema = z
  .array(emailDomainSchema)
  .max(CLIENT_LIMITS.emailDomainsMax, { error: 'validation.tooLarge' })
  .transform((domains) => [...new Set(domains)]);

export const siteAdminDtoSchema = z.object({
  id: z.uuid(),
  orgId: z.uuid(),
  key: z.string(),
  name: z.string(),
  nameAr: z.string().nullable(),
  address: z.string().nullable(),
  sortOrder: z.number().int(),
  isActive: z.boolean(),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
});
export type SiteAdminDto = z.infer<typeof siteAdminDtoSchema>;

export const organizationAdminDtoSchema = z.object({
  id: z.uuid(),
  key: z.string(),
  name: z.string(),
  nameAr: z.string().nullable(),
  contractType: z.enum(CONTRACT_TYPES),
  amcExpiry: isoDay.nullable(),
  accountManager: adminUserRefSchema.nullable(),
  emailDomains: z.array(z.string()),
  phone: z.string().nullable(),
  isActive: z.boolean(),
  /** Every site, archived ones included, in order. */
  sites: z.array(siteAdminDtoSchema),
  /** Client accounts of the organisation (any status). */
  clientCount: z.number().int().nonnegative(),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
});
export type OrganizationAdminDto = z.infer<typeof organizationAdminDtoSchema>;

export const organizationListQuerySchema = adminPagedQuerySchema;
export const organizationListSchema = pagedListSchema(organizationAdminDtoSchema);
export const organizationResponseSchema = itemResponseSchema(organizationAdminDtoSchema);
export const siteResponseSchema = itemResponseSchema(siteAdminDtoSchema);

export const createOrganizationSchema = z.object({
  key: adminKeySchema.optional(),
  name: labelEnSchema,
  nameAr: optionalText(ADMIN_LIMITS.labelMax).default(null),
  contractType: z.enum(CONTRACT_TYPES).default('AMC'),
  amcExpiry: isoDay.nullable().default(null),
  /** An active staff user. */
  accountManagerId: z.uuid().nullable().default(null),
  emailDomains: emailDomainsSchema.default([]),
  phone: optionalText(CLIENT_LIMITS.phoneMax).default(null),
});
export type CreateOrganizationInput = z.infer<typeof createOrganizationSchema>;

export const updateOrganizationSchema = z
  .object({
    expectedUpdatedAt: expectedUpdatedAtSchema,
    name: labelEnSchema.optional(),
    nameAr: optionalText(ADMIN_LIMITS.labelMax).optional(),
    contractType: z.enum(CONTRACT_TYPES).optional(),
    amcExpiry: isoDay.nullable().optional(),
    accountManagerId: z.uuid().nullable().optional(),
    emailDomains: emailDomainsSchema.optional(),
    phone: optionalText(CLIENT_LIMITS.phoneMax).optional(),
  })
  .refine(hasChanges, NOTHING_TO_CHANGE);
export type UpdateOrganizationInput = z.infer<typeof updateOrganizationSchema>;

export const createSiteSchema = z.object({
  key: adminKeySchema.optional(),
  name: labelEnSchema,
  nameAr: labelArSchema.default(''),
  address: optionalText(ADMIN_LIMITS.addressMax).default(null),
});
export type CreateSiteInput = z.infer<typeof createSiteSchema>;

export const updateSiteSchema = z
  .object({
    expectedUpdatedAt: expectedUpdatedAtSchema,
    name: labelEnSchema.optional(),
    nameAr: labelArSchema.optional(),
    address: optionalText(ADMIN_LIMITS.addressMax).optional(),
  })
  .refine(hasChanges, NOTHING_TO_CHANGE);
export type UpdateSiteInput = z.infer<typeof updateSiteSchema>;

export const organizationSiteParamSchema = z.object({ id: z.uuid(), siteId: z.uuid() });

// ───────────── Pending sign-ups (E10) ─────────────

/** A client who signed up with an address no organisation claims (status PENDING_APPROVAL). */
export const pendingSignupDtoSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  email: z.email(),
  emailDomain: z.string(),
  /** Company typed at sign-up. */
  signupCompany: z.string().nullable(),
  emailVerified: z.boolean(),
  status: z.enum(USER_STATUSES),
  /** After approval. */
  org: z.object({ id: z.uuid(), name: z.string() }).nullable(),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
});
export type PendingSignupDto = z.infer<typeof pendingSignupDtoSchema>;

/**
 * `pending`: waiting for a decision (PENDING_APPROVAL). `rejected`: rejected sign-ups (DISABLED, no
 * organisation), which an admin can still approve into an organisation.
 */
export const PENDING_SIGNUP_STATUSES = ['pending', 'rejected'] as const;
export type PendingSignupStatus = (typeof PENDING_SIGNUP_STATUSES)[number];

export const pendingSignupListQuerySchema = z.object({
  status: z.enum(PENDING_SIGNUP_STATUSES).optional().default('pending'),
  search: cleanText().max(ADMIN_LIMITS.searchMax).optional(),
  cursor: z.string().max(200).optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(ADMIN_LIMITS.pageMax)
    .optional()
    .default(ADMIN_LIMITS.pageDefault),
});
export const pendingSignupListSchema = pagedListSchema(pendingSignupDtoSchema);
export const pendingSignupResponseSchema = itemResponseSchema(pendingSignupDtoSchema);

/**
 * Joins an active organisation and becomes ACTIVE. A rejected sign-up (DISABLED, no organisation)
 * can be approved too.
 */
export const approveSignupSchema = z.object({
  expectedUpdatedAt: expectedUpdatedAtSchema,
  orgId: z.uuid(),
});
export type ApproveSignupInput = z.infer<typeof approveSignupSchema>;

/**
 * The account is disabled (it can't sign in; the address can't register again). It stays listed
 * under `status=rejected`, where approving it is the way back.
 */
export const rejectSignupSchema = z.object({ expectedUpdatedAt: expectedUpdatedAtSchema });
export type RejectSignupInput = z.infer<typeof rejectSignupSchema>;
