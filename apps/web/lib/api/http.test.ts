import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiRequestError, parseApiErrorBody, validationIssues } from './errors';
import { joinUrl, requestJson } from './http';

afterEach(() => {
  vi.unstubAllGlobals();
});

function mockFetch(response: Response | Error) {
  const fn = vi.fn(async (_url: string, _init?: RequestInit) => {
    if (response instanceof Error) throw response;
    return response;
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

describe('joinUrl', () => {
  it('joins without doubling slashes and refuses absolute paths', () => {
    expect(joinUrl('http://api:4000/', '/me')).toBe('http://api:4000/me');
    expect(joinUrl('http://api:4000', 'internal/auth/login')).toBe(
      'http://api:4000/internal/auth/login',
    );
    expect(() => joinUrl('http://api:4000', 'https://evil.com/x')).toThrow();
  });
});

describe('requestJson', () => {
  it('sends JSON with no-store caching and parses the response', async () => {
    const fetchMock = mockFetch(Response.json({ ok: true }));
    await expect(requestJson('http://api/x', { method: 'POST', json: { a: 1 } })).resolves.toEqual({
      ok: true,
    });
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init?.cache).toBe('no-store');
    expect(init?.body).toBe('{"a":1}');
    const headers = new Headers(init?.headers);
    expect(headers.get('content-type')).toBe('application/json');
    expect(headers.get('accept')).toBe('application/json');
  });

  it('returns undefined for 204', async () => {
    mockFetch(new Response(null, { status: 204 }));
    await expect(requestJson('http://api/x')).resolves.toBeUndefined();
  });

  it('turns the contract error body into ApiRequestError', async () => {
    mockFetch(
      Response.json(
        {
          error: { code: 'INVALID_CREDENTIALS', message: 'Invalid email or password' },
          requestId: 'req-1',
        },
        { status: 401 },
      ),
    );
    const error = await requestJson('http://api/x').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiRequestError);
    expect(error).toMatchObject({ status: 401, code: 'INVALID_CREDENTIALS', requestId: 'req-1' });
  });

  it('falls back to a status-derived code for non-contract bodies', async () => {
    mockFetch(new Response('<html>Bad gateway</html>', { status: 502, statusText: 'Bad Gateway' }));
    await expect(requestJson('http://api/x')).rejects.toMatchObject({
      status: 502,
      code: 'INTERNAL',
    });
    mockFetch(new Response('nope', { status: 429 }));
    await expect(requestJson('http://api/x')).rejects.toMatchObject({ code: 'RATE_LIMITED' });
  });

  it('reports an unreachable API as status 0', async () => {
    mockFetch(new TypeError('fetch failed'));
    await expect(requestJson('http://api/x')).rejects.toMatchObject({
      status: 0,
      code: 'INTERNAL',
    });
  });

  it('lets a caller abort propagate unchanged', async () => {
    const controller = new AbortController();
    controller.abort();
    mockFetch(new DOMException('aborted', 'AbortError'));
    await expect(requestJson('http://api/x', { signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
  });
});

describe('validationIssues', () => {
  it('extracts zod issues from VALIDATION_FAILED details', () => {
    const error = parseApiErrorBody(400, {
      error: {
        code: 'VALIDATION_FAILED',
        message: 'Invalid body',
        details: [
          { path: ['email'], message: 'validation.email' },
          { path: ['password'], message: 'validation.passwordMin' },
          { nonsense: true },
        ],
      },
    });
    expect(validationIssues(error)).toEqual([
      { path: ['email'], message: 'validation.email' },
      { path: ['password'], message: 'validation.passwordMin' },
    ]);
  });

  it('keeps the API rule code when there is one', () => {
    const error = new ApiRequestError(400, 'VALIDATION_FAILED', 'x', undefined, [
      {
        location: 'body',
        path: ['categoryId'],
        message: 'validation.invalid',
        code: 'security_category',
      },
    ]);
    expect(validationIssues(error)).toEqual([
      { path: ['categoryId'], message: 'validation.invalid', code: 'security_category' },
    ]);
  });

  it('accepts { issues: [...] } details and ignores other shapes', () => {
    const wrapped = new ApiRequestError(400, 'VALIDATION_FAILED', 'x', undefined, {
      issues: [{ path: ['name'], message: 'validation.nameMin' }],
    });
    expect(validationIssues(wrapped)).toEqual([{ path: ['name'], message: 'validation.nameMin' }]);
    expect(
      validationIssues(new ApiRequestError(400, 'VALIDATION_FAILED', 'x', undefined, 'oops')),
    ).toEqual([]);
  });
});
