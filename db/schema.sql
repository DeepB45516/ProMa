-- Basecamp schema. Plain TEXT ids (app-generated UUIDs) to avoid depending
-- on any Postgres extension being enabled on the host.

CREATE TABLE IF NOT EXISTS users (
  id             TEXT PRIMARY KEY,
  full_name      TEXT NOT NULL,
  username       TEXT UNIQUE NOT NULL,
  email          TEXT UNIQUE NOT NULL,
  password_hash  TEXT,
  mobile         TEXT UNIQUE,
  avatar_url     TEXT,
  bio            TEXT NOT NULL DEFAULT '',
  designation    TEXT NOT NULL DEFAULT '',
  google_id      TEXT UNIQUE,
  notif_email    BOOLEAN NOT NULL DEFAULT TRUE,
  notif_overdue  BOOLEAN NOT NULL DEFAULT TRUE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token       TEXT UNIQUE NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  used        BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS otp_codes (
  id          TEXT PRIMARY KEY,
  mobile      TEXT NOT NULL,
  code        TEXT NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  consumed    BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS teams (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  icon        TEXT NOT NULL DEFAULT '🚀',
  purpose     TEXT NOT NULL DEFAULT '',
  owner_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS team_members (
  id        TEXT PRIMARY KEY,
  team_id   TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role      TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner','admin','member')),
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (team_id, user_id)
);

CREATE TABLE IF NOT EXISTS team_invites (
  id          TEXT PRIMARY KEY,
  team_id     TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  email       TEXT NOT NULL,
  role        TEXT NOT NULL DEFAULT 'member',
  token       TEXT UNIQUE NOT NULL,
  invited_by  TEXT REFERENCES users(id),
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','declined')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Widen the check constraint on already-deployed databases that were
-- created before "declined" was a valid status (declining an invite used
-- to fail with a check-constraint violation because the DB only allowed
-- 'pending'/'accepted'). Safe/no-op if already widened or table is new.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'team_invites_status_check'
  ) THEN
    ALTER TABLE team_invites DROP CONSTRAINT team_invites_status_check;
  END IF;
  ALTER TABLE team_invites ADD CONSTRAINT team_invites_status_check
    CHECK (status IN ('pending','accepted','declined'));
EXCEPTION WHEN duplicate_object THEN
  NULL;
END $$;

CREATE TABLE IF NOT EXISTS tasks (
  id          TEXT PRIMARY KEY,
  team_id     TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  assignee_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  status      TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo','in_progress','complete')),
  priority    TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','medium','normal','high','urgent')),
  checklist   JSONB DEFAULT '[]'::jsonb,
  start_date  DATE,
  deadline    DATE NOT NULL,
  created_by  TEXT REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE tasks ADD COLUMN IF NOT EXISTS priority TEXT NOT NULL DEFAULT 'normal';
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS checklist JSONB DEFAULT '[]'::jsonb;

CREATE TABLE IF NOT EXISTS task_comments (
  id         TEXT PRIMARY KEY,
  task_id    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  content    TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS notifications (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title      TEXT NOT NULL,
  message    TEXT NOT NULL,
  link       TEXT,
  is_read    BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS notif_assignment BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS notif_due_reminders BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS notif_team_invites BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS color_theme TEXT NOT NULL DEFAULT 'proma-blue';

-- Keep color_theme constrained to the palettes the frontend actually
-- supports (Appearance settings). Widened via drop/re-add, same pattern as
-- the team_invites status constraint above, so it's safe to re-run and
-- safe on already-deployed databases.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'users_color_theme_check'
  ) THEN
    ALTER TABLE users DROP CONSTRAINT users_color_theme_check;
  END IF;
  ALTER TABLE users ADD CONSTRAINT users_color_theme_check
    CHECK (color_theme IN ('proma-blue','ocean','emerald','violet','slate','sunset'));
EXCEPTION WHEN duplicate_object THEN
  NULL;
END $$;

ALTER TABLE notifications ADD COLUMN IF NOT EXISTS team_id TEXT REFERENCES teams(id) ON DELETE CASCADE;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS activity_id TEXT REFERENCES tasks(id) ON DELETE CASCADE;
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS type TEXT NOT NULL DEFAULT 'general';
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS read_at TIMESTAMPTZ;

ALTER TABLE otp_codes ADD COLUMN IF NOT EXISTS email TEXT;
ALTER TABLE otp_codes ADD COLUMN IF NOT EXISTS code_hash TEXT;
ALTER TABLE otp_codes ADD COLUMN IF NOT EXISTS attempts INT NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS email_notifications (
  id                  TEXT PRIMARY KEY,
  user_id             TEXT REFERENCES users(id) ON DELETE CASCADE,
  activity_id         TEXT REFERENCES tasks(id) ON DELETE CASCADE,
  notification_type   TEXT NOT NULL,
  scheduled_for       TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at             TIMESTAMPTZ,
  status              TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed')),
  provider_message_id TEXT,
  error_message       TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, activity_id, notification_type)
);

CREATE INDEX IF NOT EXISTS idx_tasks_team        ON tasks(team_id);
CREATE INDEX IF NOT EXISTS idx_tasks_assignee     ON tasks(assignee_id);
CREATE INDEX IF NOT EXISTS idx_tasks_deadline_status ON tasks(deadline, status);
CREATE INDEX IF NOT EXISTS idx_team_members_team  ON team_members(team_id);
CREATE INDEX IF NOT EXISTS idx_team_members_user  ON team_members(user_id);
CREATE INDEX IF NOT EXISTS idx_invites_email      ON team_invites(email);
CREATE INDEX IF NOT EXISTS idx_invites_team       ON team_invites(team_id);
CREATE INDEX IF NOT EXISTS idx_comments_task      ON task_comments(task_id);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, is_read);
CREATE INDEX IF NOT EXISTS idx_email_notif_status ON email_notifications(status, scheduled_for);
CREATE INDEX IF NOT EXISTS idx_otp_email          ON otp_codes(email);
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_lower ON users(LOWER(username));

-- Migrate task dates to timestamptz to support date and time
DO $$
BEGIN
  ALTER TABLE tasks ALTER COLUMN deadline TYPE TIMESTAMPTZ USING deadline::TIMESTAMPTZ;
  ALTER TABLE tasks ALTER COLUMN start_date TYPE TIMESTAMPTZ USING start_date::TIMESTAMPTZ;
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;



