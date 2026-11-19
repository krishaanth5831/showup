// Workout photos: the proof for every training day, runs and strength sessions alike.
//
// A photo counts for today's session, or for yesterday's when it is uploaded in the first
// hours after midnight (before that day gets judged). Claude reads it at upload, and the
// rules in engine.ts decide (judgePhoto): the right kind of workout, on the right day,
// long or far enough, and not the same workout as an earlier photo.
//
//  - A photo that fails is not stored. The reason is shown, so a better one can be sent in time.
//  - When Claude can't be reached, the photo is kept as "waiting" and checked again later.
//    It never turns into a miss because of an outage (see the waiting rule in settle.ts).

import crypto from "node:crypto";
import type { Db } from "./db";
import { type EarlierPhoto, type Kind, type PhotoReading, judgePhoto } from "./engine";
import { kvDelete, kvSet, logEvent } from "./kv";
import { PhotoCheckError, type PhotoCheckPort, type PhotoImage } from "./ports";
import { rulesFor } from "./rules";
import { type Ymd, addDays, isYmd, localDate, localParts, settleAfter, shortDate, weekdayOf } from "./time";

export const MAX_PROOF_BYTES = 3_500_000;
/** How many earlier photos of the same kind Claude gets to compare a new one with. */
export const COMPARE_WITH = 6;

export class ProofError extends Error {}

export type CheckStatus = "accepted" | "waiting" | "unchecked";

/** Recognises the image type from the first bytes, so a renamed file can't sneak in. */
export function sniffImage(bytes: Uint8Array): string | null {
  const b = bytes;
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b.length > 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50)
    return "image/webp";
  return null;
}

async function openKind(db: Db, day: Ymd): Promise<Kind | null> {
  const version = await rulesFor(db, day);
  const kind = version?.rules.schedule[weekdayOf(day)] ?? null;
  if (!kind) return null;
  const judged = await db.query("SELECT 1 FROM sessions WHERE date = $1", [day]);
  return judged.length === 0 ? kind : null;
}

/**
 * The days a photo uploaded right now can count for: today's training day, and until 03:00
 * yesterday's, as long as that one has no photo yet.
 */
export async function proofTargets(db: Db, now: Date): Promise<{ date: Ymd; kind: Kind }[]> {
  const out: { date: Ymd; kind: Kind }[] = [];
  const today = localDate(now);
  const kindToday = await openKind(db, today);
  if (kindToday) out.push({ date: today, kind: kindToday });
  const yesterday = addDays(today, -1);
  if (now.getTime() < settleAfter(yesterday).getTime()) {
    const kind = await openKind(db, yesterday);
    const has = await db.query("SELECT 1 FROM proofs WHERE session_date = $1", [yesterday]);
    if (kind && has.length === 0) out.push({ date: yesterday, kind });
  }
  return out;
}

function parseReading(v: unknown): PhotoReading | null {
  if (!v) return null;
  return (typeof v === "string" ? JSON.parse(v) : v) as PhotoReading;
}

/** Every earlier photo's figures, for the exact-same-figures rule. Cheap: no pictures. */
async function earlierReadings(db: Db, kind: Kind, day: Ymd): Promise<EarlierPhoto[]> {
  const rows = await db.query<{ session_date: string; kind: Kind; reading: unknown }>(
    "SELECT session_date, kind, reading FROM proofs WHERE kind = $1 AND session_date <> $2 AND reading IS NOT NULL",
    [kind, day],
  );
  return rows.map((r) => ({ day: r.session_date, kind: r.kind, reading: parseReading(r.reading) }));
}

/** The most recent photos of the same kind that counted, with their pictures, for Claude to compare. */
async function earlierImages(db: Db, kind: Kind, day: Ymd): Promise<(PhotoImage & { day: Ymd })[]> {
  const rows = await db.query<{ session_date: string; mime: string; image: Uint8Array }>(
    `SELECT session_date, mime, image FROM proofs
     WHERE kind = $1 AND session_date <> $2 AND check_status IN ('accepted', 'unchecked')
     ORDER BY session_date DESC LIMIT $3`,
    [kind, day, COMPARE_WITH],
  );
  return rows.map((r) => ({ day: r.session_date, mime: r.mime, bytes: r.image }));
}

