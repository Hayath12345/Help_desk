// Isomorphic JSON-over-fetch helper shared by the server and browser API clients.
import { ApiRequestError, toApiRequestError } from './errors';

export type JsonRequestInit = Omit<RequestInit, 'body'> & {
  /** JSON-serialisable body (sets Content-Type: application/json). */
  json?: unknown;
  /** Raw body (FormData, string, …) when `json` is not used. */
  body?: BodyInit | null;
};

/** Joins the API base URL and a path such as `/me` or `internal/auth/login`. */
export function joinUrl(base: string, path: string): string {
  if (/^https?:\/\//i.test(path)) throw new Error('API paths must be relative');
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
}

/**
 * Performs the request and returns the parsed JSON body (`undefined` for 204 / empty bodies).
 * Non-2xx responses throw `ApiRequestError` built from the contract error body; network
 * failures and timeouts throw `ApiRequestError` with status 0 (code INTERNAL).
 */
export async function requestJson<T>(url: string, init: JsonRequestInit = {}): Promise<T> {
  const { json, body, headers: initHeaders, ...rest } = init;
  const headers = new Headers(initHeaders);
  if (!headers.has('accept')) headers.set('accept', 'application/json');

  let requestBody: BodyInit | null | undefined = body;
  if (json !== undefined) {
    headers.set('content-type', 'application/json');
    requestBody = JSON.stringify(json);
  }

  let response: Response;
  try {
    response = await fetch(url, { ...rest, headers, body: requestBody, cache: 'no-store' });
  } catch (error) {
    // A caller-initiated abort is not an API failure: let it propagate unchanged.
    if (
      isAbortError(error) &&
      rest.signal?.aborted &&
      rest.signal.reason?.name !== 'TimeoutError'
    ) {
      throw error;
    }
    throw new ApiRequestError(
      0,
      'INTERNAL',
      isAbortError(error) ? 'API request timed out' : 'API is unreachable',
      undefined,
      undefined,
      { cause: error },
    );
  }

  if (!response.ok) throw await toApiRequestError(response);
  if (response.status === 204 || response.status === 205) return undefined as T;

  const text = await response.text();
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new ApiRequestError(
      response.status,
      'INTERNAL',
      'API returned a malformed JSON body',
      response.headers.get('x-request-id') ?? undefined,
      undefined,
      { cause: error },
    );
  }
}
