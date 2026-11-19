// Read-only summaries for the screens. Nothing in here changes data.

import { type BunqState, loadBunq } from "./bunq";
import { loadClaude } from "./claude";
import type { Db } from "./db";
import { type Activity, type Kind, type Rules, chargeFor, km, whyNot } from "./engine";
import { kvGet, kvSet } from "./kv";
import { type CheckStatus, proofTargets } from "./proofs";
import { type RuleState, describeChanges, ruleState, rulesFor } from "./rules";
import { activitiesOn, evidenceFor } from "./settle";
import { type SickState, sickDaysUsed, sickState } from "./sick";
import { loadStrava, stravaLinked } from "./strava";
import { randomToken } from "./secrets";
import { checksOn } from "./work";
import { type Ymd, addDays, datesBetween, localDate, monthName, shortDate, weekStart, weekdayOf, zonedToUtc } from "./time";

export type DayState = "done" | "missed" | "sick" | "due" | "checking" | "upcoming" | "rest";

export interface DayView {
  date: Ymd;
  kind: Kind | null;
  state: DayState;
  chargeCents: number;
  practice: boolean;
  isToday: boolean;
}

export interface TodayView {
  date: Ymd;
  kind: Kind | null;
  state: DayState;
  source: "strava" | "proof" | null;
  /** Shown to the owner only. */
  activity: Activity | null;
  proofId: number | null;
  /** A photo was sent in and is waiting for Claude to check it. */
  photoWaiting: boolean;
  /** What Claude read from the photo that counts, in one line. */
  photoSummary: string | null;
  hint: string | null;
  /** Midnight tonight, as an ISO instant. */
  deadline: string;
  costIfMissedCents: number;
  /** The days a photo uploaded now can count for: today, and yesterday until 03:00. */
  uploads: { date: Ymd; kind: Kind }[];
  /** false until a Claude API key is saved: photos can't be checked without it. */
  photoCheck: boolean;
}

export interface Alert {
  tone: "warn" | "info";
  text: string;
  href?: string;
  action?: string;
}

export interface Dashboard {
  today: TodayView;
  week: DayView[];
  rules: Rules;
  mode: "practice" | "armed";
  armsOn: Ymd | null;
  missStreak: number;
  nextMissCents: number;
  weekChargedCents: number;
  heldCents: number;
  owedCents: number;
  friendName: string;
  /** Sick days: what is left this month and which open days one can be used for. */
  sick: SickState;
  alerts: Alert[];
}

interface SessionRow {
  date: string;
  kind: Kind;
  status: "done" | "missed" | "sick";
  practice: boolean;
  source: "strava" | "proof" | null;
  activity_id: string | null;
  proof_id: number | null;
  streak: number;
  raw_cents: number;
  charge_cents: number;
  note: string | null;
}

interface PenaltyRow {
  id: number;
  session_date: string;
  amount_cents: number;
  status: "owed" | "sending" | "held" | "returned";
  friend_name: string;
  friend_iban: string;
  sent_at: Date | null;
  release_on: string | null;
  returned_cents: number;
  returned_at: Date | null;
  last_error: string | null;
}

export interface Totals {
  heldCents: number;
  owedCents: number;
  returnedCents: number;
  everCents: number;
}

export async function totals(db: Db): Promise<Totals> {
  const rows = await db.query<{ status: string; amount: number; returned: number }>(
    "SELECT status, COALESCE(SUM(amount_cents), 0)::int AS amount, COALESCE(SUM(returned_cents), 0)::int AS returned FROM penalties GROUP BY status",
  );
  const t: Totals = { heldCents: 0, owedCents: 0, returnedCents: 0, everCents: 0 };
  for (const r of rows) {
    t.everCents += r.amount;
    t.returnedCents += r.returned;
    if (r.status === "held") t.heldCents += r.amount - r.returned;
    if (r.status === "owed" || r.status === "sending") t.owedCents += r.amount;
  }
  return t;
}

