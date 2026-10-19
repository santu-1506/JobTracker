import { PLAN_LIMITS, type InstallResponse, type MeResponse } from '@jobtracker/core';
import type { FastifyInstance } from 'fastify';
import { generateToken, hashToken, requireUser } from '../plugins/auth.js';
import { countApplications } from '../services/applications.js';

export async function installRoutes(app: FastifyInstance): Promise<void> {
  /**
   * Called once by the extension after install. Returns a bearer token that
   * identifies this browser; the server keeps only its hash.
   */
  app.post('/v1/installs', async (_request, reply) => {
    const token = generateToken();
    const { rows } = await app.db.query<{ id: string; plan: 'free' | 'pro' }>(
      'INSERT INTO users (token_hash, plan) VALUES ($1, $2) RETURNING id, plan',
      [hashToken(token), app.config.defaultPlan],
    );
    const user = rows[0]!;
    const body: InstallResponse = { userId: user.id, token, plan: user.plan };
    return reply.code(201).send(body);
  });

  app.get('/v1/me', { preHandler: requireUser }, async (request): Promise<MeResponse> => {
    const user = request.user!;
    return {
      userId: user.id,
      plan: user.plan,
      limits: PLAN_LIMITS[user.plan],
      usage: { applications: await countApplications(app.db, user.id) },
    };
  });
}
