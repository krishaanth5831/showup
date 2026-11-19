// The friend's side of the money, when the friend collects penalties by hand.
//
//   owed      a day was missed; the friend is told and collects the money from the owner
//   held      the friend marked it collected; they hold it for the hold time
//   returned  the friend marked that they gave the rest back (minus their share)
//
// Only the friend's page can move a penalty along, and every mark is announced to the
// friend's phone, so a mark the friend didn't make doesn't go unnoticed.

import crypto from "node:crypto";
import { loadBunq } from "./bunq";
import type { Db } from "./db";
import { type Collection, type Kind, euros } from "./engine";
import { kvGet, kvSet, logEvent } from "./kv";
import type { Notice, NotifyPort } from "./ports";
import { randomToken } from "./secrets";
import { type Ymd, addDays, dayName, localDate, longDate, shortDate } from "./time";

export async function friendToken(db: Db): Promise<string> {
  let token = await kvGet<string>(db, "friend_token");
  if (!token) {
    token = randomToken(18);
    await kvSet(db, "friend_token", token);
  }
  return token;
}

/** true when `token` is the friend's link token. Compared in constant time. */
export async function isFriendToken(db: Db, token: string): Promise<boolean> {
  const real = await kvGet<string>(db, "friend_token");
  if (!real || typeof token !== "string") return false;
  const a = Buffer.from(token);
  const b = Buffer.from(real);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export interface OwnerDetails {
  /** Shown to the friend: who to collect from and who to give it back to. */
  name: string;
  /** Where the friend sends the money back. Empty when not given. */
  iban: string;
}

export async function ownerDetails(db: Db): Promise<OwnerDetails> {
  const saved = await kvGet<OwnerDetails>(db, "owner");
  const bunq = await loadBunq(db);
  return { name: saved?.name || bunq?.accountName || "", iban: saved?.iban || bunq?.accountIban || "" };
}

export async function saveOwnerDetails(db: Db, details: OwnerDetails): Promise<void> {
  await kvSet(db, "owner", { name: details.name.trim().slice(0, 80), iban: details.iban });
}

export class CollectError extends Error {}

interface PenaltyRow {
  id: number;
  session_date: string;
  amount_cents: number;
  keep_cents: number;
  hold_days: number;
  release_on: string | null;
}

/** The friend got the money from the owner. The hold time starts now. */
export async function markCollected(db: Db, now: Date, id: number, notify: NotifyPort): Promise<PenaltyRow> {
  const found = await db.query<{ hold_days: number }>("SELECT hold_days FROM penalties WHERE id = $1", [id]);
  const releaseOn = addDays(localDate(now), found[0]?.hold_days ?? 0);
  // Conditional, so a double tap (or two phones at once) marks it only once.
  const rows = await db.query<PenaltyRow>(
    `UPDATE penalties SET status = 'held', sent_at = $2, release_on = $3, last_error = NULL
     WHERE id = $1 AND method = 'friend' AND status = 'owed'
     RETURNING id, session_date, amount_cents, keep_cents, hold_days, release_on`,
    [id, now, releaseOn],
  );
  if (!rows.length) throw new CollectError("That one is already marked, or it is not yours to collect.");
  const p = rows[0];
  await logEvent(db, now, "collect", `${p.session_date}: friend marked ${p.amount_cents} cents as collected`);
  await safeNotify(db, notify, {
    title: `Collected: ${euros(p.amount_cents)}`,
    body: `For ${shortDate(p.session_date)}. Hold it until ${longDate(releaseOn)}. Not you who marked it? Then someone else used your link.`,
    url: `/f/${await friendToken(db)}`,
  });
  return p;
}

/** The friend gave the money back, keeping their share. Only once the hold time is over. */
export async function markReturned(db: Db, now: Date, id: number, notify: NotifyPort): Promise<PenaltyRow> {
  const rows = await db.query<PenaltyRow>(
    `UPDATE penalties SET status = 'returned', returned_cents = amount_cents - keep_cents, returned_at = $2
     WHERE id = $1 AND method = 'friend' AND status = 'held' AND release_on <= $3
     RETURNING id, session_date, amount_cents, keep_cents, hold_days, release_on`,
    [id, now, localDate(now)],
  );
  if (!rows.length) {
    const early = await db.query("SELECT 1 FROM penalties WHERE id = $1 AND status = 'held' AND release_on > $2", [id, localDate(now)]);
    throw new CollectError(early.length ? "Not yet: the hold time isn't over." : "That one is already marked as given back.");
  }
  const p = rows[0];
  await logEvent(db, now, "collect", `${p.session_date}: friend marked ${p.amount_cents - p.keep_cents} cents as given back`);
  await safeNotify(db, notify, {
    title: `Given back: ${euros(p.amount_cents - p.keep_cents)}`,
    body: `For ${shortDate(p.session_date)}. You keep ${euros(p.keep_cents)}. Not you who marked it? Then someone else used your link.`,
    url: `/f/${await friendToken(db)}`,
  });
  return p;
}

async function safeNotify(db: Db, notify: NotifyPort, notice: Notice): Promise<boolean> {
  try {
    const r = await notify.notifyFriend(notice);
    return r.subscribers === 0 || r.sent > 0;
  } catch (e) {
    console.error("notify failed:", e);
    await logEvent(db, new Date(), "notify-problem", (e as Error).message).catch(() => {});
    return false;
  }
}

const KIND_WORD: Record<Kind, string> = { run: "run", strength: "strength workout" };

/** What the friend reads when a day was missed. Kind, day and money only: nothing from Strava. */
export function missNotice(owner: string, day: Ymd, kind: Kind, chargeCents: number, keep: number, method: Collection, url: string): Notice {
  const who = owner || "Your friend";
  const what = `${dayName(day)}'s ${KIND_WORD[kind]} (${shortDate(day)}) was skipped.`;
  if (chargeCents === 0) return { title: `${who} missed a workout`, body: `${what} This week's limit is reached, so it costs nothing more.`, url };
  const share = keep > 0 ? ` You keep ${euros(keep)} of it.` : "";
  const how = method === "friend" ? `Collect ${euros(chargeCents)} from ${owner || "them"}.` : `${euros(chargeCents)} is on its way to your account.`;
  return { title: `${who} missed a workout`, body: `${what} ${how}${share}`, url };
}

export function dueNotice(owner: string, day: Ymd, amountCents: number, keep: number, holdDays: number, url: string): Notice {
  const back = euros(amountCents - keep);
  const share = keep > 0 ? ` and keep ${euros(keep)}` : "";
  return {
    title: "Time to give money back",
    body: `You have held the ${euros(amountCents)} from ${shortDate(day)} for ${holdDays} days. Send ${back} back to ${owner || "your friend"}${share}.`,
    url,
  };
}

/**
 * Tells the friend about every real missed day not told yet, and about money whose hold
 * time is over. Runs after judging; a failure here never undoes or blocks a verdict.
 * Only the last few days are announced, so turning notifications on doesn't bring a flood.
 */
export async function tellFriend(db: Db, notify: NotifyPort, now: Date): Promise<number> {
  const today = localDate(now);
  const since = addDays(today, -4);
  const url = `/f/${await friendToken(db)}`;
  const owner = (await ownerDetails(db)).name;
  let told = 0;

  const misses = await db.query<{ date: string; kind: Kind; charge_cents: number; collection: Collection; keep_cents: number | null }>(
    `SELECT s.date, s.kind, s.charge_cents, s.collection, p.keep_cents FROM sessions s
     LEFT JOIN penalties p ON p.session_date = s.date
     WHERE s.status = 'missed' AND s.practice = false AND s.friend_notified_at IS NULL AND s.date >= $1
     ORDER BY s.date`,
    [since],
  );
  for (const m of misses) {
    const ok = await safeNotify(db, notify, missNotice(owner, m.date, m.kind, m.charge_cents, m.keep_cents ?? 0, m.collection, url));
    if (!ok) continue; // a push service had trouble: try again on the next run
    await db.query("UPDATE sessions SET friend_notified_at = $2 WHERE date = $1", [m.date, now]);
    told++;
  }

  const due = await db.query<{ id: number; session_date: string; amount_cents: number; keep_cents: number; hold_days: number }>(
    `SELECT id, session_date, amount_cents, keep_cents, hold_days FROM penalties
     WHERE status = 'held' AND release_on <= $1 AND release_on >= $2 AND due_notified_at IS NULL ORDER BY session_date`,
    [today, since],
  );
  for (const p of due) {
    const ok = await safeNotify(db, notify, dueNotice(owner, p.session_date, p.amount_cents, p.keep_cents, p.hold_days, url));
    if (!ok) continue;
    await db.query("UPDATE penalties SET due_notified_at = $2 WHERE id = $1", [p.id, now]);
    told++;
  }
  return told;
}