export async function dashboard(db: Db, now: Date): Promise<Dashboard> {
  const today = localDate(now);
  const state = await ruleState(db, today);
  const rules = state.current.rules;
  const monday = weekStart(today);
  const days = datesBetween(monday, addDays(monday, 6));

  const settled = new Map(
    (await db.query<SessionRow>("SELECT * FROM sessions WHERE date >= $1 AND date <= $2", [monday, days[6]])).map((s) => [s.date, s]),
  );
  const acts = await activitiesOn(db, monday, today);
  const sickDates = new Set(
    (await db.query<{ session_date: string }>("SELECT session_date FROM sick_days WHERE session_date >= $1 AND session_date <= $2", [monday, days[6]])).map(
      (r) => r.session_date,
    ),
  );

  const week: DayView[] = [];
  let todayView: TodayView | null = null;
  for (const d of days) {
    const r = (await rulesFor(db, d))?.rules ?? rules;
    const kind = r.schedule[weekdayOf(d)] ?? null;
    const row = settled.get(d);
    let dayState: DayState = "rest";
    let source: TodayView["source"] = null;
    let activity: Activity | null = null;
    let proofId: number | null = null;
    let photoWaiting = false;
    let photoSummary: string | null = null;
    if (row) {
      dayState = row.status;
      source = row.source;
      proofId = row.proof_id;
      activity = acts.find((a) => a.id === row.activity_id) ?? null;
    } else if (kind && d > today) {
      dayState = "upcoming";
    } else if (kind) {
      const ev = await evidenceFor(db, d, kind, r, acts);
      // Proof wins over a sick day: training anyway hands the sick day back.
      dayState = ev.done ? "done" : sickDates.has(d) ? "sick" : d === today ? "due" : "checking";
      source = ev.source;
      activity = ev.activity;
      proofId = ev.proofId;
      photoWaiting = ev.waiting;
      photoSummary = ev.photoSummary;
    }
    if (row?.source === "proof" && row.proof_id) {
      const p = await db.query<{ reading: { summary?: string } | string | null }>("SELECT reading FROM proofs WHERE id = $1", [row.proof_id]);
      const reading = p[0]?.reading;
      photoSummary = (typeof reading === "string" ? JSON.parse(reading) : reading)?.summary ?? null;
    }
    week.push({ date: d, kind: row?.kind ?? kind, state: dayState, chargeCents: row?.charge_cents ?? 0, practice: row ? row.practice : !r.armed, isToday: d === today });
    if (d === today) {
      todayView = {
        date: d,
        kind,
        state: dayState,
        source,
        activity,
        proofId,
        photoWaiting,
        photoSummary,
        hint: kind && dayState === "due" ? whyNot(acts, d, kind, r) : null,
        deadline: zonedToUtc(addDays(d, 1)).toISOString(),
        costIfMissedCents: 0,
        uploads: [],
        photoCheck: false,
      };
    }
  }

  // Where the multiplier stands: the last judged session in the current mode.
  const practice = !rules.armed;
  const last = await db.query<SessionRow>("SELECT * FROM sessions ORDER BY date DESC LIMIT 1");
  const missStreak = last.length && last[0].practice === practice ? last[0].streak : 0;
  const weekRows = await db.query<{ total: number }>(
    "SELECT COALESCE(SUM(charge_cents), 0)::int AS total FROM sessions WHERE date >= $1 AND date <= $2 AND practice = $3",
    [monday, days[6], practice],
  );
  const weekChargedCents = weekRows[0].total;
  const next = chargeFor(missStreak + 1, weekChargedCents, rules);

  const t = await totals(db);
  const tv = todayView as TodayView;
  tv.costIfMissedCents = next.cents;
  tv.uploads = await proofTargets(db, now);
  tv.photoCheck = !!(await loadClaude(db))?.apiKey;

  return {
    today: tv,
    week,
    rules,
    mode: rules.armed ? "armed" : "practice",
    armsOn: !rules.armed && state.pending?.rules.armed ? state.pending.effectiveFrom : null,
    missStreak,
    nextMissCents: next.cents,
    weekChargedCents,
    heldCents: t.heldCents,
    owedCents: t.owedCents,
    friendName: rules.friendName,
    sick: await sickState(db, now, await checksOn(db)),
    alerts: await alerts(db, state, t),
  };
}

