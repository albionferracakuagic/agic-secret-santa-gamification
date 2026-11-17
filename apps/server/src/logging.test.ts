import { describe, expect, it } from 'vitest';
import { buildApp } from './app.js';
import { redactUrl } from './logging.js';

describe('log redaction', () => {
  it('request logs never contain cookies, auth headers, query tokens or token-like path segments', async () => {
    const lines: string[] = [];
    const app = buildApp({ logging: { sink: { write: (m) => void lines.push(m) } } });
    await app.ready();
    const longToken = 'abcdefghijklmnopqrstuvwxyz0123456789ABCD';
    await app.inject({
      method: 'GET',
      url: `/health?token=SECRET-MAGIC-LINK&email=anna@example.test`,
      headers: { cookie: 'sg_p=GUEST-SESSION-SECRET', authorization: 'Bearer TOP-SECRET' },
    });
    await app.inject({ method: 'GET', url: `/api/unknown/${longToken}/x` });
    await app.close();

    const all = lines.join('\n');
    expect(all).toContain('/health'); // logging is actually on
    for (const secret of [
      'SECRET-MAGIC-LINK',
      'anna@example.test',
      'GUEST-SESSION-SECRET',
      'TOP-SECRET',
      longToken,
    ]) {
      expect(all, `leaked ${secret}`).not.toContain(secret);
    }
  });

  it('redactUrl strips the query and masks opaque segments but keeps normal routes readable', () => {
    expect(redactUrl('/api/events/9f3c1c1e-0000-4000-8000-000000000000/boards?x=1')).toBe(
      '/api/events/9f3c1c1e-0000-4000-8000-000000000000/boards',
    );
    expect(redactUrl('/media/gifts/abc/abcdefghijklmnopqrstuvwxyz012345.jpg?sig=zzz')).toContain(
      'media/gifts',
    );
    expect(redactUrl('/join/abcdefghijklmnopqrstuvwxyz0123')).toBe('/join/[redacted]');
  });
});
