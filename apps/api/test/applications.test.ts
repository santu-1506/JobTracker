import type { Application, ApplicationDetail, BadgeResponse, MeResponse } from '@jobtracker/core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, createUser, resetData, sightingInput, type TestContext, type TestUser } from './helpers.js';

let ctx: TestContext;
let alice: TestUser;

beforeAll(async () => {
  ctx = await createTestApp();
});
afterAll(async () => {
  await ctx.close();
});
beforeEach(async () => {
  await resetData(ctx.pool);
  alice = await createUser(ctx);
});

async function viewJob(user: TestUser, overrides = {}): Promise<BadgeResponse> {
  const response = await ctx.app.inject({
    method: 'POST',
    url: '/v1/sightings',
    headers: user.headers,
    payload: sightingInput(overrides),
  });
  return response.json<BadgeResponse>();
}

async function save(user: TestUser, payload: object) {
  return ctx.app.inject({ method: 'POST', url: '/v1/applications', headers: user.headers, payload });
}

async function patch(user: TestUser, id: string, payload: object) {
  return ctx.app.inject({ method: 'PATCH', url: `/v1/applications/${id}`, headers: user.headers, payload });
}

describe('saving jobs', () => {
  it('saves a viewed job in one click with its ghost verdict', async () => {
    const badge = await viewJob(alice);
    const response = await save(alice, { postingId: badge.postingId });

    expect(response.statusCode).toBe(201);
    const application = response.json<Application>();
    expect(application).toMatchObject({
      stage: 'saved',
      company: 'Acme, Inc.',
      title: 'Senior Backend Engineer',
      clusterId: badge.clusterId,
      ghost: { level: 'unknown' },
    });
  });

  it('is idempotent across boards for the same real job', async () => {
    const linkedin = await viewJob(alice);
    const greenhouse = await viewJob(alice, { source: 'greenhouse', company: 'Acme', location: 'Bangalore' });
    expect(greenhouse.clusterId).toBe(linkedin.clusterId);

    const first = await save(alice, { postingId: linkedin.postingId });
    const second = await save(alice, { postingId: greenhouse.postingId });
    expect(second.statusCode).toBe(200);
    expect(second.json<Application>().id).toBe(first.json<Application>().id);
  });

  it('shows the tracked application on the badge', async () => {
    const badge = await viewJob(alice, { sourceJobId: 'tracked-job' });
    await save(alice, { postingId: badge.postingId, stage: 'applied' });
    const again = await viewJob(alice, { sourceJobId: 'tracked-job' });
    expect(again.application?.stage).toBe('applied');
  });

  it('accepts manual entries for jobs found elsewhere', async () => {
    const response = await save(alice, { company: 'Initech', title: 'Platform Engineer', stage: 'applied' });
    expect(response.statusCode).toBe(201);
    expect(response.json<Application>().appliedAt).not.toBeNull();
  });

  it('requires company and title for manual entries', async () => {
    const response = await save(alice, { title: 'Platform Engineer' });
    expect(response.statusCode).toBe(400);
  });

  it('404s for an unknown posting', async () => {
    const response = await save(alice, { postingId: '00000000-0000-0000-0000-000000000000' });
    expect(response.statusCode).toBe(404);
  });
});