interface CheckState {
  at: string;
  ok: boolean;
  error: string | null;
}

async function alerts(db: Db, state: RuleState, t: Totals): Promise<Alert[]> {
  const out: Alert[] = [];
  const rules = state.current.rules;
  const willBeArmed = rules.armed || !!state.pending?.rules.armed;
  const strava = await loadStrava(db);
  const bunq = await loadBunq(db);

  if (!(await loadClaude(db))?.apiKey) {
    out.push({ tone: willBeArmed ? "warn" : "info", text: "No Claude API key yet, so workout photos can't be checked.", href: "/settings#photos", action: "Add" });
  }
  const refused = await kvGet<{ day: Ymd; why: string; at: string }>(db, "photo_refused");
  if (refused && Date.now() - new Date(refused.at).getTime() < 3 * 86_400_000) {
    out.push({ tone: "warn", text: `The photo for ${shortDate(refused.day)} was checked late and did not count: ${refused.why}` });
  }
  const waiting = await db.query<{ check_error: string | null }>("SELECT check_error FROM proofs WHERE check_status = 'waiting' ORDER BY session_date LIMIT 1");
  if (waiting.length) {
    out.push({
      tone: "info",
      text: `A photo is waiting to be checked${waiting[0].check_error ? ` (${waiting[0].check_error})` : ""}. Its day won't be judged before then.`,
    });
  }
  if (stravaLinked(strava)) {
    const sync = await kvGet<CheckState>(db, "strava_sync");
    if (sync && !sync.ok) out.push({ tone: "warn", text: `Strava could not be read. ${sync.error ?? ""}`.trim(), href: "/settings#strava", action: "Check" });
  }
  if (willBeArmed && !bunq?.accountId) {
    out.push({ tone: "warn", text: "No bank connected. Penalties pile up as unpaid until bunq is connected.", href: "/settings#bank", action: "Connect" });
  }
  if (t.owedCents > 0) {
    const err = await db.query<{ last_error: string | null }>(
      "SELECT last_error FROM penalties WHERE status IN ('owed','sending') AND last_error IS NOT NULL ORDER BY session_date LIMIT 1",
    );
    out.push({
      tone: "warn",
      text: `${formatEuro(t.owedCents)} in penalties has not been sent yet.${err.length ? ` ${err[0].last_error}` : ""}`,
      href: "/history",
      action: "Details",
    });
  }
  if (state.pending) {
    const what = describeChanges(rules, state.pending.rules).join(", ");
    out.push({ tone: "info", text: `From ${state.pending.effectiveFrom}: ${what || "updated rules"}.`, href: "/settings#rules", action: "View" });
  }
  return out;
}

function formatEuro(cents: number): string {
  return `€${(cents / 100).toFixed(cents % 100 === 0 ? 0 : 2)}`;
}

// ---------- history ----------

export interface HistoryRow {
  date: Ymd;
  kind: Kind;
  status: "done" | "missed" | "sick";
  practice: boolean;
  source: "strava" | "proof" | null;
  proofId: number | null;
  streak: number;
  rawCents: number;
  chargeCents: number;
  note: string | null;
  penalty: null | {
    status: PenaltyRow["status"];
    friendName: string;
    releaseOn: Ymd | null;
    /** true once the hold time is over. */
    releasable: boolean;
    returnedCents: number;
    error: string | null;
  };
}

