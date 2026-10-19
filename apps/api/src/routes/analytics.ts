import { PLAN_LIMITS, type AnalyticsResponse } from '@jobtracker/core';
import type { FastifyInstance } from 'fastify';
import { planRequired } from '../errors.js';
import { requireUser } from '../plugins/auth.js';
import { getAnalytics } from '../services/analytics.js';

export async function analyticsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/v1/analytics', { preHandler: requireUser }, async (request): Promise<AnalyticsResponse> => {
    const user = request.user!;
    if (!PLAN_LIMITS[user.plan].analytics) throw planRequired('Analytics');
    return getAnalytics(app.db, user.id);
  });
}
