// Sick days: a small monthly allowance of training days that cost nothing.
//
//  - A sick day is used for one training day, while that day is still open: on the day
//    itself, or just after midnight until it is judged at 03:00.
//  - It neither raises nor resets the miss multiplier. The day is treated as if it had
//    not been planned (see judgeDay in settle.ts).
//  - The allowance is counted per calendar month, by the date of the session, under the
//    rules in force on that day.
//  - Training anyway hands the sick day back: at judging, proof wins over the claim.

import type { Db } from "./db";
import type { Kind } from "./engine";
import { logEvent } from "./kv";
import { rulesFor } from "./rules";
import { type Ymd, addDays, isYmd, localDate, monthName, settleAfter, shortDate, weekdayOf } from "./time";

export class SickError extends Error {}

export interface SickOption {
  date: Ymd;
  kind: Kind;
  /** true when this day is marked as a sick day right now. */
  claimed: boolean;
  /** Sick days still free in that day's month. */
  left: number;
  limit: number;
}

export interface SickState {
  /** Days a sick day can be used for, or taken back from, right now: today, and yesterday until 03:00. */
  open: SickOption[];
  /** The current month's allowance. */
  month: { name: string; used: number; limit: number; left: number };
}

/** How many sick days are marked in the calendar month of the given day. */
export async function sickDaysUsed(db: Db, day: Ymd): Promise<number> {
  const rows = await db.query<{ n: number }>("SELECT COUNT(*)::int AS n FROM sick_days WHERE session_date LIKE $1", [`${day.slice(0, 7)}-%`]);
  return rows[0].n;
}

export async function isSickDay(db: Db, day: Ymd): Promise<boolean> {
  return (await db.query("SELECT 1 FROM sick_days WHERE session_date = $1", [day])).length > 0;
}

/**
 * stravaOn: whether Strava is connected. In practice mode without Strava no day is judged
 * at all, so a sick day there would be used up for nothing and is not offered.
 */
export async function sickState(db: Db, now: Date, stravaOn: boolean): Promise<SickState> {
  const today = localDate(now);
  const candidates: Ymd[] = [today];
  const yesterday = addDays(today, -1);
  // The window closes by the clock, not by when the day happens to get judged.
  if (now.getTime() < settleAfter(yesterday).getTime()) candidates.push(yesterday);

  const open: SickOption[] = [];
  for (const day of candidates) {
    const rules = (await rulesFor(db, day))?.rules;
    const kind = rules?.schedule[weekdayOf(day)];
    if (!rules || !kind) continue;
    if (!rules.armed && !stravaOn) continue;
    const judged = await db.query("SELECT 1 FROM sessions WHERE date = $1", [day]);
    if (judged.length) continue;
    const used = await sickDaysUsed(db, day);
    open.push({ date: day, kind, claimed: await isSickDay(db, day), left: Math.max(0, rules.sickDaysPerMonth - used), limit: rules.sickDaysPerMonth });
  }

  const limit = (await rulesFor(db, today))?.rules.sickDaysPerMonth ?? 0;
  const used = await sickDaysUsed(db, today);
  return { open, month: { name: monthName(today), used, limit, left: Math.max(0, limit - used) } };
}

/** Marks an open training day as a sick day. */
export async function claimSick(db: Db, now: Date, day: string, stravaOn: boolean): Promise<SickOption> {
  if (!isYmd(day)) throw new SickError("That is not a day.");
  const option = (await sickState(db, now, stravaOn)).open.find((o) => o.date === day);
  if (!option) throw new SickError("A sick day can only be used for a training day, on the day itself or until 03:00 the next morning.");
  if (option.claimed) throw new SickError(`${shortDate(day)} is already a sick day.`);
  if (option.limit === 0) throw new SickError("Sick days are switched off in the rules.");
  if (option.left === 0) throw new SickError(`All ${option.limit} sick days for ${monthName(day)} are used.`);

  // The count is checked again inside the statement, so two quick taps can't go over the limit.
  const rows = await db.query(
    `INSERT INTO sick_days (session_date, claimed_at)
     SELECT $1::text, $2::timestamptz
     WHERE (SELECT COUNT(*) FROM sick_days WHERE session_date LIKE $3) < $4::int
     ON CONFLICT (session_date) DO NOTHING
     RETURNING session_date`,
    [day, now, `${day.slice(0, 7)}-%`, option.limit],
  );
  if (rows.length === 0) throw new SickError(`All ${option.limit} sick days for ${monthName(day)} are used.`);
  await logEvent(db, now, "sick", `${day}: sick day used (${option.kind})`);
  return { ...option, claimed: true, left: option.left - 1 };
}

/** Takes a sick day back, as long as the day has not been judged. */
export async function unclaimSick(db: Db, now: Date, day: string, stravaOn: boolean): Promise<void> {
  if (!isYmd(day)) throw new SickError("That is not a day.");
  const option = (await sickState(db, now, stravaOn)).open.find((o) => o.date === day);
  if (!option || !option.claimed) throw new SickError("That sick day can't be taken back any more.");
  await db.query("DELETE FROM sick_days WHERE session_date = $1", [day]);
  await logEvent(db, now, "sick", `${day}: sick day taken back`);
}
