// Server-side lookup of an emailed confirmation link (which account it confirms).
import 'server-only';
import { emailLinkOwnerSchema, type EmailLinkOwner, type ErrorCode } from '@loons/shared';
import { ApiRequestError } from '@/lib/api/errors';
import { internalApiFetch } from '@/lib/api/internal';
import { verifyEmailErrorCode } from './errors';

export type EmailLinkLookup =
  | { status: 'valid'; owner: EmailLinkOwner }
  /** Unknown, used or expired (or the account is disabled): request a new link. */
  | { status: 'invalid' }
  /** Could not be checked right now (rate limited, API unavailable…). */
  | { status: 'error'; error: ErrorCode };

/**
 * Which account a confirmation link is for. The API does not use the link up, so this is safe on
 * GET (mail scanners pre-fetch links): the page decides whether to offer "Confirm" or "Sign in".
 */
export async function lookupEmailLink(token: string): Promise<EmailLinkLookup> {
  try {
    const body = await internalApiFetch<unknown>('/internal/auth/email/link', {
      method: 'POST',
      json: { token },
    });
    const owner = emailLinkOwnerSchema.safeParse(body);
    return owner.success
      ? { status: 'valid', owner: owner.data }
      : { status: 'error', error: 'INTERNAL' };
  } catch (error) {
    if (error instanceof ApiRequestError) {
      const code = verifyEmailErrorCode(error.code);
      return code === 'VERIFY_TOKEN_INVALID'
        ? { status: 'invalid' }
        : { status: 'error', error: code };
    }
    throw error;
  }
}
