// Workout screenshots: the proof for strength days.
// A picture counts for today's strength session, or for yesterday's when it is uploaded
// in the first hours after midnight (before that day gets judged).

import crypto from "node:crypto";
import type { Db } from "./db";
import { rulesFor } from "./rules";
import { type Ymd, addDays, localDate, settleAfter, shortDate, weekdayOf } from "./time";

export const MAX_PROOF_BYTES = 3_500_000;

export class ProofError extends Error {}

/** Recognises the image type from the first bytes, so a renamed file can't sneak in. */
export function sniffImage(bytes: Uint8Array): string | null {
  const b = bytes;
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b.length > 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50)
    return "image/webp";
  return null;
}

async function openStrengthDay(db: Db, day: Ymd): Promise<boolean> {
  const version = await rulesFor(db, day);
  if (version?.rules.schedule[weekdayOf(day)] !== "strength") return false;
  const judged = await db.query("SELECT 1 FROM sessions WHERE date = $1", [day]);
  return judged.length === 0;
}

/** The day an upload made right now would count for, or null when there is none. */
export async function proofTarget(db: Db, now: Date): Promise<Ymd | null> {
  const today = localDate(now);
  if (await openStrengthDay(db, today)) return today;
  const yesterday = addDays(today, -1);
  if (now.getTime() < settleAfter(yesterday).getTime() && (await openStrengthDay(db, yesterday))) {
    const has = await db.query("SELECT 1 FROM proofs WHERE session_date = $1", [yesterday]);
    if (has.length === 0) return yesterday;
  }
  return null;
}

export async function saveProof(db: Db, now: Date, bytes: Uint8Array): Promise<{ id: number; date: Ymd }> {
  if (bytes.length === 0) throw new ProofError("The picture is empty.");
  if (bytes.length > MAX_PROOF_BYTES) throw new ProofError("The picture is too large.");
  const mime = sniffImage(bytes);
  if (!mime) throw new ProofError("That file is not a JPEG, PNG or WebP picture.");
  const date = await proofTarget(db, now);
  if (!date) throw new ProofError("There is no strength session to prove right now.");
  const sha = crypto.createHash("sha256").update(bytes).digest("hex");
  const dup = await db.query<{ session_date: string }>("SELECT session_date FROM proofs WHERE sha256 = $1", [sha]);
  if (dup.length && dup[0].session_date !== date) {
    throw new ProofError(`This exact picture was already used on ${shortDate(dup[0].session_date)}.`);
  }
  const rows = await db.tx(async (t) => {
    // Until the day is judged, a new upload replaces the earlier one.
    await t.query("DELETE FROM proofs WHERE session_date = $1", [date]);
    return t.query<{ id: number }>(
      "INSERT INTO proofs (session_date, sha256, mime, image, bytes, uploaded_at) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id",
      [date, sha, mime, Buffer.from(bytes), bytes.length, now],
    );
  });
  return { id: rows[0].id, date };
}

export async function loadProof(db: Db, id: number): Promise<{ mime: string; image: Uint8Array; date: Ymd } | null> {
  const rows = await db.query<{ mime: string; image: Uint8Array; session_date: string }>(
    "SELECT mime, image, session_date FROM proofs WHERE id = $1",
    [id],
  );
  return rows.length ? { mime: rows[0].mime, image: rows[0].image, date: rows[0].session_date } : null;
}
