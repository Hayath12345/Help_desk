import { Prisma } from '@loons/db';
import type { AdminConflictDetails } from '@loons/shared';
import { AppError, errors } from './errors.ts';

// Prisma request errors that describe the request, not a server fault (decision E19): a unique
// value already taken, a row that does not exist (any more), a row still referenced by another.
// The error handler turns them into 409 / 404 / 409 instead of 500; services may map them earlier
// with more specific messages.

interface DriverCause {
  originalCode?: string;
  kind?: string;
  constraint?: { fields?: string[]; index?: string };
  table?: string;
}

function driverCause(meta: Record<string, unknown> | undefined): DriverCause | undefined {
  const adapterError = meta?.driverAdapterError as { cause?: DriverCause } | undefined;
  return adapterError?.cause;
}

/**
 * The columns of a constraint: the adapter's `fields` when present, else parsed from the index
 * name Prisma generates (`Team_key_key` → ["key"], `Subtype_categoryId_key_key` →
 * ["categoryId", "key"]); the legacy `meta.target` too.
 */
export function constraintFields(
  meta: Record<string, unknown> | undefined,
  modelName?: string,
): string[] {
  const target = meta?.target;
  if (Array.isArray(target)) return target.map(String);
  const constraint = driverCause(meta)?.constraint;
  if (constraint?.fields?.length) return constraint.fields.map(String);
  const index = constraint?.index ?? (typeof target === 'string' ? target : undefined);
  if (!index) return [];
  const table = driverCause(meta)?.table ?? modelName ?? (meta?.modelName as string | undefined);
  let name = index;
  if (table && name.startsWith(`${table}_`)) name = name.slice(table.length + 1);
  name = name.replace(/_(key|idx|fkey|pkey)$/, '');
  return name.split('_').filter(Boolean);
}

/** The Postgres SQLSTATE behind a Prisma error (raw queries report it this way). */
function sqlState(err: Prisma.PrismaClientKnownRequestError): string | undefined {
  const meta = err.meta as Record<string, unknown> | undefined;
  return (
    driverCause(meta)?.originalCode ?? (typeof meta?.code === 'string' ? meta.code : undefined)
  );
}

function conflict(message: string, details: AdminConflictDetails): AppError {
  return new AppError(409, 'CONFLICT', message, details);
}

/**
 * The API error for a Prisma request error, or null when it is not one we map:
 * - P2002 (unique) → 409 CONFLICT `{ reason: 'duplicate', fields }`
 * - P2003 (foreign key) → 409 CONFLICT `{ reason: 'in_use', fields }`
 * - P2025 (record not found) → 404 NOT_FOUND
 * - P2034 (write conflict or deadlock; SQLSTATE 40001 / 40P01) → 409 CONFLICT `{ reason: 'stale' }`:
 *   another save touched the same rows at the same moment, so reloading and saving again works
 * - P2010 (raw query) with SQLSTATE 23505 / 23503 / 40001 / 40P01 → as above
 */
export function mapPrismaError(err: unknown): AppError | null {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError)) return null;
  const meta = err.meta as Record<string, unknown> | undefined;
  const state = err.code === 'P2010' ? sqlState(err) : undefined;
  if (err.code === 'P2002' || state === '23505') {
    return conflict('This value is already used by another record.', {
      reason: 'duplicate',
      fields: constraintFields(meta),
    });
  }
  if (err.code === 'P2003' || state === '23503') {
    return conflict('This record is still referenced by other records.', {
      reason: 'in_use',
      fields: constraintFields(meta),
    });
  }
  if (err.code === 'P2025') return errors.notFound('Not found');
  if (err.code === 'P2034' || state === '40001' || state === '40P01') {
    return conflict('Someone else was saving this at the same moment — reload and try again.', {
      reason: 'stale',
    });
  }
  return null;
}

/** A unique-constraint violation (P2002, or SQLSTATE 23505 from a raw query). */
export function isUniqueViolation(err: unknown): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError)) return false;
  return err.code === 'P2002' || (err.code === 'P2010' && sqlState(err) === '23505');
}
