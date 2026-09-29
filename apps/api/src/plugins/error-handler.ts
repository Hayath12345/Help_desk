import type { FastifyError, FastifyInstance } from 'fastify';
import {
  ResponseSerializationError,
  hasZodFastifySchemaValidationErrors,
} from 'fastify-type-provider-zod';
import type { ErrorCode } from '@loons/shared';
import {
  AppError,
  codeForStatus,
  type ErrorResponse,
  type ValidationIssue,
} from '../lib/errors.ts';

export type { ValidationIssue } from '../lib/errors.ts';

function body(
  code: ErrorCode,
  message: string,
  requestId: string,
  details?: unknown,
): ErrorResponse {
  return { error: { code, message, ...(details !== undefined ? { details } : {}) }, requestId };
}

function toPath(instancePath: string): Array<string | number> {
  return instancePath
    .split('/')
    .filter((s) => s.length > 0)
    .map((s) => (/^\d+$/.test(s) ? Number(s) : s.replace(/~1/g, '/').replace(/~0/g, '~')));
}

/**
 * One error body for everything: `{ error: { code, message, details? }, requestId }`.
 * Unknown errors become 500 INTERNAL with a generic message (the stack is logged, never sent).
 */
export function registerErrorHandling(app: FastifyInstance): void {
  app.setErrorHandler<FastifyError | AppError>((err, req, reply) => {
    if (err instanceof AppError) {
      if (err.statusCode >= 500) req.log.error({ err }, 'request failed');
      return reply.code(err.statusCode).send(body(err.code, err.message, req.id, err.details));
    }

    if (hasZodFastifySchemaValidationErrors(err)) {
      const location = (err as FastifyError).validationContext ?? 'body';
      const issues: ValidationIssue[] = err.validation.map((v) => ({
        location,
        path: toPath(v.instancePath),
        message: v.message ?? 'Invalid value',
        code: v.keyword,
      }));
      return reply
        .code(400)
        .send(body('VALIDATION_FAILED', 'Request validation failed', req.id, issues));
    }

    if (err instanceof ResponseSerializationError) {
      req.log.error({ err, issues: err.cause.issues }, 'response did not match its schema');
      return reply
        .code(500)
        .send(body('INTERNAL', 'Something went wrong. Please try again.', req.id));
    }

    const fastifyErr = err as FastifyError;
    const status =
      typeof fastifyErr.statusCode === 'number' &&
      fastifyErr.statusCode >= 400 &&
      fastifyErr.statusCode < 600
        ? fastifyErr.statusCode
        : 500;

    if (status >= 500) {
      req.log.error({ err }, 'unhandled error');
      return reply
        .code(status === 503 ? 503 : 500)
        .send(body('INTERNAL', 'Something went wrong. Please try again.', req.id));
    }

    // 4xx raised by Fastify or a plugin (malformed JSON, body too large, unsupported media
    // type, non-zod validation…). Their messages describe the request, not server internals.
    const code: ErrorCode =
      fastifyErr.code === 'FST_ERR_VALIDATION' ? 'VALIDATION_FAILED' : codeForStatus(status);
    req.log.info({ code: fastifyErr.code, status }, 'request rejected');
    return reply.code(status).send(body(code, fastifyErr.message || 'Bad request', req.id));
  });

  app.setNotFoundHandler({ preHandler: app.rateLimit() }, (req, reply) => {
    return reply.code(404).send(body('NOT_FOUND', 'Route not found', req.id));
  });
}
