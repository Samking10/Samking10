import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

// Each migration runs once, in order. Never edit an old one; add a new one.
const MIGRATIONS = [
  `
  CREATE TABLE accounts (
    id INTEGER PRIMARY KEY,
    business_name TEXT NOT NULL,
    owner_name TEXT NOT NULL DEFAULT '',
    notify_email TEXT NOT NULL,
    phone TEXT NOT NULL DEFAULT '',
    business_address TEXT NOT NULL DEFAULT '',
    timezone TEXT NOT NULL DEFAULT 'America/New_York',
    send_window_start INTEGER NOT NULL DEFAULT 8,
    send_window_end INTEGER NOT NULL DEFAULT 18,
    send_days TEXT NOT NULL DEFAULT '1,2,3,4,5,6',
    email_signature TEXT NOT NULL DEFAULT '',
    include_response_link INTEGER NOT NULL DEFAULT 1,
    bcc_owner INTEGER NOT NULL DEFAULT 0,
    sending_paused INTEGER NOT NULL DEFAULT 0,
    plan_status TEXT NOT NULL DEFAULT 'inactive',
    trial_ends_at INTEGER,
    stripe_customer_id TEXT,
    stripe_subscription_id TEXT,
    onboarding_paid INTEGER NOT NULL DEFAULT 0,
    test_email_sent_at INTEGER,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts(id),
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    csrf_token TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE password_resets (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    expires_at INTEGER NOT NULL,
    used_at INTEGER
  );

  CREATE TABLE sequence_steps (
    id INTEGER PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts(id),
    position INTEGER NOT NULL,
    delay_days INTEGER NOT NULL,
    subject TEXT NOT NULL,
    body TEXT NOT NULL,
    UNIQUE(account_id, position)
  );

  CREATE TABLE estimates (
    id INTEGER PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts(id),
    customer_name TEXT NOT NULL,
    customer_email TEXT NOT NULL COLLATE NOCASE,
    customer_phone TEXT NOT NULL DEFAULT '',
    job_address TEXT NOT NULL DEFAULT '',
    job_description TEXT NOT NULL DEFAULT '',
    amount_cents INTEGER NOT NULL DEFAULT 0,
    sent_at INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    status_changed_at INTEGER NOT NULL,
    lost_reason TEXT NOT NULL DEFAULT '',
    booked_amount_cents INTEGER,
    booked_at INTEGER,
    public_token TEXT NOT NULL UNIQUE,
    source TEXT NOT NULL DEFAULT 'manual',
    created_at INTEGER NOT NULL
  );
  CREATE INDEX idx_estimates_account_status ON estimates(account_id, status);

  CREATE TABLE followups (
    id INTEGER PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts(id),
    estimate_id INTEGER NOT NULL REFERENCES estimates(id),
    step_position INTEGER NOT NULL,
    delay_days INTEGER NOT NULL,
    scheduled_at INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'scheduled',
    attempts INTEGER NOT NULL DEFAULT 0,
    claimed_at INTEGER,
    sent_at INTEGER,
    to_email TEXT,
    subject TEXT,
    body TEXT,
    provider_message_id TEXT,
    error TEXT,
    UNIQUE(estimate_id, step_position)
  );
  CREATE INDEX idx_followups_due ON followups(status, scheduled_at);

  CREATE TABLE events (
    id INTEGER PRIMARY KEY,
    account_id INTEGER NOT NULL REFERENCES accounts(id),
    estimate_id INTEGER REFERENCES estimates(id),
    type TEXT NOT NULL,
    data TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL
  );
  CREATE INDEX idx_events_estimate ON events(estimate_id, created_at);
  CREATE INDEX idx_events_account ON events(account_id, type, created_at);

  CREATE TABLE suppressions (
    account_id INTEGER NOT NULL REFERENCES accounts(id),
    email TEXT NOT NULL COLLATE NOCASE,
    reason TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY(account_id, email)
  );

  CREATE TABLE outbox (
    id INTEGER PRIMARY KEY,
    to_email TEXT NOT NULL,
    from_header TEXT NOT NULL,
    reply_to TEXT,
    subject TEXT NOT NULL,
    text_body TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE stripe_events (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    received_at INTEGER NOT NULL
  );

  CREATE TABLE meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
];

export function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  migrate(db);
  return db;
}

function migrate(db) {
  const current = db.pragma('user_version', { simple: true });
  for (let i = current; i < MIGRATIONS.length; i++) {
    db.transaction(() => {
      db.exec(MIGRATIONS[i]);
      db.pragma(`user_version = ${i + 1}`);
    })();
  }
}

export function getMeta(db, key) {
  return db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value ?? null;
}

export function setMeta(db, key, value) {
  db.prepare('INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
}
