import type { AnalyticsResponse, Application, BadgeResponse } from '@jobtracker/core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, createUser, resetData, sightingInput, type TestContext, type TestUser } from './helpers.js';

let ctx: TestContext;
let user: TestUser;

beforeAll(async () => {
  ctx = await createTestApp();
});
afterAll(async () => {
  await ctx.close();
});
beforeEach(async () => {
  await resetData(ctx.pool);
  user = await createUser(ctx, 'pro');
});

async function track(company: string, stages: string[]): Promise<string> {
  const created = await ctx.app.inject({
    method: 'POST',
    url: '/v1/applications',
    headers: user.headers,
    payload: { company, title: 'Engineer', stage: stages[0] },
  });
  const id = created.json<Application>().id;
  for (const stage of stages.slice(1)) {
    await ctx.app.inject({ method: 'PATCH', url: `/v1/applications/${id}`, headers: user.headers, payload: { stage } });
  }
  return id;
}

async function analytics(): Promise<AnalyticsResponse> {
  const response = await ctx.app.inject({ url: '/v1/analytics', headers: user.headers });
  expect(response.statusCode).toBe(200);
  return response.json<AnalyticsResponse>();
}

describe('GET /v1/analytics', () => {
  it('is a Pro feature', async () => {
    const free = await createUser(ctx);
    const response = await ctx.app.inject({ url: '/v1/analytics', headers: free.headers });
    expect(response.statusCode).toBe(402);
  });

  it('returns zeros and nulls for an empty tracker', async () => {
    const result = await analytics();
    expect(result.totals).toEqual({ tracked: 0, applied: 0, responded: 0, interviews: 0, offers: 0, ghosted: 0 });
    expect(result.responseRate).toBeNull();
    expect(result.medianDaysToResponse).toBeNull();
    expect(result.weekly).toHaveLength(12);
  });

  it('computes the funnel from stage history', async () => {
    await track('Saved only', ['saved']);
    await track('No reply', ['applied']);
    await track('Ghosted', ['applied', 'ghosted']);
    await track('OA then reject', ['applied', 'oa', 'rejected']);
    await track('Interview then reject', ['applied', 'interview', 'rejected']);
    await track('Offer', ['applied', 'oa', 'interview', 'offer']);

    const result = await analytics();
    expect(result.totals).toEqual({ tracked: 6, applied: 5, responded: 3, interviews: 2, offers: 1, ghosted: 1 });
    expect(result.responseRate).toBe(0.6);
    expect(result.interviewRate).toBe(0.4);
    expect(result.byStage).toMatchObject({ saved: 1, applied: 1, ghosted: 1, rejected: 2, offer: 1 });
    expect(result.weekly.at(-1)!.applied).toBe(5);
  });

  it('measures the median time to first response', async () => {
    const fast = await track('Fast', ['applied', 'oa']);
    const slow = await track('Slow', ['applied', 'interview']);
    await ctx.pool.query(`UPDATE applications SET applied_at = now() - interval '4 days' WHERE id = $1`, [fast]);
    await ctx.pool.query(`UPDATE applications SET applied_at = now() - interval '10 days' WHERE id = $1`, [slow]);

    expect((await analytics()).medianDaysToResponse).toBe(7);
  });

  it('counts applications sent to likely ghost jobs', async () => {
    const view = await ctx.app.inject({
      method: 'POST',
      url: '/v1/sightings',
      headers: user.headers,
      payload: sightingInput(),
    });
    const badge = view.json<BadgeResponse>();
    await ctx.app.inject({
      method: 'POST',
      url: '/v1/applications',
      headers: user.headers,
      payload: { postingId: badge.postingId, stage: 'applied' },
    });
    await ctx.pool.query(`UPDATE job_clusters SET ghost_level = 'likely_ghost' WHERE id = $1`, [badge.clusterId]);

    expect((await analytics()).appliedToLikelyGhosts).toBe(1);
  });
});