export interface IncomingRow {
  id: string;
  date: Ymd;
  amountCents: number;
  name: string;
  description: string;
  isReturn: boolean;
}

export interface History {
  weeks: { monday: Ymd; rows: HistoryRow[]; chargedCents: number }[];
  incoming: IncomingRow[];
  totals: Totals;
  friendName: string;
}

export async function history(db: Db, now: Date): Promise<History> {
  const today = localDate(now);
  const rules = (await ruleState(db, today)).current.rules;
  const sessions = await db.query<SessionRow>("SELECT * FROM sessions ORDER BY date DESC LIMIT 200");
  const pens = new Map((await db.query<PenaltyRow>("SELECT * FROM penalties")).map((p) => [p.session_date, p]));
  const weeks = new Map<Ymd, HistoryRow[]>();
  for (const s of sessions) {
    const p = pens.get(s.date);
    const row: HistoryRow = {
      date: s.date,
      kind: s.kind,
      status: s.status,
      practice: s.practice,
      source: s.source,
      proofId: s.proof_id,
      streak: s.streak,
      rawCents: s.raw_cents,
      chargeCents: s.charge_cents,
      note: s.note,
      penalty: p
        ? {
            status: p.status,
            friendName: p.friend_name,
            releaseOn: p.release_on,
            releasable: !!p.release_on && p.release_on <= today,
            returnedCents: p.returned_cents,
            error: p.last_error,
          }
        : null,
    };
    const monday = weekStart(s.date);
    weeks.set(monday, [...(weeks.get(monday) ?? []), row]);
  }
  const incoming = await db.query<{ bank_payment_id: string; amount_cents: number; bank_created: string; name: string; description: string; is_return: boolean }>(
    "SELECT * FROM incoming ORDER BY bank_created DESC LIMIT 50",
  );
  return {
    weeks: [...weeks.entries()].map(([monday, rows]) => ({
      monday,
      rows,
      chargedCents: rows.filter((r) => !r.practice).reduce((s, r) => s + r.chargeCents, 0),
    })),
    incoming: incoming.map((i) => ({
      id: i.bank_payment_id,
      date: localDate(new Date(i.bank_created)),
      amountCents: i.amount_cents,
      name: i.name,
      description: i.description,
      isReturn: i.is_return,
    })),
    totals: await totals(db),
    friendName: rules.friendName,
  };
}

// ---------- the friend's page ----------
// Money and uploaded screenshots only. Nothing that comes from Strava is shown here:
// Strava's terms don't allow showing an athlete's data to other people.

export interface FriendTransfer {
  date: Ymd;
  amountCents: number;
  status: "held" | "returned" | "owed";
  sentOn: Ymd | null;
  releaseOn: Ymd | null;
  returnedCents: number;
  /** true when the hold time is over and it has not been fully returned. */
  due: boolean;
}

export interface FriendView {
  friendName: string;
  ownerName: string;
  ownerIban: string;
  holdDays: number;
  heldCents: number;
  dueCents: number;
  owedCents: number;
  returnedCents: number;
  transfers: FriendTransfer[];
  proofs: { id: number; date: Ymd; kind: Kind; summary: string | null; checked: boolean }[];
  /** Sick days used in the current month, for the friend to keep an eye on. */
  sick: { month: string; used: number; limit: number };
}

export async function friendToken(db: Db): Promise<string> {
  let token = await kvGet<string>(db, "friend_token");
  if (!token) {
    token = randomToken(18);
    await kvSet(db, "friend_token", token);
  }
  return token;
}

