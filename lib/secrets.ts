// Encryption for the things that must never sit in the database as plain text
// (bank API key, Strava secret and tokens), plus password hashing and signed cookies.
// Everything hangs off one master secret: the APP_SECRET environment variable.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { dataDir } from "./db";

let cached: Buffer | null = null;

export function masterSecret(): Buffer {
  if (cached) return cached;
  const env = process.env.APP_SECRET;
  if (env && env.length >= 32) {
    cached = crypto.createHash("sha256").update(env).digest();
    return cached;
  }
  if (env) throw new Error("APP_SECRET is too short. Use at least 32 random characters.");
  if (process.env.VERCEL) {
    throw new Error("APP_SECRET is not set. Add it to the Vercel project's environment variables and redeploy.");
  }
  // Local development: make one up once and keep it next to the local database.
  const file = path.join(dataDir(), "app-secret");
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, crypto.randomBytes(48).toString("base64url"), { mode: 0o600 });
  }
  cached = crypto.createHash("sha256").update(fs.readFileSync(file, "utf8").trim()).digest();
  return cached;
}

function subKey(purpose: string): Buffer {
  return Buffer.from(crypto.hkdfSync("sha256", masterSecret(), Buffer.alloc(0), `showup:${purpose}`, 32));
}

export function encrypt(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", subKey("vault"), iv);
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), body.toString("base64url")].join(".");
}

export function decrypt(sealed: string): string {
  const [v, iv, tag, body] = sealed.split(".");
  if (v !== "v1" || !iv || !tag || body === undefined) throw new Error("Unreadable encrypted value.");
  const decipher = crypto.createDecipheriv("aes-256-gcm", subKey("vault"), Buffer.from(iv, "base64url"));
  decipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([decipher.update(Buffer.from(body, "base64url")), decipher.final()]).toString("utf8");
}

export function sign(purpose: string, payload: string): string {
  return crypto.createHmac("sha256", subKey(`sign:${purpose}`)).update(payload).digest("base64url");
}

export function verifySignature(purpose: string, payload: string, signature: string): boolean {
  const want = Buffer.from(sign(purpose, payload));
  const got = Buffer.from(signature);
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1 });
  return `scrypt1.${salt.toString("base64url")}.${hash.toString("base64url")}`;
}

export function checkPassword(password: string, stored: string): boolean {
  const [v, salt, hash] = stored.split(".");
  if (v !== "scrypt1" || !salt || !hash) return false;
  const want = Buffer.from(hash, "base64url");
  const got = crypto.scryptSync(password, Buffer.from(salt, "base64url"), 32, { N: 16384, r: 8, p: 1 });
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}

export function randomToken(bytes = 24): string {
  return crypto.randomBytes(bytes).toString("base64url");
}
