import type { IncomingMessage } from 'node:http';
import type { FastifyBaseLogger } from 'fastify';
import { pino, stdSerializers, type Logger, type LoggerOptions } from 'pino';
import type { AppConfig } from '../config.ts';
import { redactPii } from './pii.ts';

/** The logger surface shared by Fastify's `app.log` and the worker's pino instance. */
export type AppLogger = FastifyBaseLogger;

// Structured JSON logs (pino). No PII: auth headers, cookies, the internal key and any field
// named password / token / email are redacted; request bodies are never logged; query strings
// are dropped from logged URLs; error messages are scrubbed of emails and phone numbers.

export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-internal-api-key"]',
  'res.headers["set-cookie"]',
  'headers.authorization',
  'headers.cookie',
  'headers["x-internal-api-key"]',
  'body',
  'req.body',
  'password',
  'token',
  'email',
  '*.password',
  '*.token',
  '*.email',
  '*.*.password',
  '*.*.token',
  '*.*.email',
];

function pathOnly(url: string | undefined): string | undefined {
  if (!url) return url;
  const q = url.indexOf('?');
  return q === -1 ? url : url.slice(0, q);
}

const serializers = {
  req(req: IncomingMessage & { method?: string; url?: string; ip?: string }) {
    return {
      method: req.method,
      url: pathOnly(req.url),
      remoteAddress: req.ip ?? req.socket?.remoteAddress,
    };
  },
  err(err: Error) {
    const out = stdSerializers.err(err);
    if (typeof out.message === 'string') out.message = redactPii(out.message);
    if (typeof out.stack === 'string') out.stack = redactPii(out.stack);
    return out;
  },
};

/** Pretty output only for humans: an interactive terminal outside production. */
export function usePrettyLogs(config: Pick<AppConfig, 'isProduction'>): boolean {
  return Boolean(process.stdout.isTTY) && !config.isProduction;
}

export function loggerOptions(
  config: Pick<AppConfig, 'logLevel' | 'isProduction' | 'env'>,
  name: string,
): LoggerOptions {
  const pretty = usePrettyLogs(config) && config.logLevel !== 'silent';
  return {
    name,
    level: config.logLevel,
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    serializers,
    timestamp: pino.stdTimeFunctions.isoTime,
    ...(pretty
      ? {
          transport: {
            target: 'pino-pretty',
            options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l', ignore: 'pid,hostname' },
          },
        }
      : { formatters: { level: (label: string) => ({ level: label }) } }),
  };
}

export function createLogger(
  config: Pick<AppConfig, 'logLevel' | 'isProduction' | 'env'>,
  name: string,
): Logger {
  return pino(loggerOptions(config, name));
}
