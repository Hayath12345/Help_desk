import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import type { FastifyInstance } from 'fastify';
import { jsonSchemaTransform } from 'fastify-type-provider-zod';
import { INTERNAL_API_KEY_HEADER } from '@loons/shared';

/** OpenAPI 3.1 generated from the zod route schemas; Swagger UI at /docs, spec at /docs/json. */
export async function registerDocs(app: FastifyInstance): Promise<void> {
  await app.register(swagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'Loons Help Desk API',
        description:
          'REST API of Loons Help Desk. Browser and server calls use a short-lived Bearer access token minted by the web app; `/internal/*` routes are server-to-server only and require the internal API key.',
        version: app.config.version,
      },
      servers: [],
      tags: [
        { name: 'health', description: 'Liveness and readiness' },
        { name: 'me', description: 'The signed-in user' },
        { name: 'internal-auth', description: 'Sign-in support for the web server (internal key)' },
      ],
      components: {
        securitySchemes: {
          bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
          internalApiKey: { type: 'apiKey', in: 'header', name: INTERNAL_API_KEY_HEADER },
        },
      },
    },
    transform: jsonSchemaTransform,
  });

  await app.register(swaggerUi, {
    routePrefix: '/docs',
    uiConfig: { docExpansion: 'list', deepLinking: true },
  });
}
