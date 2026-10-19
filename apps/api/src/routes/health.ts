import type { FastifyInstance } from 'fastify';

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  /** Liveness: the process is up. */
  app.get('/healthz', async () => ({ status: 'ok' }));

  /** Readiness: the database answers. Load balancers should route on this one. */
  app.get('/readyz', async (_request, reply) => {
    try {
      await app.db.query('SELECT 1');
      return { status: 'ok' };
    } catch (error) {
      app.log.error({ err: error }, 'readiness check failed');
      return reply.code(503).send({ status: 'unavailable' });
    }
  });
}
