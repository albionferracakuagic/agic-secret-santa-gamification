import type { FastifyServerOptions } from 'fastify';

/** Drops the query string (magic-link / media signatures) and masks long opaque path segments (tokens). */
export function redactUrl(url: string): string {
  const path = url.split('?')[0] ?? '';
  return path.replace(/\/([A-Za-z0-9_-]{24,})(?=\/|$)/g, (m, seg: string) =>
    UUID.test(seg) ? m : '/[redacted]',
  );
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface LogSink {
  write(msg: string): void;
}

/**
 * Request logs carry method, redacted path and status only. Cookies, auth headers, bodies and any
 * token/secret/email-shaped field are redacted even if some future code logs them.
 */
export function loggerOptions(sink?: LogSink): NonNullable<FastifyServerOptions['logger']> {
  return {
    level: process.env['LOG_LEVEL'] ?? 'info',
    ...(sink ? { stream: sink } : {}),
    redact: {
      paths: [
        'req.headers',
        'headers.cookie',
        'headers.authorization',
        '*.cookie',
        '*.authorization',
        '*.token',
        '*.secret',
        '*.password',
        '*.email',
        '*.displayName',
        '*.sessionToken',
        'res.headers',
      ],
      censor: '[redacted]',
    },
    serializers: {
      req: (r: { method: string; url: string }) => ({ method: r.method, url: redactUrl(r.url) }),
      res: (r: { statusCode: number }) => ({ statusCode: r.statusCode }),
    },
  };
}
