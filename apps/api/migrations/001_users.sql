-- Each browser install gets an anonymous user. The raw token is shown to the
-- extension once; only its SHA-256 hash is stored.
CREATE TABLE users (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash   bytea NOT NULL UNIQUE,
  plan         text NOT NULL DEFAULT 'free' CHECK (plan IN ('free', 'pro')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);
