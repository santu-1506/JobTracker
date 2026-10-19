import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  claimJobs,
  enqueue,
  enqueueForPeriod,
  queueStats,
  releaseStaleLocks,
  retryDelayMs,
} from '../src/jobs/queue.js';
import { Worker, periodKey, type JobHandler } from '../src/jobs/worker.js';
import { createTestApp, resetData, type TestContext } from './helpers.js';

let ctx: TestContext;
const silent = { info() {}, warn() {}, error() {}, debug() {} };

beforeAll(async () => {
  ctx = await createTestApp();
});
afterAll(async () => {
  await ctx.close();
});
beforeEach(async () => {
  await resetData(ctx.pool);
});

function worker(handlers: Record<string, JobHandler>, extra: Partial<ConstructorParameters<typeof Worker>[0]> = {}) {
  return new Worker({ pool: ctx.pool, handlers, log: silent, ...extra });
}

describe('job queue', () => {
  it('runs a job once and removes it', async () => {
    const seen: unknown[] = [];
    await enqueue(ctx.pool, 'echo', { hello: 'world' });
    const w = worker({ echo: async (job) => void seen.push(job.payload) });

    expect(await w.tick()).toBe(1);
    expect(await w.tick()).toBe(0);
    expect(seen).toEqual([{ hello: 'world' }]);
    expect(await queueStats(ctx.pool)).toEqual({ ready: 0, running: 0, scheduled: 0, failed: 0 });
  });

  it('never hands the same job to two concurrent workers', async () => {
    await Promise.all(Array.from({ length: 50 }, (_, i) => enqueue(ctx.pool, 'noop', { i })));
    const batches = await Promise.all(
      Array.from({ length: 5 }, (_, i) => claimJobs(ctx.pool, `worker-${i}`, 20)),
    );
    const ids = batches.flat().map((job) => job.id);
    expect(ids).toHaveLength(50);
    expect(new Set(ids).size).toBe(50);
  });

  it('does not run jobs scheduled for the future', async () => {
    await enqueue(ctx.pool, 'later', {}, { runAt: new Date(Date.now() + 60_000) });
    expect(await worker({ later: async () => {} }).tick()).toBe(0);
    expect((await queueStats(ctx.pool)).scheduled).toBe(1);
  });

  it('retries failures with backoff, then parks them as failed', async () => {
    await enqueue(ctx.pool, 'flaky', {}, { maxAttempts: 2 });
    const w = worker({
      flaky: async () => {
        throw new Error('upstream timeout');
      },
    });

    await w.tick();
    let { rows } = await ctx.pool.query('SELECT attempts, last_error, run_at > now() AS backed_off, failed_at FROM jobs');
    expect(rows[0]).toMatchObject({ attempts: 1, last_error: 'Error: upstream timeout', backed_off: true, failed_at: null });

    await ctx.pool.query('UPDATE jobs SET run_at = now()');
    await w.tick();
    ({ rows } = await ctx.pool.query('SELECT attempts, failed_at FROM jobs'));
    expect(rows[0].attempts).toBe(2);
    expect(rows[0].failed_at).not.toBeNull();
    expect((await queueStats(ctx.pool)).failed).toBe(1);
  });

  it('fails jobs with no registered handler', async () => {
    await enqueue(ctx.pool, 'mystery', {}, { maxAttempts: 1 });
    await worker({}).tick();
    const { rows } = await ctx.pool.query('SELECT last_error FROM jobs');
    expect(rows[0].last_error).toContain('No handler registered for queue "mystery"');
  });

  it('recovers jobs locked by a crashed worker', async () => {
    await enqueue(ctx.pool, 'noop');
    await claimJobs(ctx.pool, 'crashed-worker', 1);
    await ctx.pool.query(`UPDATE jobs SET locked_at = now() - interval '1 hour'`);
    expect(await releaseStaleLocks(ctx.pool, 15 * 60_000)).toBe(1);
    expect(await worker({ noop: async () => {} }).tick()).toBe(1);
  });

  it('backs off exponentially up to an hour', () => {
    expect(retryDelayMs(1)).toBe(10_000);
    expect(retryDelayMs(2)).toBe(20_000);
    expect(retryDelayMs(20)).toBe(3_600_000);
  });
});

describe('recurring schedules', () => {
  it('enqueues one run per period no matter how many workers race', async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, () => enqueueForPeriod(ctx.pool, 'hourly-rescore', '60:1', 'clusters.rescore')),
    );
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await enqueueForPeriod(ctx.pool, 'hourly-rescore', '60:1', 'clusters.rescore')).toBe(false);
    expect(await enqueueForPeriod(ctx.pool, 'hourly-rescore', '60:2', 'clusters.rescore')).toBe(true);
    expect((await queueStats(ctx.pool)).ready).toBe(2);
  });

  it('runs scheduled handlers from the worker tick', async () => {
    let runs = 0;
    const w = worker({ ping: async () => void (runs += 1) }, { schedules: [{ name: 'ping', queue: 'ping', everyMinutes: 5 }] });
    const now = new Date('2026-10-17T10:00:00Z');
    await w.tick(now);
    await w.tick(now);
    expect(runs).toBe(1);
  });

  it('derives stable period keys', () => {
    const a = new Date('2026-10-17T10:05:00Z');
    const b = new Date('2026-10-17T10:55:00Z');
    expect(periodKey(a, 60)).toBe(periodKey(b, 60));
    expect(periodKey(a, 5)).not.toBe(periodKey(b, 5));
  });
});
