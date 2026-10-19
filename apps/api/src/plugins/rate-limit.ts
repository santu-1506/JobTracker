import { createHash } from 'node:crypto';
import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance, FastifyRequest } from 'fastify';

/** Requests are budgeted per API token when present, otherwise per IP. */
export function rateLimitKey(request: FastifyRequest): string {
  const auth = request.headers.authorization;
  if (auth) return `token:${createHash('sha256').update(auth).digest('base64url').slice(0, 22)}`;
  return `ip:${request.ip}`;
}

/**
 * In-memory limits are fine for a single API instance. Behind a load
 * balancer, pass a shared store (for example Redis) to keep budgets global.
 */
export async function registerRateLimits(app: FastifyInstance): Promise<void> {
  await app.register(rateLimit, {
    global: true,
    max: 600,
    timeWindow: '1 minute',
    keyGenerator: rateLimitKey,
    allowList: (request) => request.url === '/healthz' || request.url === '/readyz',
  });
}
