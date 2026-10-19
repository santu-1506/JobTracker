-- A cluster is one real-world job. It groups every posting of that job:
-- the same role cross-posted to several boards, and re-listings under new ids.
CREATE TABLE job_clusters (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company             text NOT NULL,
  title               text NOT NULL,
  company_key         text NOT NULL,
  title_key           text NOT NULL,
  location_key        text NOT NULL DEFAULT '',
  description_hash    bigint,
  first_seen_at       timestamptz NOT NULL DEFAULT now(),
  last_seen_at        timestamptz NOT NULL DEFAULT now(),
  earliest_posted_at  timestamptz,
  latest_posted_at    timestamptz,
  repost_count        integer NOT NULL DEFAULT 0,
  viewer_count        integer NOT NULL DEFAULT 0,
  sighting_count      integer NOT NULL DEFAULT 0,
  board_says_reposted boolean NOT NULL DEFAULT false,
  closed              boolean NOT NULL DEFAULT false,
  applicant_count     integer,
  evergreen_phrases   text[] NOT NULL DEFAULT '{}',
  ghost_score         smallint NOT NULL DEFAULT 0,
  ghost_level         text NOT NULL DEFAULT 'unknown',
  scored_at           timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now()
);

-- Candidate lookup when a new posting arrives: same company, recently active.
CREATE INDEX job_clusters_company_recent_idx ON job_clusters (company_key, last_seen_at DESC);
-- Keyset pagination for the rescoring job.
CREATE INDEX job_clusters_last_seen_idx ON job_clusters (last_seen_at, id);

-- A posting is one listing on one board, identified by that board's own id.
CREATE TABLE postings (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cluster_id       uuid NOT NULL REFERENCES job_clusters (id) ON DELETE CASCADE,
  source           text NOT NULL,
  source_job_id    text NOT NULL,
  url              text NOT NULL,
  title            text NOT NULL,
  company          text NOT NULL,
  location         text,
  description_hash bigint,
  first_seen_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at     timestamptz NOT NULL DEFAULT now(),
  posted_at        timestamptz,
  refresh_count    integer NOT NULL DEFAULT 0,
  UNIQUE (source, source_job_id)
);

CREATE INDEX postings_cluster_idx ON postings (cluster_id, source);

-- At most one sighting per user, posting and UTC day. This keeps a single
-- user (or a refresh loop) from inflating the history.
CREATE TABLE sightings (
  posting_id          uuid NOT NULL REFERENCES postings (id) ON DELETE CASCADE,
  user_id             uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  seen_on             date NOT NULL DEFAULT (now() AT TIME ZONE 'utc')::date,
  seen_at             timestamptz NOT NULL DEFAULT now(),
  claimed_posted_at   timestamptz,
  board_says_reposted boolean NOT NULL DEFAULT false,
  applicant_count     integer,
  PRIMARY KEY (posting_id, user_id, seen_on)
);

CREATE INDEX sightings_user_idx ON sightings (user_id, seen_at DESC);

-- Distinct viewers per cluster, so viewer_count is an O(1) increment.
CREATE TABLE cluster_viewers (
  cluster_id    uuid NOT NULL REFERENCES job_clusters (id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (cluster_id, user_id)
);
