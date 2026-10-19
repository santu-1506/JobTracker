import type { ApiErrorBody } from '@jobtracker/core';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import type { Config } from './config.js';
import type { Pool } from './db/pool.js';
import { HttpError } from './errors.js';
import { healthRoutes } from './routes/health.js';
import { installRoutes } from './routes/installs.js';
import { sightingRoutes } from './routes/sightings.js';

declare module 'fastify' {
  interface FastifyInstance {
    db: Pool;
    config: Config;
  }
}

export interface AppDependencies {
  config: Config;
  pool: Pool;
}

export async function buildApp({ config, pool }: AppDependencies): Promise<FastifyInstance> {
  const app = Fastify({
    logger:
      config.logLevel === 'silent'
        ? false
        : { level: config.logLevel, redact: ['req.headers.authorization'] },
    trustProxy: config.trustProxy,
    bodyLimit: 64 * 1024,
  });

  app.decorate('db', pool);
  app.decorate('config', config);
  app.decorateRequest('user', null);

  app.setErrorHandler((error: FastifyError | HttpError, request, reply) => {
    if (error instanceof HttpError) {
      const body: ApiErrorBody = { error: { code: error.code, message: error.message, details: error.details } };
      return reply.code(error.statusCode).send(body);
    }
    const status = error.statusCode ?? 500;
    if (status === 429) {
      return reply.code(429).send({ error: { code: 'rate_limited', message: error.message } } satisfies ApiErrorBody);
    }
    if (status >= 400 && status < 500) {
      return reply.code(status).send({ error: { code: 'bad_request', message: error.message } } satisfies ApiErrorBody);
    }
    request.log.error({ err: error }, 'unhandled error');
    return reply.code(500).send({ error: { code: 'internal', message: 'Something went wrong' } } satisfies ApiErrorBody);
  });

  app.setNotFoundHandler((request, reply) => {
    const body: ApiErrorBody = { error: { code: 'not_found', message: `No route for ${request.method} ${request.url}` } };
    return reply.code(404).send(body);
  });

  await app.register(healthRoutes);
  await app.register(installRoutes);
  await app.register(sightingRoutes);

  return app;
}
