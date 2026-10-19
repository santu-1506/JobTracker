import type { Application, BadgeResponse, Reminder } from '@jobtracker/core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  GHOST_WARNING_NOTE,
  NO_RESPONSE_NOTE,
  RESCORE_BATCH_SIZE,
  defaultHandlers,
} from '../src/jobs/handlers.js';
import { enqueue, queueStats } from '../src/jobs/queue.js';
import { Worker } from '../src/jobs/worker.js';
import { createTestApp, createUser, resetData, sightingInput, type TestContext, type TestUser } from './helpers.js';

let ctx: TestContext;
let worker: Worker;
const silent = { info() {}, warn() {}, error() {}, debug() {} };

beforeAll(async () => {
  ctx = await createTestApp();
  worker = new Worker({ pool: ctx.pool, handlers: defaultHandlers, log: silent, batchSize: 50 });
});
afterAll(async () => {
  await ctx.close();
});
beforeEach(async () => {
  await resetData(ctx.pool);
});

async function drain(): Promise<void> {
  while ((await worker.tick()) > 0) {
    // keep going until chained jobs are done
  }
}

async function viewJob(user: TestUser, overrides = {}): Promise<BadgeResponse> {
  const response = await ctx.app.inject({
    method: 'POST',
    url: '/v1/sightings',
    headers: user.headers,
    payload: sightingInput(overrides),
  });
  return response.json<BadgeResponse>();
}

describe('clusters.rescore', () => {
  it('ages clusters into likely ghosts without anyone viewing them', async () => {
    const user = await createUser(ctx);
    const badge = await viewJob(user);
    await ctx.pool.query(`UPDATE job_clusters SET first_seen_at = now() - interval '120 days' WHERE id = $1`, [
      badge.clusterId,
    ]);

    await enqueue(ctx.pool, 'clusters.rescore');
    await drain();

    const { rows } = await ctx.pool.query('SELECT ghost_level, ghost_label FROM job_clusters WHERE id = $1', [
      badge.clusterId,
    ]);
    expect(rows[0]).toEqual({ ghost_level: 'likely_ghost', ghost_label: 'Likely ghost: first seen 120 days ago' });
  });

  it('pages through large tables in chained batches', async () => {
    const total = RESCORE_BATCH_SIZE + 20;
    await ctx.pool.query(
      `INSERT INTO job_clusters (company, title, company_key, title_key, first_seen_at)
       SELECT 'Co', 'Role ' || n, 'co', 'role ' || n, now() - interval '100 days'
         FROM generate_series(1, $1) AS n`,
      [total],
    );

    await enqueue(ctx.pool, 'clusters.rescore');
    await drain();

    const { rows } = await ctx.pool.query(
      `SELECT count(*)::int AS n FROM job_clusters WHERE ghost_level = 'likely_ghost'`,
    );
    expect(rows[0].n).toBe(total);
    expect(await queueStats(ctx.pool)).toMatchObject({ ready: 0, failed: 0 });
  });
});

describe('applications.followups', () => {
  it('nudges once about applications with no response for 30 days', async () => {
    const user = await createUser(ctx, 'pro');
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/v1/applications',
      headers: user.headers,
      payload: { company: 'Initech', title: 'SRE', stage: 'applied' },
    });
    const id = created.json<Application>().id;
    await ctx.pool.query(
      `UPDATE applications SET applied_at = now() - interval '31 days', updated_at = now() - interval '31 days',
              next_action_at = NULL WHERE id = $1`,
      [id],
    );

    await enqueue(ctx.pool, 'applications.followups');
    await drain();

    const due = await ctx.app.inject({ url: '/v1/reminders/due', headers: user.headers });
    expect(due.statusCode).toBe(200);
    expect(due.json<{ reminders: Reminder[] }>().reminders).toEqual([
      expect.objectContaining({ applicationId: id, note: NO_RESPONSE_NOTE }),
    ]);

    // The user dismisses it; the next run must not nag again.
    await ctx.pool.query('UPDATE applications SET next_action_at = NULL WHERE id = $1', [id]);
    await enqueue(ctx.pool, 'applications.followups');
    await drain();
    const again = await ctx.app.inject({ url: '/v1/reminders/due', headers: user.headers });
    expect(again.json<{ reminders: Reminder[] }>().reminders).toEqual([]);
  });

  it('warns when a saved job turns into a likely ghost', async () => {
    const user = await createUser(ctx, 'pro');
    const badge = await viewJob(user);
    await ctx.app.inject({
      method: 'POST',
      url: '/v1/applications',
      headers: user.headers,
      payload: { postingId: badge.postingId },
    });
    await ctx.pool.query(
      `UPDATE job_clusters SET first_seen_at = now() - interval '100 days' WHERE id = $1`,
      [badge.clusterId],
    );

    await enqueue(ctx.pool, 'clusters.rescore');
    await enqueue(ctx.pool, 'applications.followups', {}, { runAt: new Date(Date.now() + 10) });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await drain();

    const due = await ctx.app.inject({ url: '/v1/reminders/due', headers: user.headers });
    expect(due.json<{ reminders: Reminder[] }>().reminders.map((r) => r.note)).toEqual([GHOST_WARNING_NOTE]);
  });
});

describe('GET /v1/reminders/due', () => {
  it('is a Pro feature', async () => {
    const free = await createUser(ctx);
    const response = await ctx.app.inject({ url: '/v1/reminders/due', headers: free.headers });
    expect(response.statusCode).toBe(402);
    expect(response.json().error.code).toBe('plan_required');
  });

  it('skips reminders that are not due yet or belong to closed applications', async () => {
    const user = await createUser(ctx, 'pro');
    await ctx.pool.query(
      `INSERT INTO applications (user_id, company, title, stage, next_action_at, next_action_note) VALUES
         ($1, 'Due', 'Role', 'applied', now() - interval '1 hour', 'Follow up'),
         ($1, 'Later', 'Role', 'applied', now() + interval '1 day', 'Follow up'),
         ($1, 'Closed', 'Role', 'rejected', now() - interval '1 hour', 'Follow up')`,
      [user.id],
    );
    const response = await ctx.app.inject({ url: '/v1/reminders/due', headers: user.headers });
    expect(response.json<{ reminders: Reminder[] }>().reminders.map((r) => r.company)).toEqual(['Due']);
  });
});
