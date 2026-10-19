-- A small durable job queue. Workers claim rows with FOR UPDATE SKIP LOCKED,
-- so any number of workers can poll the same table without double-processing.
CREATE TABLE jobs (
  id           bigserial PRIMARY KEY,
  queue        text NOT NULL,
  payload      jsonb NOT NULL DEFAULT '{}',
  run_at       timestamptz NOT NULL DEFAULT now(),
  attempts     integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 5,
  locked_at    timestamptz,
  locked_by    text,
  last_error   text,
  failed_at    timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX jobs_ready_idx ON jobs (run_at) WHERE locked_at IS NULL AND failed_at IS NULL;
CREATE INDEX jobs_locked_idx ON jobs (locked_at) WHERE locked_at IS NOT NULL;

-- Recurring jobs: a worker enqueues a run only if it is the first to claim
-- the current period, so N workers still produce one run per period.
CREATE TABLE job_schedules (
  name        text PRIMARY KEY,
  last_period text NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
