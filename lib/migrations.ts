// Database schema, as an ordered list. Never edit an entry that has shipped: add a new one.
//
// Conventions that keep both database backends behaving the same:
//  - calendar days are TEXT 'YYYY-MM-DD'
//  - money is INTEGER cents
//  - ids from the bank and from Strava are TEXT

export const MIGRATIONS: string[] = [
  `
  CREATE TABLE kv (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );

  CREATE TABLE locks (
    name TEXT PRIMARY KEY,
    until TIMESTAMPTZ NOT NULL
  );

  -- Every version of the rules. The version in force on a day is the newest one
  -- whose effective_from is on or before that day.
  CREATE TABLE rules (
    id SERIAL PRIMARY KEY,
    effective_from TEXT NOT NULL,
    config JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX rules_effective ON rules (effective_from, id);

  -- Short-lived copy of recent Strava activities (pruned after 7 days).
  CREATE TABLE activities (
    id TEXT PRIMARY KEY,
    sport_type TEXT NOT NULL,
    name TEXT NOT NULL,
    local_date TEXT NOT NULL,
    start_time TEXT NOT NULL,
    distance_m INTEGER NOT NULL,
    moving_s INTEGER NOT NULL,
    elapsed_s INTEGER NOT NULL,
    manual BOOLEAN NOT NULL,
    fetched_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX activities_day ON activities (local_date);

  -- Uploaded workout screenshots. One per day at most.
  CREATE TABLE proofs (
    id SERIAL PRIMARY KEY,
    session_date TEXT NOT NULL UNIQUE,
    sha256 TEXT NOT NULL UNIQUE,
    mime TEXT NOT NULL,
    image BYTEA NOT NULL,
    bytes INTEGER NOT NULL,
    uploaded_at TIMESTAMPTZ NOT NULL
  );

  -- One row per scheduled day once it has been judged. Never updated afterwards.
  CREATE TABLE sessions (
    date TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    status TEXT NOT NULL,
    practice BOOLEAN NOT NULL,
    source TEXT,
    activity_id TEXT,
    proof_id INTEGER,
    streak INTEGER NOT NULL,
    raw_cents INTEGER NOT NULL DEFAULT 0,
    charge_cents INTEGER NOT NULL DEFAULT 0,
    note TEXT,
    settled_at TIMESTAMPTZ NOT NULL
  );

  -- One row per charged miss. status: owed -> sending -> held -> returned
  CREATE TABLE penalties (
    id SERIAL PRIMARY KEY,
    session_date TEXT NOT NULL UNIQUE REFERENCES sessions (date),
    amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
    status TEXT NOT NULL DEFAULT 'owed',
    friend_iban TEXT NOT NULL,
    friend_name TEXT NOT NULL,
    hold_days INTEGER NOT NULL,
    ref TEXT NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    sending_at TIMESTAMPTZ,
    bank_payment_id TEXT UNIQUE,
    sent_at TIMESTAMPTZ,
    release_on TEXT,
    returned_cents INTEGER NOT NULL DEFAULT 0,
    returned_at TIMESTAMPTZ,
    last_error TEXT
  );

  -- Money that came in from the friend. is_return decides whether it counts as
  -- giving a held penalty back (auto = description mentions showup; can be set by hand).
  CREATE TABLE incoming (
    bank_payment_id TEXT PRIMARY KEY,
    amount_cents INTEGER NOT NULL,
    bank_created TEXT NOT NULL,
    iban TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    is_return BOOLEAN NOT NULL,
    decided_by TEXT NOT NULL DEFAULT 'auto',
    seen_at TIMESTAMPTZ NOT NULL
  );

  CREATE TABLE events (
    id SERIAL PRIMARY KEY,
    at TIMESTAMPTZ NOT NULL,
    kind TEXT NOT NULL,
    message TEXT NOT NULL
  );
  CREATE INDEX events_at ON events (at DESC);
  `,
];
