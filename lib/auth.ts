// Single-user login. There is one password (created on first visit) and a signed session cookie.

import crypto from "node:crypto";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { connection } from "next/server";
import { type Db, getDb } from "./db";
import { kvDelete, kvGet, kvSet } from "./kv";
import { checkPassword, hashPassword, sign, verifySignature } from "./secrets";

const COOKIE = "showup_session";
const SESSION_DAYS = 60;
const MAX_FAILS = 5;
const LOCK_MINUTES = 15;

export async function hasPassword(db: Db): Promise<boolean> {
  return (await kvGet<string>(db, "password")) !== null;
}

/** Sessions are tied to the current password: changing it signs everyone out. */
function fingerprint(passwordHash: string): string {
  return crypto.createHash("sha256").update(passwordHash).digest("base64url").slice(0, 16);
}

async function startSession(db: Db): Promise<void> {
  const hash = (await kvGet<string>(db, "password")) as string;
  const expires = Date.now() + SESSION_DAYS * 86_400_000;
  const payload = `${expires}.${fingerprint(hash)}`;
  (await cookies()).set(COOKIE, `${expires}.${sign("session", payload)}`, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires: new Date(expires),
  });
}

export async function isLoggedIn(db: Db): Promise<boolean> {
  const raw = (await cookies()).get(COOKIE)?.value;
  if (!raw) return false;
  const [expires, signature] = raw.split(".");
  if (!expires || !signature || Number(expires) < Date.now()) return false;
  const hash = await kvGet<string>(db, "password");
  if (!hash) return false;
  return verifySignature("session", `${expires}.${fingerprint(hash)}`, signature);
}

/** For pages and actions that need the owner. Sends everyone else to the login screen. */
export async function requireUser(): Promise<Db> {
  // Everything behind the login is per-request: tell Next.js before the database is touched.
  await connection();
  const db = await getDb();
  if (!(await hasPassword(db))) redirect("/setup");
  if (!(await isLoggedIn(db))) redirect("/login");
  return db;
}

export async function createPassword(db: Db, password: string): Promise<string | null> {
  if (await hasPassword(db)) return "A password already exists.";
  if (password.length < 10) return "Use at least 10 characters.";
  await kvSet(db, "password", hashPassword(password));
  await startSession(db);
  return null;
}

interface Guard {
  fails: number;
  lockedUntil: number;
}

export async function login(db: Db, password: string): Promise<string | null> {
  const guard = (await kvGet<Guard>(db, "login_guard")) ?? { fails: 0, lockedUntil: 0 };
  if (guard.lockedUntil > Date.now()) {
    return `Too many wrong tries. Try again in ${Math.ceil((guard.lockedUntil - Date.now()) / 60_000)} min.`;
  }
  const hash = await kvGet<string>(db, "password");
  if (!hash || !checkPassword(password, hash)) {
    const fails = guard.fails + 1;
    await kvSet(db, "login_guard", {
      fails: fails >= MAX_FAILS ? 0 : fails,
      lockedUntil: fails >= MAX_FAILS ? Date.now() + LOCK_MINUTES * 60_000 : 0,
    });
    return "Wrong password.";
  }
  await kvDelete(db, "login_guard");
  await startSession(db);
  return null;
}

export async function logout(): Promise<void> {
  (await cookies()).delete(COOKIE);
}