export async function friendView(db: Db, now: Date): Promise<FriendView> {
  const today = localDate(now);
  const rules = (await ruleState(db, today)).current.rules;
  const bunq: BunqState | null = await loadBunq(db);
  const pens = await db.query<PenaltyRow>("SELECT * FROM penalties ORDER BY session_date DESC LIMIT 100");
  const transfers: FriendTransfer[] = pens.map((p) => {
    const status = p.status === "sending" ? "owed" : p.status;
    const due = status === "held" && !!p.release_on && p.release_on <= today;
    return {
      date: p.session_date,
      amountCents: p.amount_cents,
      status,
      sentOn: p.sent_at ? localDate(new Date(p.sent_at)) : null,
      releaseOn: p.release_on,
      returnedCents: p.returned_cents,
      due,
    };
  });
  const t = await totals(db);
  const proofs = await db.query<{ id: number; session_date: string; kind: Kind; check_status: CheckStatus; reading: { summary?: string } | string | null }>(
    "SELECT id, session_date, kind, check_status, reading FROM proofs WHERE session_date >= $1 AND check_status <> 'waiting' ORDER BY session_date DESC",
    [addDays(today, -35)],
  );
  return {
    friendName: rules.friendName,
    ownerName: bunq?.accountName ?? "",
    ownerIban: bunq?.accountIban ?? "",
    holdDays: rules.holdDays,
    heldCents: t.heldCents,
    dueCents: transfers.filter((x) => x.due).reduce((s, x) => s + x.amountCents - x.returnedCents, 0),
    owedCents: t.owedCents,
    returnedCents: t.returnedCents,
    transfers,
    proofs: proofs.map((p) => ({
      id: p.id,
      date: p.session_date,
      kind: p.kind,
      summary: (typeof p.reading === "string" ? JSON.parse(p.reading) : p.reading)?.summary ?? null,
      checked: p.check_status === "accepted" && !!p.reading,
    })),
    sick: { month: monthName(today), used: await sickDaysUsed(db, today), limit: rules.sickDaysPerMonth },
  };
}

// ---------- settings ----------

export interface SettingsView {
  rules: RuleState;
  pendingChanges: string[];
  today: Ymd;
  strava: { hasApp: boolean; linked: boolean; clientId: string; athleteName: string; lastSync: CheckState | null };
  claude: { connected: boolean; hint: string; connectedAt: string | null };
  bank: { connected: boolean; env: "sandbox" | "production" | null; userName: string; accountLabel: string; accountIban: string; accountName: string; lastCheck: CheckState | null };
  friendLink: string;
  lastRun: { at: string; judged: number; problems: number } | null;
  canArm: { ok: boolean; missing: string[] };
}

export async function settingsView(db: Db, now: Date): Promise<SettingsView> {
  const today = localDate(now);
  const rules = await ruleState(db, today);
  const strava = await loadStrava(db);
  const bunq = await loadBunq(db);
  const claude = await loadClaude(db);
  const r = rules.current.rules;
  const missing: string[] = [];
  if (!claude?.apiKey) missing.push("add a Claude API key");
  if (!bunq?.accountId) missing.push("connect bunq");
  if (!r.friendName || !r.friendIban) missing.push("add your friend's name and IBAN");
  return {
    rules,
    pendingChanges: rules.pending ? describeChanges(r, rules.pending.rules) : [],
    today,
    strava: {
      hasApp: !!strava?.clientId,
      linked: stravaLinked(strava),
      clientId: strava?.clientId ?? "",
      athleteName: strava?.athleteName ?? "",
      lastSync: await kvGet<CheckState>(db, "strava_sync"),
    },
    claude: { connected: !!claude?.apiKey, hint: claude?.hint ?? "", connectedAt: claude?.connectedAt ?? null },
    bank: {
      connected: !!bunq?.accountId,
      env: bunq?.env ?? null,
      userName: bunq?.userName ?? "",
      accountLabel: bunq?.accountLabel ?? "",
      accountIban: bunq?.accountIban ?? "",
      accountName: bunq?.accountName ?? "",
      lastCheck: await kvGet<CheckState>(db, "bank_check"),
    },
    friendLink: `/f/${await friendToken(db)}`,
    lastRun: await kvGet(db, "last_run"),
    canArm: { ok: missing.length === 0, missing },
  };
}

export { km };
