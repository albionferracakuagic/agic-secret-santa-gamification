import Fastify from 'fastify';
import { HealthResponseSchema } from '@santa/contracts';

export function buildApp() {
  const app = Fastify({ logger: false });

  app.get('/health', async (_req, reply) => {
    reply.header('Cache-Control', 'no-store');
    return HealthResponseSchema.parse({ status: 'ok' });
  });

  return app;
}
