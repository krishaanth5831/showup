// The nightly job, in four steps:
//   1. judge   - every scheduled day whose deadline has passed gets a verdict: done or missed
//   2. pay     - every unpaid penalty is sent to the friend
//   3. returns - money the friend sent back is matched against what he holds
//   4. tidy    - old Strava details are thrown away
//
// It is written so it can run at any time, as often as you like, and after any outage:
// it always catches up from where it stopped, and it never charges or pays the same day twice.

import type { Db } from "./db";
import { type Activity, type Kind, type Rules, chargeFor, isValidIban, normalizeIban, qualifyingActivity } from "./engine";
import { acquireLock, kvGet, kvSet, logEvent, releaseLock } from "./kv";
import { BankError, type BankPayment, type BankPort, type StravaPort } from "./ports";
import { ensureRules, rulesFor } from "./rules";
import { type Ymd, addDays, datesBetween, lastSettleableDay, localDate, settleAfter, weekStart, weekdayOf, zonedToUtc } from "./time";

/** If Strava can't be reached, a day waits this long for it before being judged anyway. */
export const STRAVA_WAIT_HOURS = 72;
/** Strava's terms allow keeping activity details for at most 7 days. */
export const ACTIVITY_KEEP_DAYS = 7;
/** A payment we never got an answer for is looked up in the bank; after this long without a trace it is retried. */
export const SENDING_RETRY_MINUTES = 15;
/** Whatever the rules say, no single transfer made by this app is ever above this. */
export const HARD_MAX_CENTS = 50_000;

export interface Ports {
  strava: StravaPort;
  bank: BankPort;
}

export interface SettleReport {
  /** true when another run was already in progress and this one did nothing. */
  busy: boolean;
  judged: { date: Ymd; kind: Kind; status: "done" | "missed"; chargeCents: number; practice: boolean }[];
  /** Days that are waiting for Strava to come back. */
  waiting: Ymd[];
  paid: { date: Ymd; cents: number }[];
  payProblems: string[];
  returnedCents: number;
  notes: string[];
}

// ---------- activities cache ----------

interface ActivityRow {
  id: string;
  sport_type: string;
  name: string;
  local_date: string;
  start_time: string;
  distance_m: number;
  moving_s: number;
  elapsed_s: number;
  manual: boolean;
}

function activityFromRow(r: ActivityRow): Activity {
  return {
    id: r.id,
    sportType: r.sport_type,
    name: r.name,
    localDate: r.local_date,
    startTime: r.start_time,
    distanceM: r.distance_m,
    movingS: r.moving_s,
    elapsedS: r.elapsed_s,
    manual: r.manual,
  };
}

export async function activitiesOn(db: Db, from: Ymd, to: Ymd = from): Promise<Activity[]> {
  const rows = await db.query<ActivityRow>(
    "SELECT * FROM activities WHERE local_date >= $1 AND local_date <= $2 ORDER BY local_date, start_time",
    [from, to],
  );
  return rows.map(activityFromRow);
}

/**
 * Refreshes the local copy of Strava activities for a range of days. The copy mirrors Strava:
 * activities deleted there disappear here too. Throws when Strava can't be reached.
 */
export async function syncActivities(db: Db, strava: StravaPort, from: Ymd, to: Ymd, now: Date): Promise<number> {
  // Strava filters on real time while days are judged by the watch's local clock, so ask for a wider window.
  const after = Math.floor(zonedToUtc(addDays(from, -1)).getTime() / 1000);
  const before = Math.floor(zonedToUtc(addDays(to, 2)).getTime() / 1000);
  const acts = (await strava.fetchActivities(after, before)).filter((a) => a.localDate >= from && a.localDate <= to);
  await db.tx(async (t) => {
    await t.query("DELETE FROM activities WHERE local_date >= $1 AND local_date <= $2", [from, to]);
    for (const a of acts) {
      await t.query(
        `INSERT INTO activities (id, sport_type, name, local_date, start_time, distance_m, moving_s, elapsed_s, manual, fetched_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (id) DO NOTHING`,
        [a.id, a.sportType, a.name.slice(0, 200), a.localDate, a.startTime, a.distanceM, a.movingS, a.elapsedS, a.manual, now],
      );
    }
  });
  await kvSet(db, "strava_sync", { at: now.toISOString(), ok: true, error: null });
  return acts.length;
}

export async function pruneActivities(db: Db, today: Ymd): Promise<void> {
  await db.query("DELETE FROM activities WHERE local_date < $1", [addDays(today, -ACTIVITY_KEEP_DAYS)]);
}

// ---------- evidence ----------

