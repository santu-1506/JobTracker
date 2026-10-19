import type { Queryable } from '../db/pool.js';

export interface Job<Payload = Record<string, unknown>> {
  id: string;
  queue: string;
  payload: Payload;
  attempts: number;
  maxAttempts: number;
}

interface JobRow {
  id: string;
  queue: string;
  payload: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
}

export interface EnqueueOptions {
  runAt?: Date;
  maxAttempts?: number;
}

const MAX_RETRY_DELAY_MS = 60 * 60 * 1000;

export async function enqueue(
  db: Queryable,
  queue: string,
  payload: Record<string, unknown> = {},
  options: EnqueueOptions = {},
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO jobs (queue, payload, run_at, max_attempts)
     VALUES ($1, $2, COALESCE($3, now()), $4)
     RETURNING id`,
    [queue, JSON.stringify(payload), options.runAt ?? null, options.maxAttempts ?? 5],
  );
  return rows[0]!.id;
}

/**
 * Atomically claims up to `limit` due jobs. SKIP LOCKED makes concurrent
 * workers pass over rows another worker is claiming instead of waiting.
 */
export async function claimJobs(db: Queryable, workerId: string, limit: number): Promise<Job[]> {
  const { rows } = await db.query<JobRow>(
    `UPDATE jobs
        SET locked_at = now(), locked_by = $1, attempts = attempts + 1
      WHERE id IN (
        SELECT id FROM jobs
         WHERE locked_at IS NULL AND failed_at IS NULL AND run_at <= now()
         ORDER BY run_at, id
         LIMIT $2
         FOR UPDATE SKIP LOCKED
      )
      RETURNING id, queue, payload, attempts, max_attempts`,
    [workerId, limit],
  );
  return rows.map((row) => ({
    id: row.id,
    queue: row.queue,
    payload: row.payload,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
  }));
}

export async function completeJob(db: Queryable, id: string): Promise<void> {
  await db.query('DELETE FROM jobs WHERE id = $1', [id]);
}

/** 10s, 20s, 40s ... capped at an hour. */
export function retryDelayMs(attempts: number): number {
  return Math.min(MAX_RETRY_DELAY_MS, 5_000 * 2 ** attempts);
}

/** Schedules a retry with exponential backoff, or parks the job as failed. */
export async function failJob(db: Queryable, job: Job, error: unknown): Promise<'retry' | 'failed'> {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  if (job.attempts >= job.maxAttempts) {
    await db.query(
      'UPDATE jobs SET locked_at = NULL, locked_by = NULL, failed_at = now(), last_error = $2 WHERE id = $1',
      [job.id, message],
    );
    return 'failed';
  }
  await db.query(
    `UPDATE jobs
        SET locked_at = NULL, locked_by = NULL, last_error = $2,
            run_at = now() + make_interval(secs => $3)
      WHERE id = $1`,
    [job.id, message, retryDelayMs(job.attempts) / 1000],
  );
  return 'retry';
}

/** Frees jobs whose worker died mid-run so another worker can pick them up. */
export async function releaseStaleLocks(db: Queryable, olderThanMs: number): Promise<number> {
  const result = await db.query(
    `UPDATE jobs SET locked_at = NULL, locked_by = NULL
      WHERE locked_at < now() - make_interval(secs => $1)`,
    [olderThanMs / 1000],
  );
  return result.rowCount ?? 0;
}

/**
 * Enqueues `queue` once per period across all workers. Returns true for the
 * single caller that won the period.
 */
export async function enqueueForPeriod(
  db: Queryable,
  scheduleName: string,
  period: string,
  queue: string,
  payload: Record<string, unknown> = {},
): Promise<boolean> {
  const { rows } = await db.query<{ id: string }>(
    `WITH won AS (
       INSERT INTO job_schedules (name, last_period) VALUES ($1, $2)
       ON CONFLICT (name) DO UPDATE
         SET last_period = EXCLUDED.last_period, updated_at = now()
         WHERE job_schedules.last_period IS DISTINCT FROM EXCLUDED.last_period
       RETURNING name
     )
     INSERT INTO jobs (queue, payload)
     SELECT $3, $4 FROM won
     RETURNING id`,
    [scheduleName, period, queue, JSON.stringify(payload)],
  );
  return rows.length > 0;
}

export interface QueueStats {
  ready: number;
  running: number;
  scheduled: number;
  failed: number;
}

export async function queueStats(db: Queryable): Promise<QueueStats> {
  const { rows } = await db.query<QueueStats>(
    `SELECT count(*) FILTER (WHERE failed_at IS NULL AND locked_at IS NULL AND run_at <= now())::int AS ready,
            count(*) FILTER (WHERE locked_at IS NOT NULL)::int AS running,
            count(*) FILTER (WHERE failed_at IS NULL AND locked_at IS NULL AND run_at > now())::int AS scheduled,
            count(*) FILTER (WHERE failed_at IS NOT NULL)::int AS failed
       FROM jobs`,
  );
  return rows[0]!;
}
