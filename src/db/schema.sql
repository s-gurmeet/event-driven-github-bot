-- GitHub Automation Bot Schema
-- Designed for idempotency, observability, and multi-repo support

-- Users authenticated via GitHub OAuth
CREATE TABLE IF NOT EXISTS users (
  id           SERIAL PRIMARY KEY,
  github_id    BIGINT UNIQUE NOT NULL,
  login        TEXT NOT NULL,
  name         TEXT,
  avatar_url   TEXT,
  access_token TEXT NOT NULL,  -- encrypted at rest in production
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Repositories connected by a user
CREATE TABLE IF NOT EXISTS repositories (
  id              SERIAL PRIMARY KEY,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  github_repo_id  BIGINT NOT NULL,
  full_name       TEXT NOT NULL,   -- owner/repo
  webhook_id      BIGINT,          -- GitHub webhook ID for cleanup
  webhook_secret  TEXT NOT NULL,   -- per-repo HMAC secret
  active          BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, github_repo_id)
);

-- Received webhook events (delivery_id ensures idempotency)
CREATE TABLE IF NOT EXISTS events (
  id              SERIAL PRIMARY KEY,
  delivery_id     TEXT UNIQUE NOT NULL,  -- X-GitHub-Delivery header
  repo_id         INTEGER NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  event_type      TEXT NOT NULL,         -- issues, pull_request, push, etc.
  action          TEXT,                  -- opened, closed, labeled, etc.
  payload         JSONB NOT NULL,
  processed       BOOLEAN NOT NULL DEFAULT FALSE,
  processing_error TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at    TIMESTAMPTZ
);

-- Actions taken by the bot
CREATE TABLE IF NOT EXISTS bot_actions (
  id           SERIAL PRIMARY KEY,
  event_id     INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  action_type  TEXT NOT NULL,   -- add_label, post_comment, slack_notify, ai_triage
  status       TEXT NOT NULL DEFAULT 'pending',  -- pending, success, failed
  details      JSONB,           -- action-specific data (label name, comment body, etc.)
  error        TEXT,
  retry_count  INTEGER NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

-- User-defined automation rules
CREATE TABLE IF NOT EXISTS rules (
  id           SERIAL PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  repo_id      INTEGER REFERENCES repositories(id) ON DELETE CASCADE,  -- NULL = all repos
  name         TEXT NOT NULL,
  active       BOOLEAN NOT NULL DEFAULT TRUE,
  event_type   TEXT NOT NULL,    -- issues, pull_request, push
  conditions   JSONB NOT NULL,   -- [{field, operator, value}]
  actions      JSONB NOT NULL,   -- [{type, params}]
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Session store (simple, no external session server needed)
CREATE TABLE IF NOT EXISTS sessions (
  sid    TEXT PRIMARY KEY,
  sess   JSONB NOT NULL,
  expire TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_expire_idx ON sessions(expire);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS events_repo_id_idx      ON events(repo_id);
CREATE INDEX IF NOT EXISTS events_created_at_idx   ON events(created_at DESC);
CREATE INDEX IF NOT EXISTS events_processed_idx    ON events(processed) WHERE processed = FALSE;
CREATE INDEX IF NOT EXISTS bot_actions_event_idx   ON bot_actions(event_id);
CREATE INDEX IF NOT EXISTS bot_actions_status_idx  ON bot_actions(status) WHERE status IN ('pending', 'failed');
CREATE INDEX IF NOT EXISTS rules_user_id_idx       ON rules(user_id);
CREATE INDEX IF NOT EXISTS repositories_user_idx   ON repositories(user_id);