describe('moving through stages', () => {
  it('records stage history and sets follow-up reminders', async () => {
    const created = (await save(alice, { company: 'Initech', title: 'SRE' })).json<Application>();
    expect(created.nextActionAt).toBeNull();

    const applied = (await patch(alice, created.id, { stage: 'applied' })).json<Application>();
    expect(applied.appliedAt).not.toBeNull();
    expect(applied.nextActionNote).toBe('Follow up if you have not heard back');
    const days = (Date.parse(applied.nextActionAt!) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThan(7.1);

    await patch(alice, created.id, { stage: 'interview' });
    const rejected = (await patch(alice, created.id, { stage: 'rejected', notes: 'Went with an internal candidate' })).json<Application>();
    expect(rejected.nextActionAt).toBeNull();
    expect(rejected.appliedAt).toBe(applied.appliedAt);

    const detail = (
      await ctx.app.inject({ url: `/v1/applications/${created.id}`, headers: alice.headers })
    ).json<ApplicationDetail>();
    expect(detail.events.map((e) => `${e.fromStage}->${e.toStage}`)).toEqual([
      'null->saved',
      'saved->applied',
      'applied->interview',
      'interview->rejected',
    ]);
    expect(detail.notes).toBe('Went with an internal candidate');
  });

  it('lets the user snooze or clear a reminder', async () => {
    const created = (await save(alice, { company: 'Initech', title: 'SRE', stage: 'applied' })).json<Application>();
    const snoozed = (
      await patch(alice, created.id, { nextActionAt: '2030-01-01T09:00:00Z', nextActionNote: 'Ping recruiter' })
    ).json<Application>();
    expect(snoozed.nextActionAt).toBe('2030-01-01T09:00:00.000Z');

    const cleared = (await patch(alice, created.id, { nextActionAt: null })).json<Application>();
    expect(cleared.nextActionAt).toBeNull();
  });

  it('rejects empty and invalid patches', async () => {
    const created = (await save(alice, { company: 'Initech', title: 'SRE' })).json<Application>();
    expect((await patch(alice, created.id, {})).statusCode).toBe(400);
    expect((await patch(alice, created.id, { stage: 'hired' })).statusCode).toBe(400);
  });
});

describe('listing and privacy', () => {
  it('filters by stage', async () => {
    await save(alice, { company: 'A', title: 'One', stage: 'applied' });
    await save(alice, { company: 'B', title: 'Two' });
    const response = await ctx.app.inject({ url: '/v1/applications?stage=applied', headers: alice.headers });
    expect(response.json<{ applications: Application[] }>().applications.map((a) => a.company)).toEqual(['A']);
  });

  it('never exposes another user’s applications', async () => {
    const created = (await save(alice, { company: 'Initech', title: 'SRE' })).json<Application>();
    const mallory = await createUser(ctx);

    expect((await ctx.app.inject({ url: `/v1/applications/${created.id}`, headers: mallory.headers })).statusCode).toBe(404);
    expect((await patch(mallory, created.id, { stage: 'withdrawn' })).statusCode).toBe(404);
    const list = await ctx.app.inject({ url: '/v1/applications', headers: mallory.headers });
    expect(list.json<{ applications: Application[] }>().applications).toEqual([]);
  });

  it('deletes', async () => {
    const created = (await save(alice, { company: 'Initech', title: 'SRE' })).json<Application>();
    const url = `/v1/applications/${created.id}`;
    expect((await ctx.app.inject({ method: 'DELETE', url, headers: alice.headers })).statusCode).toBe(204);
    expect((await ctx.app.inject({ method: 'DELETE', url, headers: alice.headers })).statusCode).toBe(404);
  });
});

describe('plan limits', () => {
  async function fillTracker(user: TestUser, count: number) {
    await ctx.pool.query(
      `INSERT INTO applications (user_id, company, title)
       SELECT $1, 'Company ' || n, 'Role ' || n FROM generate_series(1, $2) AS n`,
      [user.id, count],
    );
  }

  it('caps the free tracker at 25 jobs', async () => {
    await fillTracker(alice, 25);
    const response = await save(alice, { company: 'One', title: 'Too many' });
    expect(response.statusCode).toBe(402);
    expect(response.json().error.code).toBe('plan_limit');

    const me = (await ctx.app.inject({ url: '/v1/me', headers: alice.headers })).json<MeResponse>();
    expect(me.usage.applications).toBe(25);
  });

  it('still lets free users open jobs they already track', async () => {
    const badge = await viewJob(alice);
    await save(alice, { postingId: badge.postingId });
    await fillTracker(alice, 24);
    expect((await save(alice, { postingId: badge.postingId })).statusCode).toBe(200);
  });

  it('has no cap on Pro', async () => {
    const pro = await createUser(ctx, 'pro');
    await fillTracker(pro, 30);
    expect((await save(pro, { company: 'One', title: 'More' })).statusCode).toBe(201);
  });
});