export interface Evidence {
  done: boolean;
  source: "strava" | "proof" | null;
  activity: Activity | null;
  proofId: number | null;
}

/** What currently proves (or fails to prove) a day's session. */
export async function evidenceFor(db: Db, day: Ymd, kind: Kind, rules: Rules, acts?: Activity[]): Promise<Evidence> {
  const list = acts ?? (await activitiesOn(db, day));
  const activity = qualifyingActivity(list, day, kind, rules);
  if (activity) return { done: true, source: "strava", activity, proofId: null };
  if (kind === "strength") {
    const proof = await db.query<{ id: number }>("SELECT id FROM proofs WHERE session_date = $1", [day]);
    if (proof.length) return { done: true, source: "proof", activity: null, proofId: proof[0].id };
  }
  return { done: false, source: null, activity: null, proofId: null };
}

// ---------- step 1: judge ----------

export function penaltyRef(day: Ymd): string {
  return `SHOWUP-${day.replaceAll("-", "")}`;
}

interface SessionRow {
  date: string;
  practice: boolean;
  streak: number;
}

async function judgeDay(db: Db, day: Ymd, kind: Kind, rules: Rules, now: Date, note: string | null) {
  const practice = !rules.armed;
  const ev = await evidenceFor(db, day, kind, rules);
  return db.tx(async (t) => {
    const prev = await t.query<SessionRow>("SELECT date, practice, streak FROM sessions WHERE date < $1 ORDER BY date DESC LIMIT 1", [day]);
    // A streak never carries over between practice and real money.
    const prevStreak = prev.length && prev[0].practice === practice ? prev[0].streak : 0;
    let streak = 0;
    let raw = 0;
    let charge = 0;
    if (!ev.done) {
      streak = prevStreak + 1;
      const week = await t.query<{ total: number }>(
        "SELECT COALESCE(SUM(charge_cents), 0)::int AS total FROM sessions WHERE date >= $1 AND date < $2 AND practice = $3",
        [weekStart(day), day, practice],
      );
      const c = chargeFor(streak, week[0].total, rules);
      raw = c.rawCents;
      charge = c.cents;
    }
    const inserted = await t.query(
      `INSERT INTO sessions (date, kind, status, practice, source, activity_id, proof_id, streak, raw_cents, charge_cents, note, settled_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT (date) DO NOTHING RETURNING date`,
      [day, kind, ev.done ? "done" : "missed", practice, ev.source, ev.activity?.id ?? null, ev.proofId, streak, raw, charge, note, now],
    );
    if (inserted.length && !practice && charge > 0) {
      await t.query(
        `INSERT INTO penalties (session_date, amount_cents, friend_iban, friend_name, hold_days, ref, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (session_date) DO NOTHING`,
        [day, charge, normalizeIban(rules.friendIban), rules.friendName, rules.holdDays, penaltyRef(day), now],
      );
    }
    await t.query(
      `INSERT INTO kv (key, value, updated_at) VALUES ('cursor', $1, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [JSON.stringify(day)],
    );
    return { status: (ev.done ? "done" : "missed") as "done" | "missed", charge, practice, fresh: inserted.length > 0 };
  });
}

async function judge(db: Db, ports: Ports, now: Date, report: SettleReport): Promise<void> {
  const today = localDate(now);
  const cursor = (await kvGet<Ymd>(db, "cursor")) as Ymd;
  const last = lastSettleableDay(now);
  if (cursor >= last) return;

  const first = addDays(cursor, 1);
  const stravaOn = await ports.strava.connected();
  let synced = false;
  if (stravaOn) {
    try {
      await syncActivities(db, ports.strava, first, today, now);
      synced = true;
    } catch (e) {
      const msg = (e as Error).message;
      await kvSet(db, "strava_sync", { at: now.toISOString(), ok: false, error: msg });
      report.notes.push(`Strava could not be read: ${msg}`);
    }
  }

  for (const day of datesBetween(first, last)) {
    const version = await rulesFor(db, day);
    const kind = version?.rules.schedule[weekdayOf(day)];
    // Rest days, and practice days without Strava (nothing to check a run against), are skipped.
    if (!version || !kind || (!version.rules.armed && !stravaOn)) {
      await kvSet(db, "cursor", day);
      continue;
    }
    let note: string | null = null;
    if (!synced) {
      const giveUpAt = settleAfter(day).getTime() + STRAVA_WAIT_HOURS * 3_600_000;
      if (now.getTime() < giveUpAt) {
        // Don't charge for something we couldn't check. Try again on the next run.
        report.waiting = datesBetween(day, last).filter((d) => d >= day);
        return;
      }
      note = `Judged without Strava: it could not be reached for ${STRAVA_WAIT_HOURS} hours.`;
    }
    const res = await judgeDay(db, day, kind, version.rules, now, note);
    if (res.fresh) {
      report.judged.push({ date: day, kind, status: res.status, chargeCents: res.charge, practice: res.practice });
      if (res.status === "missed") {
        await logEvent(db, now, "miss", `${day}: missed ${kind}${res.practice ? " (practice)" : `, ${res.charge} cents`}`);
      }
    }
  }
}

// ---------- step 2: pay ----------

interface PenaltyRow {
  id: number;
  session_date: string;
  amount_cents: number;
  status: string;
  friend_iban: string;
  friend_name: string;
  hold_days: number;
  ref: string;
  attempts: number;
  sending_at: Date | null;
  sent_at: Date | null;
}

async function markHeld(db: Db, p: PenaltyRow, bankId: string, sentAt: Date): Promise<void> {
  await db.query(
    `UPDATE penalties SET status = 'held', bank_payment_id = $2, sent_at = $3, release_on = $4, last_error = NULL
     WHERE id = $1 AND status IN ('owed', 'sending')`,
    [p.id, bankId, sentAt, addDays(localDate(sentAt), p.hold_days)],
  );
}

async function payOwed(db: Db, bank: BankPort, now: Date, payments: BankPayment[], report: SettleReport): Promise<void> {
  const open = await db.query<PenaltyRow>("SELECT * FROM penalties WHERE status IN ('owed', 'sending') ORDER BY session_date");
  for (const p of open) {
    // First look in the bank: if a transfer with this penalty's reference exists, it was already paid.
    const existing = payments.find((x) => x.amountCents < 0 && x.description.includes(p.ref));
    if (existing) {
      await markHeld(db, p, existing.id, existing.created);
      report.paid.push({ date: p.session_date, cents: p.amount_cents });
      continue;
    }
    if (p.status === "sending") {
      const age = now.getTime() - (p.sending_at?.getTime() ?? 0);
      if (age < SENDING_RETRY_MINUTES * 60_000) continue; // too fresh to conclude anything
      await db.query("UPDATE penalties SET status = 'owed' WHERE id = $1 AND status = 'sending'", [p.id]);
    }
    if (p.amount_cents > HARD_MAX_CENTS || !isValidIban(p.friend_iban) || !p.friend_name) {
      const why = p.amount_cents > HARD_MAX_CENTS ? "amount above the hard safety limit" : "the friend's name or IBAN is missing or invalid";
      await db.query("UPDATE penalties SET last_error = $2 WHERE id = $1", [p.id, `Not sent: ${why}.`]);
      report.payProblems.push(`${p.session_date}: ${why}`);
      continue;
    }
    // Claim it. Only one runner can move a penalty from owed to sending.
    const claimed = await db.query(
      "UPDATE penalties SET status = 'sending', sending_at = $2, attempts = attempts + 1 WHERE id = $1 AND status = 'owed' RETURNING id",
      [p.id, now],
    );
    if (!claimed.length) continue;
    try {
      const res = await bank.pay({
        amountCents: p.amount_cents,
        iban: p.friend_iban,
        name: p.friend_name,
        description: `${p.ref} missed workout, hold ${p.hold_days} days`,
      });
      await markHeld(db, p, res.id, now);
      report.paid.push({ date: p.session_date, cents: p.amount_cents });
      await logEvent(db, now, "paid", `${p.session_date}: sent ${p.amount_cents} cents to ${p.friend_name}`);
    } catch (e) {
      const err = e instanceof BankError ? e : new BankError((e as Error).message, false);
      if (err.definite) {
        // The bank said no: nothing left the account. It stays owed and is tried again next run.
        await db.query("UPDATE penalties SET status = 'owed', last_error = $2 WHERE id = $1", [p.id, err.message]);
      } else {
        // No clear answer: leave it as "sending" so the next run looks it up before doing anything.
        await db.query("UPDATE penalties SET last_error = $2 WHERE id = $1", [p.id, err.message]);
      }
      report.payProblems.push(`${p.session_date}: ${err.message}`);
      await logEvent(db, now, "pay-problem", `${p.session_date}: ${err.message}`);
      // Out of money or locked out: the rest would fail the same way.
      if (err.kind === "funds" || err.kind === "auth") break;
    }
  }
}

// ---------- step 3: returns ----------

/** A transfer from the friend counts as "giving it back" when its description mentions showup. */
export function looksLikeReturn(description: string): boolean {
  return /show\s?-?up/i.test(description);
}

/**
 * Spreads everything the friend has given back over the penalties held, oldest miss first.
 * Recomputed from scratch each time, so it can't drift.
 */
export async function allocateReturns(db: Db, now: Date): Promise<number> {
  const pool = await db.query<{ total: number }>("SELECT COALESCE(SUM(amount_cents), 0)::int AS total FROM incoming WHERE is_return");
  let left = pool[0].total;
  const rows = await db.query<{ id: number; amount_cents: number; status: string; returned_cents: number; returned_at: Date | null }>(
    "SELECT id, amount_cents, status, returned_cents, returned_at FROM penalties WHERE status IN ('held', 'returned') ORDER BY session_date",
  );
  let total = 0;
  for (const p of rows) {
    const give = Math.min(p.amount_cents, left);
    left -= give;
    total += give;
    const status = give >= p.amount_cents ? "returned" : "held";
    if (give !== p.returned_cents || status !== p.status) {
      await db.query("UPDATE penalties SET returned_cents = $2, status = $3, returned_at = $4 WHERE id = $1", [
        p.id,
        give,
        status,
        status === "returned" ? (p.returned_at ?? now) : null,
      ]);
    }
  }
  return total;
}

async function trackReturns(db: Db, now: Date, payments: BankPayment[]): Promise<number> {
  const sent = await db.query<{ friend_iban: string; first: Date }>(
    "SELECT friend_iban, MIN(sent_at) AS first FROM penalties WHERE sent_at IS NOT NULL GROUP BY friend_iban",
  );
  if (sent.length === 0) return 0;
  const since = new Map(sent.map((r) => [normalizeIban(r.friend_iban), new Date(r.first).getTime()]));
  for (const x of payments) {
    const first = since.get(normalizeIban(x.counterpartyIban));
    if (x.amountCents <= 0 || first === undefined || x.created.getTime() < first) continue;
    await db.query(
      `INSERT INTO incoming (bank_payment_id, amount_cents, bank_created, iban, name, description, is_return, seen_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (bank_payment_id) DO NOTHING`,
      [x.id, x.amountCents, x.created.toISOString(), normalizeIban(x.counterpartyIban), x.counterpartyName, x.description.slice(0, 300), looksLikeReturn(x.description), now],
    );
  }
  return allocateReturns(db, now);
}

// ---------- the whole run ----------

async function money(db: Db, bank: BankPort, now: Date, report: SettleReport): Promise<void> {
  const open = await db.query("SELECT 1 FROM penalties WHERE status IN ('owed', 'sending', 'held') LIMIT 1");
  if (open.length === 0) return;
  if (!(await bank.connected())) {
    const owed = await db.query("SELECT 1 FROM penalties WHERE status IN ('owed', 'sending') LIMIT 1");
    if (owed.length) report.payProblems.push("The bank is not connected, so penalties can't be sent.");
    return;
  }
  let payments: BankPayment[];
  try {
    const seen = await kvGet<string>(db, "bank_seen_id");
    payments = await bank.listPayments(seen);
    const newest = payments.reduce((m, p) => Math.max(m, Number(p.id)), Number(seen ?? 0));
    if (newest) await kvSet(db, "bank_seen_id", String(newest));
    await kvSet(db, "bank_check", { at: now.toISOString(), ok: true, error: null });
  } catch (e) {
    const msg = (e as Error).message;
    await kvSet(db, "bank_check", { at: now.toISOString(), ok: false, error: msg });
    report.payProblems.push(`The bank could not be read: ${msg}`);
    return; // without the payment list nothing can be double-checked, so nothing is sent
  }
  await payOwed(db, bank, now, payments, report);
  report.returnedCents = await trackReturns(db, now, payments);
}

export async function runSettlement(db: Db, ports: Ports, now: Date = new Date()): Promise<SettleReport> {
  const report: SettleReport = { busy: false, judged: [], waiting: [], paid: [], payProblems: [], returnedCents: 0, notes: [] };
  if (!(await acquireLock(db, "settle", 180))) return { ...report, busy: true };
  try {
    const today = localDate(now);
    await ensureRules(db, today);
    await judge(db, ports, now, report);
    await money(db, ports.bank, now, report);
    await pruneActivities(db, today);
    await kvSet(db, "last_run", { at: now.toISOString(), judged: report.judged.length, problems: report.payProblems.length });
  } finally {
    await releaseLock(db, "settle");
  }
  return report;
}

/** true when there is at least one day that could be judged right now. */
export async function settlementDue(db: Db, now: Date): Promise<boolean> {
  const cursor = await kvGet<Ymd>(db, "cursor");
  if (cursor === null) return true;
  if (cursor < lastSettleableDay(now)) return true;
  const owed = await db.query("SELECT 1 FROM penalties WHERE status IN ('owed', 'sending') LIMIT 1");
  return owed.length > 0;
}
