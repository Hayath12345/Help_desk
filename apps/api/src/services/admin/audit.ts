import type { Prisma } from '@loons/db';
import type { AuditAction, AuditEntity } from '@loons/shared';
import { maskPhone, urlHost } from '../../lib/pii.ts';

// The admin audit log (decision E17): one AdminAuditLog row per admin write, in the SAME
// transaction as the change (a failed change leaves no row; a failed audit insert rolls the change
// back). `before` / `after` hold the changed fields only, redacted:
// - never written: passwordHash, mfaSecret, sessionVersion, tokenHash (at any depth), and the
//   row's own id / createdAt / updatedAt (noise);
// - a Teams webhook URL is a secret: it becomes `teamsWebhookHost` (the host only);
// - phone numbers (any field whose name ends in "phone") are masked;
// - dates become ISO strings; nested objects and arrays are redacted the same way.

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Fields = Record<string, unknown>;

/** Secrets: never written to the audit log, at any depth, whatever the entity. */
export const AUDIT_SECRET_FIELDS: ReadonlySet<string> = new Set([
  'passwordHash',
  'mfaSecret',
  'sessionVersion',
  'tokenHash',
]);

/** Row bookkeeping left out of a row's top level (the entity id is its own column). */
export const AUDIT_NOISE_FIELDS: ReadonlySet<string> = new Set(['id', 'createdAt', 'updatedAt']);

const omitted = (name: string, topLevel: boolean) =>
  AUDIT_SECRET_FIELDS.has(name) || (topLevel && AUDIT_NOISE_FIELDS.has(name));

const LABEL_MAX = 200;

export interface AuditContext {
  /** Who made the change (null: the system). */
  actorId: string | null;
  /** The request id (x-request-id) of the write. */
  requestId: string | null;
}

export interface AuditEntry {
  action: AuditAction;
  entity: AuditEntity;
  entityId: string;
  /** A human label at the time of the change (e.g. the English name). */
  entityLabel?: string | null;
  /** The row before the change (whole row or the fields that may change); omit for CREATE. */
  before?: Fields | null;
  /** The row after the change; omit for DELETE. */
  after?: Fields | null;
}

function toJson(value: unknown): Json {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map((v) => toJson(v));
  if (typeof value === 'object') {
    // Prisma.Decimal and friends.
    if (typeof (value as { toJSON?: unknown }).toJSON === 'function' && !isPlainObject(value)) {
      return toJson((value as { toJSON: () => unknown }).toJSON());
    }
    return redactFields(value as Fields, false);
  }
  return null;
}

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

/**
 * One field as the audit log stores it: `[name, value]`, or null when the field is not stored.
 * Webhook URLs become `…WebhookHost`; phone numbers are masked.
 */
export function redactAuditField(
  name: string,
  value: unknown,
  topLevel = true,
): [string, Json] | null {
  if (omitted(name, topLevel)) return null;
  if (/webhookurl$/i.test(name)) {
    const host = typeof value === 'string' && value.trim() !== '' ? urlHost(value) : null;
    return [name.replace(/url$/i, 'Host'), host];
  }
  if (/phone$/i.test(name)) {
    return [name, typeof value === 'string' && value.trim() !== '' ? maskPhone(value) : null];
  }
  return [name, toJson(value)];
}

/** Every field of `fields`, redacted (secrets dropped; ids / timestamps at the top level). */
export function redactFields(fields: Fields, topLevel = true): { [key: string]: Json } {
  const out: { [key: string]: Json } = {};
  for (const [name, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    const redacted = redactAuditField(name, value, topLevel);
    if (redacted) out[redacted[0]] = redacted[1];
  }
  return out;
}

/** Stable JSON for comparing raw values (dates by instant, object keys sorted). */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v instanceof Date) return v.toISOString();
    if (v && typeof v === 'object' && !Array.isArray(v) && isPlainObject(v)) {
      return Object.fromEntries(
        Object.keys(v)
          .sort()
          .map((k) => [k, (v as Fields)[k]]),
      );
    }
    return v;
  });
}

/**
 * The changed fields of `before` → `after` (compared before redaction, so a new webhook URL on the
 * same host still counts), redacted; null when nothing changed. Fields missing from one side count
 * as null there.
 */
export function auditDiff(
  before: Fields,
  after: Fields,
): { before: { [key: string]: Json }; after: { [key: string]: Json } } | null {
  const changedBefore: Fields = {};
  const changedAfter: Fields = {};
  for (const name of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (omitted(name, true)) continue;
    const a = before[name] ?? null;
    const b = after[name] ?? null;
    if (canonical(a) === canonical(b)) continue;
    changedBefore[name] = a;
    changedAfter[name] = b;
  }
  if (Object.keys(changedAfter).length === 0) return null;
  return { before: redactFields(changedBefore), after: redactFields(changedAfter) };
}

/**
 * The AdminAuditLog row for an entry, or null when there is nothing to record (both sides given
 * and no field changed).
 */
export function auditRow(
  entry: AuditEntry,
  context: AuditContext,
): Prisma.AdminAuditLogCreateManyInput | null {
  let before: { [key: string]: Json } | null = null;
  let after: { [key: string]: Json } | null = null;
  if (entry.before && entry.after) {
    const diff = auditDiff(entry.before, entry.after);
    if (!diff) return null;
    ({ before, after } = diff);
  } else {
    before = entry.before ? redactFields(entry.before) : null;
    after = entry.after ? redactFields(entry.after) : null;
  }
  const label = entry.entityLabel?.trim();
  return {
    actorId: context.actorId,
    action: entry.action,
    entity: entry.entity,
    entityId: entry.entityId,
    entityLabel: label ? label.slice(0, LABEL_MAX) : null,
    requestId: context.requestId,
    ...(before ? { before } : {}),
    ...(after ? { after } : {}),
  };
}

export interface AuditRecorder {
  /**
   * Writes one audit row in the transaction (diffed and redacted, see `auditRow`). Returns false
   * when nothing changed (no row written).
   */
  record(entry: AuditEntry): Promise<boolean>;
}

/** An audit recorder bound to a transaction and the request's actor. */
export function createAuditRecorder(
  tx: Prisma.TransactionClient,
  context: AuditContext,
): AuditRecorder {
  return {
    async record(entry) {
      const row = auditRow(entry, context);
      if (!row) return false;
      await tx.adminAuditLog.create({ data: row, select: { id: true } });
      return true;
    },
  };
}
