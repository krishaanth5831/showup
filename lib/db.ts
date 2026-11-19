// One small database interface with two backends:
//  - Postgres (DATABASE_URL set): what runs in production.
//  - PGlite (no DATABASE_URL): Postgres compiled to WebAssembly, stored in ./.data/pg.
//    Used for local development and the tests, so both run the exact same SQL.

import path from "node:path";
import fs from "node:fs";
import { MIGRATIONS } from "./migrations";

export interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  /** Runs several statements without parameters (used for migrations). */
  exec(sql: string): Promise<void>;
  /** Runs fn inside one transaction: everything in it happens, or none of it. */
  tx<T>(fn: (db: Db) => Promise<T>): Promise<T>;
}

interface Globals {
  __showupDb?: Promise<Db>;
}
const g = globalThis as unknown as Globals;

export function databaseUrl(): string | undefined {
  return process.env.DATABASE_URL || process.env.POSTGRES_URL || undefined;
}

export function dataDir(): string {
  return process.env.SHOWUP_DATA_DIR || path.join(process.cwd(), ".data");
}

async function openPostgres(url: string): Promise<Db> {
  const { Pool } = await import("pg");
  const local = /localhost|127\.0\.0\.1/.test(url);
  const pool = new Pool({
    connectionString: url,
    max: 3,
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000,
    ssl: local ? undefined : { rejectUnauthorized: true },
  });
  const wrap = (q: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> }): Db => ({
    async query<T>(sql: string, params: unknown[] = []) {
      const res = await q.query(sql, params);
      return res.rows as T[];
    },
    async exec(sql: string) {
      await q.query(sql);
    },
    async tx() {
      throw new Error("Nested transactions are not supported.");
    },
  });
  const db = wrap(pool);
  db.tx = async <T>(fn: (db: Db) => Promise<T>): Promise<T> => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const out = await fn(wrap(client));
      await client.query("COMMIT");
      return out;
    } catch (e) {
      await client.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      client.release();
    }
  };
  return db;
}

interface PgliteLike {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
  exec(sql: string): Promise<unknown>;
  transaction<T>(fn: (tx: PgliteLike) => Promise<T>): Promise<T>;
}

function wrapPglite(pg: PgliteLike): Db {
  const wrap = (q: PgliteLike, inTx: boolean): Db => ({
    async query<T>(sql: string, params: unknown[] = []) {
      const res = await q.query(sql, params);
      return res.rows as T[];
    },
    async exec(sql: string) {
      await q.exec(sql);
    },
    async tx<T>(fn: (db: Db) => Promise<T>): Promise<T> {
      if (inTx) throw new Error("Nested transactions are not supported.");
      return pg.transaction((tx) => fn(wrap(tx, true)));
    },
  });
  return wrap(pg, false);
}

/** An empty in-memory database with the schema applied. For tests and simulations. */
export async function openMemoryDb(): Promise<Db> {
  const { PGlite } = await import("@electric-sql/pglite");
  const db = wrapPglite(new PGlite() as unknown as PgliteLike);
  await migrate(db);
  return db;
}

async function openLocal(): Promise<Db> {
  if (process.env.VERCEL) {
    throw new Error(
      "No database configured. Add a Postgres database to the Vercel project (it sets DATABASE_URL) and redeploy.",
    );
  }
  const dir = path.join(dataDir(), "pg");
  fs.mkdirSync(dir, { recursive: true });
  const { PGlite } = await import("@electric-sql/pglite");
  return wrapPglite(new PGlite(dir) as unknown as PgliteLike);
}

export async function migrate(db: Db): Promise<void> {
  await db.exec("CREATE TABLE IF NOT EXISTS schema_version (v INTEGER PRIMARY KEY)");
  const rows = await db.query<{ v: number }>("SELECT COALESCE(MAX(v), 0)::int AS v FROM schema_version");
  const current = rows[0]?.v ?? 0;
  for (let i = current; i < MIGRATIONS.length; i++) {
    await db.tx(async (t) => {
      await t.exec(MIGRATIONS[i]);
      await t.query("INSERT INTO schema_version (v) VALUES ($1)", [i + 1]);
    });
  }
}

/** The app's database, opened once per server process and migrated on first use. */
export function getDb(): Promise<Db> {
  if (!g.__showupDb) {
    g.__showupDb = (async () => {
      const url = databaseUrl();
      const db = url ? await openPostgres(url) : await openLocal();
      await migrate(db);
      return db;
    })();
    g.__showupDb.catch(() => {
      g.__showupDb = undefined;
    });
  }
  return g.__showupDb;
}
