// Isomorphic API error handling (used by the server client and the browser client).
import { apiErrorSchema, type ErrorCode } from '@loons/shared';

/** A non-2xx response from the API (or the API being unreachable: `status` 0). */
export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly requestId?: string,
    readonly details?: unknown,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'ApiRequestError';
  }
}

export function isApiRequestError(error: unknown): error is ApiRequestError {
  return error instanceof ApiRequestError;
}

/** Fallback when the body is not the contract error shape (proxy errors, HTML pages, …). */
export function errorCodeForStatus(status: number): ErrorCode {
  switch (status) {
    case 400:
      return 'BAD_REQUEST';
    case 401:
      return 'UNAUTHENTICATED';
    case 403:
      return 'FORBIDDEN';
    case 404:
      return 'NOT_FOUND';
    case 409:
      return 'CONFLICT';
    case 422:
      return 'VALIDATION_FAILED';
    case 429:
      return 'RATE_LIMITED';
    default:
      return 'INTERNAL';
  }
}

/** Parses the contract error body `{ error: { code, message, details? }, requestId? }`. */
export function parseApiErrorBody(
  status: number,
  body: unknown,
  fallbackMessage = '',
): ApiRequestError {
  const parsed = apiErrorSchema.safeParse(body);
  if (parsed.success) {
    const { error, requestId } = parsed.data;
    return new ApiRequestError(status, error.code, error.message, requestId, error.details);
  }
  return new ApiRequestError(
    status,
    errorCodeForStatus(status),
    fallbackMessage || `API request failed with status ${status}`,
  );
}

export async function toApiRequestError(response: Response): Promise<ApiRequestError> {
  let body: unknown = null;
  try {
    const text = await response.text();
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  const error = parseApiErrorBody(response.status, body, response.statusText);
  if (!error.requestId) {
    const headerId = response.headers.get('x-request-id');
    if (headerId) {
      return new ApiRequestError(error.status, error.code, error.message, headerId, error.details);
    }
  }
  return error;
}

/** One issue of a 400 VALIDATION_FAILED response (zod issue: path + i18n message key). */
export interface ValidationIssue {
  path: (string | number)[];
  message: string;
}

/** Extracts `details` issues from a VALIDATION_FAILED error, tolerating unexpected shapes. */
export function validationIssues(error: ApiRequestError): ValidationIssue[] {
  const details = error.details;
  const list = Array.isArray(details)
    ? details
    : details &&
        typeof details === 'object' &&
        Array.isArray((details as { issues?: unknown }).issues)
      ? (details as { issues: unknown[] }).issues
      : [];
  const issues: ValidationIssue[] = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') continue;
    const { path, message } = item as { path?: unknown; message?: unknown };
    if (!Array.isArray(path) || typeof message !== 'string') continue;
    issues.push({
      path: path.filter(
        (p): p is string | number => typeof p === 'string' || typeof p === 'number',
      ),
      message,
    });
  }
  return issues;
}
