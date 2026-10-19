import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, createUser, sightingInput, type TestContext } from './helpers.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestApp({ sightingsPerMinute: 3, installsPerHour: 4 });
});
afterAll(async () => {
  await ctx.close();
});

describe('rate limits', () => {
  it('budgets sightings per token', async () => {
    const alice = await createUser(ctx);
    const bob = await createUser(ctx);
    const send = (headers: Record<string, string>) =>
      ctx.app.inject({ method: 'POST', url: '/v1/sightings', headers, payload: sightingInput() });

    for (let i = 0; i < 3; i += 1) expect((await send(alice.headers)).statusCode).toBe(200);
    const limited = await send(alice.headers);
    expect(limited.statusCode).toBe(429);
    expect(limited.json().error.code).toBe('rate_limited');
    expect(limited.headers['retry-after']).toBeDefined();

    // Bob has his own budget.
    expect((await send(bob.headers)).statusCode).toBe(200);
  });

  it('limits new installs per IP', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      statuses.push((await ctx.app.inject({ method: 'POST', url: '/v1/installs' })).statusCode);
    }
    // Two installs were already used by the previous test.
    expect(statuses).toEqual([201, 201, 429]);
  });

  it('never limits health checks', async () => {
    for (let i = 0; i < 5; i += 1) {
      expect((await ctx.app.inject({ url: '/healthz' })).statusCode).toBe(200);
    }
  });
});
