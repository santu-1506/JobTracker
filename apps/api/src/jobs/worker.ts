import { hostname } from 'node:os';
import type { FastifyBaseLogger } from 'fastify';
import type { Pool } from '../db/pool.js';
import { claimJobs, completeJob, enqueueForPeriod, failJob, releaseStaleLocks, type Job } from './queue.js';

export interface JobContext {
  pool: Pool;
  log: Pick<FastifyBaseLogger, 'info' | 'warn' | 'error' | 'debug'>;
  now: Date;
}

export type JobHandler = (job: Job, context: JobContext) => Promise<void>;

export interface Schedule {
  /** Unique name; also the dedupe key across workers. */
  name: string;
  queue: string;
  everyMinutes: number;
  payload?: Record<string, unknown>;
}

export interface WorkerOptions {
  pool: Pool;
  handlers: Record<string, JobHandler>;
  schedules?: Schedule[];
  log: JobContext['log'];
  pollIntervalMs?: number;
  batchSize?: number;
  staleLockMs?: number;
  workerId?: string;
}

/** Identifies the period a timestamp falls in, e.g. "60:493512" for hourly. */
export function periodKey(now: Date, everyMinutes: number): string {
  return `${everyMinutes}:${Math.floor(now.getTime() / (everyMinutes * 60_000))}`;
}

export class Worker {
  readonly id: string;
  private readonly options: Required<Omit<WorkerOptions, 'workerId'>>;
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<unknown> | null = null;
  private stopped = true;

  constructor(options: WorkerOptions) {
    this.id = options.workerId ?? `${hostname()}:${process.pid}:${Math.random().toString(36).slice(2, 8)}`;
    this.options = {
      schedules: [],
      pollIntervalMs: 1_000,
      batchSize: 10,
      staleLockMs: 15 * 60_000,
      ...options,
    };
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.options.log.info({ workerId: this.id }, 'worker started');
    this.loop();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    await this.running;
    this.options.log.info({ workerId: this.id }, 'worker stopped');
  }

  /** One pass: enqueue due schedules, recover stale locks, run a batch. Returns jobs processed. */
  async tick(now: Date = new Date()): Promise<number> {
    const { pool, schedules, batchSize, staleLockMs, log } = this.options;

    for (const schedule of schedules) {
      const won = await enqueueForPeriod(
        pool,
        schedule.name,
        periodKey(now, schedule.everyMinutes),
        schedule.queue,
        schedule.payload,
      );
      if (won) log.debug({ schedule: schedule.name }, 'scheduled job enqueued');
    }

    const released = await releaseStaleLocks(pool, staleLockMs);
    if (released > 0) log.warn({ released }, 'released stale job locks');

    const jobs = await claimJobs(pool, this.id, batchSize);
    for (const job of jobs) await this.run(job, now);
    return jobs.length;
  }

  private async run(job: Job, now: Date): Promise<void> {
    const { pool, handlers, log } = this.options;
    const handler = handlers[job.queue];
    const started = Date.now();
    try {
      if (!handler) throw new Error(`No handler registered for queue "${job.queue}"`);
      await handler(job, { pool, log, now });
      await completeJob(pool, job.id);
      log.info({ jobId: job.id, queue: job.queue, ms: Date.now() - started }, 'job completed');
    } catch (error) {
      const outcome = await failJob(pool, job, error);
      log.error({ jobId: job.id, queue: job.queue, attempt: job.attempts, outcome, err: error }, 'job failed');
    }
  }

  private loop(): void {
    if (this.stopped) return;
    this.running = this.tick()
      .catch((error: unknown) => this.options.log.error({ err: error }, 'worker tick failed'))
      .then((processed) => {
        if (this.stopped) return;
        // Drain quickly while there is work; otherwise wait for the next poll.
        const delay = typeof processed === 'number' && processed >= this.options.batchSize ? 0 : this.options.pollIntervalMs;
        this.timer = setTimeout(() => this.loop(), delay);
      });
  }
}