function wallClock(now: Date): string {
  const p = localParts(now);
  return `${p.ymd} ${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
}

/** Has Claude read the photo and apply the rules. Throws PhotoCheckError when there is no reading. */
async function check(db: Db, photos: PhotoCheckPort, day: Ymd, kind: Kind, image: PhotoImage, uploadedAt: Date) {
  const rules = (await rulesFor(db, day))?.rules;
  if (!rules) throw new ProofError("There are no rules for that day.");
  const reading = await photos.read({ day, kind, uploadedAt: wallClock(uploadedAt), image, earlier: await earlierImages(db, kind, day) });
  return { reading, verdict: judgePhoto(reading, day, kind, rules, await earlierReadings(db, kind, day)) };
}

export interface SavedProof {
  id: number;
  date: Ymd;
  kind: Kind;
  status: "accepted" | "waiting";
  /** What Claude read, in one line (accepted only). */
  summary: string | null;
}

export async function saveProof(db: Db, now: Date, day: string, bytes: Uint8Array, photos: PhotoCheckPort): Promise<SavedProof> {
  if (bytes.length === 0) throw new ProofError("The picture is empty.");
  if (bytes.length > MAX_PROOF_BYTES) throw new ProofError("The picture is too large.");
  const mime = sniffImage(bytes);
  if (!mime) throw new ProofError("That file is not a JPEG, PNG or WebP picture.");
  const target = isYmd(day) ? (await proofTargets(db, now)).find((t) => t.date === day) : undefined;
  if (!target) throw new ProofError("There is no training session to prove for that day right now.");
  const { kind } = target;

  const sha = crypto.createHash("sha256").update(bytes).digest("hex");
  const dup = await db.query<{ session_date: string }>("SELECT session_date FROM proofs WHERE sha256 = $1", [sha]);
  if (dup.length && dup[0].session_date !== day) {
    throw new ProofError(`This exact picture was already used on ${shortDate(dup[0].session_date)}.`);
  }
  if (!(await photos.ready())) throw new ProofError("Add a Claude API key in Settings first, so photos can be checked.");

  let status: "accepted" | "waiting" = "accepted";
  let reading: PhotoReading | null = null;
  let checkError: string | null = null;
  try {
    const res = await check(db, photos, day, kind, { mime, bytes }, now);
    if (!res.verdict.ok) {
      await logEvent(db, now, "photo", `${day}: photo refused: ${res.verdict.why}`);
      throw new ProofError(res.verdict.why);
    }
    reading = res.reading;
  } catch (e) {
    if (!(e instanceof PhotoCheckError)) throw e;
    // A key problem or a picture Claude won't read: someone has to act, so nothing is stored.
    if (e.kind !== "unavailable") throw new ProofError(e.message);
    const counted = await db.query("SELECT 1 FROM proofs WHERE session_date = $1 AND check_status <> 'waiting'", [day]);
    if (counted.length) throw new ProofError(`${e.message} Your earlier photo for ${shortDate(day)} still counts.`);
    status = "waiting";
    checkError = e.message;
  }

  const rows = await db.tx(async (t) => {
    // Until the day is judged, a new photo replaces the earlier one.
    await t.query("DELETE FROM proofs WHERE session_date = $1", [day]);
    return t.query<{ id: number }>(
      `INSERT INTO proofs (session_date, sha256, mime, image, bytes, uploaded_at, kind, check_status, reading, checked_at, check_error)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11) RETURNING id`,
      [day, sha, mime, Buffer.from(bytes), bytes.length, now, kind, status, reading ? JSON.stringify(reading) : null, reading ? now : null, checkError],
    );
  });
  await kvDelete(db, "photo_refused");
  await logEvent(db, now, "photo", `${day}: photo ${status === "accepted" ? "accepted" : "saved, waiting for the check"}`);
  return { id: rows[0].id, date: day, kind, status, summary: reading?.summary ?? null };
}

/**
 * Tries the check again for photos that are waiting for Claude. A photo that fails now is
 * removed and the reason is kept for the Today screen. Returns how many were settled.
 */
export async function recheckWaiting(db: Db, photos: PhotoCheckPort, now: Date): Promise<number> {
  const rows = await db.query<{ id: number; session_date: string; kind: Kind; mime: string; image: Uint8Array; uploaded_at: Date }>(
    "SELECT id, session_date, kind, mime, image, uploaded_at FROM proofs WHERE check_status = 'waiting' ORDER BY session_date",
  );
  if (rows.length === 0 || !(await photos.ready())) return 0;
  let done = 0;
  for (const p of rows) {
    try {
      const res = await check(db, photos, p.session_date, p.kind, { mime: p.mime, bytes: p.image }, new Date(p.uploaded_at));
      if (res.verdict.ok) {
        await db.query("UPDATE proofs SET check_status = 'accepted', reading = $2::jsonb, checked_at = $3, check_error = NULL WHERE id = $1 AND check_status = 'waiting'", [
          p.id,
          JSON.stringify(res.reading),
          now,
        ]);
        await logEvent(db, now, "photo", `${p.session_date}: photo accepted after waiting`);
      } else {
        await refuseWaiting(db, now, p.id, p.session_date, res.verdict.why);
      }
      done++;
    } catch (e) {
      if (!(e instanceof PhotoCheckError)) throw e;
      if (e.kind === "refused") {
        await refuseWaiting(db, now, p.id, p.session_date, e.message);
        done++;
      } else {
        await db.query("UPDATE proofs SET check_error = $2 WHERE id = $1", [p.id, e.message]);
      }
    }
  }
  return done;
}

async function refuseWaiting(db: Db, now: Date, id: number, day: Ymd, why: string): Promise<void> {
  await db.query("DELETE FROM proofs WHERE id = $1 AND check_status = 'waiting'", [id]);
  await kvSet(db, "photo_refused", { day, why, at: now.toISOString() });
  await logEvent(db, now, "photo", `${day}: waiting photo refused: ${why}`);
}

/** After waiting too long for Claude, a photo counts without a check (the friend can still see it). */
export async function markUnchecked(db: Db, day: Ymd): Promise<void> {
  await db.query("UPDATE proofs SET check_status = 'unchecked' WHERE session_date = $1 AND check_status = 'waiting'", [day]);
}

export interface ProofInfo {
  id: number;
  status: CheckStatus;
  summary: string | null;
}

export async function proofOn(db: Db, day: Ymd, kind: Kind): Promise<ProofInfo | null> {
  const rows = await db.query<{ id: number; check_status: CheckStatus; reading: unknown }>(
    "SELECT id, check_status, reading FROM proofs WHERE session_date = $1 AND kind = $2",
    [day, kind],
  );
  if (!rows.length) return null;
  return { id: rows[0].id, status: rows[0].check_status, summary: parseReading(rows[0].reading)?.summary ?? null };
}

export async function loadProof(db: Db, id: number): Promise<{ mime: string; image: Uint8Array; date: Ymd } | null> {
  const rows = await db.query<{ mime: string; image: Uint8Array; session_date: string }>(
    "SELECT mime, image, session_date FROM proofs WHERE id = $1",
    [id],
  );
  return rows.length ? { mime: rows[0].mime, image: rows[0].image, date: rows[0].session_date } : null;
}
