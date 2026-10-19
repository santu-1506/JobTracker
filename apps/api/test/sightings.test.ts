import type { BadgeResponse, ClusterHistory } from '@jobtracker/core';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { isRefresh, sanitizeClaim } from '../src/services/ingest.js';
import {
  createTestApp,
  createUser,
  daysAgo,
  resetData,
  sightingInput,
  type TestContext,
  type TestUser,
} from './helpers.js';

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

async function view(user: TestUser, payload: object): Promise<BadgeResponse> {
  const response = await ctx.app.inject({ method: 'POST', url: '/v1/sightings', headers: user.headers, payload });
  expect(response.statusCode, response.body).toBe(200);
  return response.json<BadgeResponse>();
}

async function count(table: string): Promise<number> {
  const { rows } = await ctx.pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`);
  return rows[0]!.n;
}

describe('POST /v1/sightings', () => {
  it('requires a token', async () => {
    const response = await ctx.app.inject({ method: 'POST', url: '/v1/sightings', payload: sightingInput() });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.code).toBe('unauthorized');
  });

  it('rejects malformed input with field-level details', async () => {
    const response = await ctx.app.inject({
      method: 'POST',
      url: '/v1/sightings',
      headers: alice.headers,
      payload: { ...sightingInput(), url: 'javascript:alert(1)', descriptionHash: 'nope' },
    });
    expect(response.statusCode).toBe(400);
    const paths = response.json().error.details.map((d: { path: string }) => d.path);
    expect(paths).toEqual(expect.arrayContaining(['url', 'descriptionHash']));
  });

  it('starts a new cluster with no verdict on the first sighting', async () => {
    const badge = await view(alice, sightingInput());
    expect(badge.assessment.level).toBe('unknown');
    expect(badge.sources).toEqual(['linkedin']);
    expect(badge.viewerCount).toBe(1);
  });

  it('joins the same job seen on another board into one cluster', async () => {
    const linkedin = await view(alice, sightingInput({ title: 'Sr. Backend Engineer' }));
    const greenhouse = await view(
      alice,
      sightingInput({
        source: 'greenhouse',
        title: 'Senior Backend Engineer (Hybrid)',
        company: 'Acme',
        location: 'Bangalore',
        url: 'https://boards.greenhouse.io/acme/jobs/1',
      }),
    );
    expect(greenhouse.clusterId).toBe(linkedin.clusterId);
    expect(greenhouse.postingId).not.toBe(linkedin.postingId);
    expect(greenhouse.sources).toEqual(['greenhouse', 'linkedin']);
    expect(greenhouse.assessment.repostCount).toBe(0);
    expect(greenhouse.viewerCount).toBe(1);
  });

  it('keeps the same title in a different city separate', async () => {
    const bengaluru = await view(alice, sightingInput());
    const london = await view(alice, sightingInput({ location: 'London, UK' }));
    expect(london.clusterId).not.toBe(bengaluru.clusterId);
  });

  it('counts one sighting per user per day and one viewer per user', async () => {
    const input = sightingInput();
    await view(alice, input);
    await view(alice, input);
    const bob = await createUser(ctx);
    const badge = await view(bob, input);

    expect(badge.viewerCount).toBe(2);
    expect(await count('sightings')).toBe(2);
  });

  it('counts a new listing id on the same board as a repost', async () => {
    await view(alice, sightingInput({ sourceJobId: 'first-listing' }));
    const badge = await view(alice, sightingInput({ sourceJobId: 'second-listing' }));
    expect(badge.assessment.repostCount).toBe(1);
    expect(badge.assessment.level).toBe('reposted');
    expect(badge.assessment.label).toBe('Reposted 1×');
  });

  it('counts a bumped posted date as a repost', async () => {
    const input = sightingInput({ postedAt: daysAgo(40).toISOString() });
    await view(alice, input);
    const badge = await view(alice, { ...input, postedAt: daysAgo(1).toISOString() });
    expect(badge.assessment.repostCount).toBe(1);
    expect(badge.assessment.reasons.map((r) => r.code)).toContain('reposts');
  });

  it('flags a job first seen 94 days ago as a likely ghost', async () => {
    const input = sightingInput();
    const first = await view(alice, input);
    await ctx.pool.query(`UPDATE job_clusters SET first_seen_at = now() - interval '94 days' WHERE id = $1`, [
      first.clusterId,
    ]);
    const badge = await view(alice, input);
    expect(badge.assessment.level).toBe('likely_ghost');
    expect(badge.assessment.label).toBe('Likely ghost: first seen 94 days ago');

    const { rows } = await ctx.pool.query('SELECT ghost_level FROM job_clusters WHERE id = $1', [first.clusterId]);
    expect(rows[0].ghost_level).toBe('likely_ghost');
  });

  it('ignores absurd posted-date claims', async () => {
    const badge = await view(alice, sightingInput({ postedAt: '2015-01-01T00:00:00Z' }));
    expect(badge.assessment.level).toBe('unknown');
  });

  it('creates exactly one cluster when many users open a new job at once', async () => {
    const users = await Promise.all(Array.from({ length: 10 }, () => createUser(ctx)));
    const input = sightingInput({ sourceJobId: 'hot-new-job' });
    const badges = await Promise.all(users.map((user) => view(user, input)));

    expect(new Set(badges.map((b) => b.clusterId)).size).toBe(1);
    expect(await count('postings')).toBe(1);
    expect(await count('job_clusters')).toBe(1);
    const { rows } = await ctx.pool.query('SELECT viewer_count FROM job_clusters');
    expect(rows[0].viewer_count).toBe(10);
  });
});

describe('GET /v1/clusters/:id', () => {
  it('returns postings and the viewer timeline', async () => {
    const badge = await view(alice, sightingInput());
    const response = await ctx.app.inject({ url: `/v1/clusters/${badge.clusterId}`, headers: alice.headers });
    expect(response.statusCode).toBe(200);
    const history = response.json<ClusterHistory>();
    expect(history.postings).toHaveLength(1);
    expect(history.timeline).toHaveLength(1);
    expect(history.timeline[0]!.viewers).toBe(1);
  });

  it('404s for an unknown cluster', async () => {
    const response = await ctx.app.inject({
      url: '/v1/clusters/00000000-0000-0000-0000-000000000000',
      headers: alice.headers,
    });
    expect(response.statusCode).toBe(404);
  });
});

describe('ingest helpers', () => {
  const now = new Date('2026-10-17T00:00:00Z');
  const ago = (days: number) => new Date(now.getTime() - days * 86_400_000);

  it('detects bumped posted dates but tolerates relative-date rounding', () => {
    expect(isRefresh(ago(40), ago(1), now)).toBe(true);
    expect(isRefresh(ago(21), ago(14), now)).toBe(false);
    expect(isRefresh(ago(40), ago(20), now)).toBe(false);
    expect(isRefresh(null, ago(1), now)).toBe(false);
  });

  it('drops future and ancient claims', () => {
    expect(sanitizeClaim(ago(10).toISOString(), now)).toEqual(ago(10));
    expect(sanitizeClaim(ago(-5).toISOString(), now)).toBeNull();
    expect(sanitizeClaim(ago(1000).toISOString(), now)).toBeNull();
    expect(sanitizeClaim('not a date', now)).toBeNull();
  });
});
