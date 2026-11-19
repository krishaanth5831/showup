// Small key-value store on top of the kv table, for settings and connection state.
// "Secret" values are encrypted before they are written.

import type { Db } from "./db";
import { decrypt, encrypt } from "./secrets";

export async function kvGet<T>(db: Db, key: string): Promise<T | null> {
  const rows = await db.query<{ value: string }>("SELECT value FROM kv WHERE key = $1", [key]);
  return rows.length ? (JSON.parse(rows[0].value) as T) : null;
}

export async function kvSet(db: Db, key: string, value: unknown): Promise<void> {
  await db.query(
    `INSERT INTO kv (key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, JSON.stringify(value)],
  );
}

export async function kvDelete(db: Db, key: string): Promise<void> {
  await db.query("DELETE FROM kv WHERE key = $1", [key]);
}

export async function secretGet<T>(db: Db, key: string): Promise<T | null> {
  const sealed = await kvGet<string>(db, key);
  return sealed ? (JSON.parse(decrypt(sealed)) as T) : null;
}

export async function secretSet(db: Db, key: string, value: unknown): Promise<void> {
  await kvSet(db, key, encrypt(JSON.stringify(value)));
}

/**
 * Takes a named lock for a limited time. Returns false when someone else holds it.
 * A crashed holder can't block forever: the lock simply expires.
 */
export async function acquireLock(db: Db, name: string, seconds: number): Promise<boolean> {
  const rows = await db.query(
    `INSERT INTO locks (name, until) VALUES ($1, now() + ($2 || ' seconds')::interval)
     ON CONFLICT (name) DO UPDATE SET until = EXCLUDED.until WHERE locks.until < now()
     RETURNING name`,
    [name, String(seconds)],
  );
  return rows.length > 0;
}

export async function releaseLock(db: Db, name: string): Promise<void> {
  await db.query("DELETE FROM locks WHERE name = $1", [name]);
}

export async function logEvent(db: Db, at: Date, kind: string, message: string): Promise<void> {
  await db.query("INSERT INTO events (at, kind, message) VALUES ($1, $2, $3)", [at, kind, message.slice(0, 500)]);
}
