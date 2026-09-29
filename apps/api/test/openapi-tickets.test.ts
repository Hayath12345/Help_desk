import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, type TestContext } from './helpers.ts';

// The OpenAPI document (/docs/json) covers every Phase 2 route with its request and response
// schemas, Bearer security and the error responses.

const ROUTES: Array<[method: string, path: string, success: string[]]> = [
  ['get', '/config/ticket-form', ['200']],
  ['get', '/tickets/form-context', ['200']],
  ['get', '/requesters', ['200']],
  ['post', '/tickets', ['201']],
  ['get', '/tickets', ['200']],
  ['get', '/tickets/counts', ['200']],
  ['get', '/tickets/{ref}', ['200']],
  ['patch', '/tickets/{id}', ['200']],
  ['get', '/tickets/{id}/messages', ['200']],
  ['post', '/tickets/{id}/messages', ['200', '201']],
  ['post', '/attachments/presign', ['201']],
  ['post', '/attachments/{id}/complete', ['200']],
  ['get', '/attachments/{id}/download', ['200']],
  ['get', '/macros', ['200']],
  ['get', '/teams', ['200']],
];

describe('OpenAPI: ticket routes', () => {
  let ctx: TestContext;
  beforeAll(async () => {
    ctx = await createTestContext();
  });
  afterAll(async () => {
    await ctx.close();
  });

  it('documents every ticket route with schemas, security and error responses', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/docs/json' });
    expect(res.statusCode).toBe(200);
    const doc = res.json();
    expect(doc.tags.map((t: { name: string }) => t.name)).toEqual(
      expect.arrayContaining(['config', 'tickets', 'attachments', 'staff']),
    );
    for (const [method, path, success] of ROUTES) {
      const op = doc.paths[path]?.[method];
      expect(op, `${method.toUpperCase()} ${path}`).toBeDefined();
      expect(op.security).toEqual([{ bearerAuth: [] }]);
      expect(op.summary).toEqual(expect.any(String));
      for (const code of [...success, '401', '403', '429']) {
        expect(op.responses[code], `${method} ${path} ${code}`).toBeDefined();
      }
      for (const code of success) {
        expect(op.responses[code].content['application/json'].schema).toBeDefined();
      }
      if (method === 'post' || method === 'patch') {
        if (!path.endsWith('/complete')) {
          expect(op.requestBody?.content['application/json'].schema, path).toBeDefined();
        }
      }
    }
    // Invisible tickets are documented as 404 (never 403-only).
    expect(doc.paths['/tickets/{ref}'].get.responses['404']).toBeDefined();
    expect(doc.paths['/tickets/{id}'].patch.responses['409']).toBeDefined();
  });
});
