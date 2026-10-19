CREATE TYPE application_stage AS ENUM (
  'saved', 'applied', 'oa', 'interview', 'offer', 'rejected', 'ghosted', 'withdrawn'
);

CREATE TABLE applications (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  cluster_id       uuid REFERENCES job_clusters (id) ON DELETE SET NULL,
  posting_id       uuid REFERENCES postings (id) ON DELETE SET NULL,
  company          text NOT NULL,
  title            text NOT NULL,
  location         text,
  url              text,
  stage            application_stage NOT NULL DEFAULT 'saved',
  notes            text NOT NULL DEFAULT '',
  applied_at       timestamptz,
  next_action_at   timestamptz,
  next_action_note text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- One tracker entry per real job per user, so saving from LinkedIn and
-- then from Greenhouse does not create duplicates.
CREATE UNIQUE INDEX applications_user_cluster_uidx ON applications (user_id, cluster_id) WHERE cluster_id IS NOT NULL;
CREATE INDEX applications_user_updated_idx ON applications (user_id, updated_at DESC);
CREATE INDEX applications_due_idx ON applications (next_action_at) WHERE next_action_at IS NOT NULL;

-- Stage history powers the analytics (time to first response, funnel).
CREATE TABLE application_events (
  id             bigserial PRIMARY KEY,
  application_id uuid NOT NULL REFERENCES applications (id) ON DELETE CASCADE,
  from_stage     application_stage,
  to_stage       application_stage NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX application_events_app_idx ON application_events (application_id, created_at);

-- Cached human-readable verdict, so tracker lists do not rescore every row.
ALTER TABLE job_clusters ADD COLUMN ghost_label text NOT NULL DEFAULT '';
