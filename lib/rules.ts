// Versioned rules. The point of this app is that future-you can't wriggle out, so once
// the app is armed, any change to the rules (including switching it off, or changing who
// receives the money) only takes effect LOCK_DAYS later. Days already judged never change.

import type { Db } from "./db";
import { DEFAULT_RULES, type Rules, normalizeIban, validateRules } from "./engine";
import { kvGet, kvSet } from "./kv";
import { type Ymd, addDays } from "./time";

/** How long a rule change waits before it applies, once the app is armed. */
export const LOCK_DAYS = 7;

export interface RuleVersion {
  id: number;
  effectiveFrom: Ymd;
  rules: Rules;
}

interface Row {
  id: number;
  effective_from: string;
  config: Rules | string;
}

function fromRow(row: Row): RuleVersion {
  const config = typeof row.config === "string" ? (JSON.parse(row.config) as Rules) : row.config;
  return { id: row.id, effectiveFrom: row.effective_from, rules: { ...DEFAULT_RULES, ...config } };
}

async function insertVersion(db: Db, effectiveFrom: Ymd, rules: Rules): Promise<void> {
  await db.query("INSERT INTO rules (effective_from, config) VALUES ($1, $2::jsonb)", [
    effectiveFrom,
    JSON.stringify(rules),
  ]);
}

/**
 * Makes sure a first rule set exists. Judging starts the day the app was first opened:
 * the "cursor" is the last day that has been dealt with.
 */
export async function ensureRules(db: Db, today: Ymd): Promise<void> {
  const rows = await db.query("SELECT id FROM rules LIMIT 1");
  if (rows.length === 0) await insertVersion(db, today, DEFAULT_RULES);
  if ((await kvGet<Ymd>(db, "cursor")) === null) await kvSet(db, "cursor", addDays(today, -1));
}

/** The rules in force on a given day, or null for days before the app existed. */
export async function rulesFor(db: Db, day: Ymd): Promise<RuleVersion | null> {
  const rows = await db.query<Row>(
    "SELECT id, effective_from, config FROM rules WHERE effective_from <= $1 ORDER BY effective_from DESC, id DESC LIMIT 1",
    [day],
  );
  return rows.length ? fromRow(rows[0]) : null;
}

export interface RuleState {
  current: RuleVersion;
  /** A change that is waiting to take effect, if any. */
  pending: RuleVersion | null;
  /** true when changes are delayed because real money is on the line today. */
  locked: boolean;
}

export async function ruleState(db: Db, today: Ymd): Promise<RuleState> {
  await ensureRules(db, today);
  const current = (await rulesFor(db, today)) as RuleVersion;
  const future = await db.query<Row>(
    "SELECT id, effective_from, config FROM rules WHERE effective_from > $1 ORDER BY effective_from DESC, id DESC LIMIT 1",
    [today],
  );
  return { current, pending: future.length ? fromRow(future[0]) : null, locked: current.rules.armed };
}

export class RuleError extends Error {}

function clean(input: Rules): Rules {
  const schedule: Rules["schedule"] = {};
  for (const [day, kind] of Object.entries(input.schedule)) {
    if (kind === "run" || kind === "strength") schedule[day as keyof Rules["schedule"]] = kind;
  }
  return {
    ...input,
    schedule,
    friendName: input.friendName.trim(),
    friendIban: normalizeIban(input.friendIban),
  };
}

export interface SaveResult {
  /** The day the change starts to apply. */
  effectiveFrom: Ymd;
  delayed: boolean;
}

/** Saves edited rules. The armed flag is never changed here: see arm() and disarm(). */
export async function saveRules(db: Db, today: Ymd, input: Rules): Promise<SaveResult> {
  const state = await ruleState(db, today);
  const next = clean({ ...input, armed: state.current.rules.armed });
  const problems = validateRules(next);
  if (problems.length) throw new RuleError(problems.join(" "));

  if (state.locked) {
    if (state.pending) throw new RuleError("A change is already waiting. Cancel it before making another one.");
    if (!next.friendName) throw new RuleError("While armed, the friend's name can't be empty.");
    if (next.collection === "bank" && !next.friendIban) throw new RuleError("While bunq sends the money, the friend's IBAN can't be empty.");
    const effectiveFrom = addDays(today, LOCK_DAYS);
    await insertVersion(db, effectiveFrom, next);
    return { effectiveFrom, delayed: true };
  }

  // Not armed today: the edit applies right away. If arming is already planned,
  // the planned version gets the same edit.
  await db.tx(async (t) => {
    await t.query("DELETE FROM rules WHERE effective_from > $1", [today]);
    await insertVersion(t, today, next);
    if (state.pending) await insertVersion(t, state.pending.effectiveFrom, { ...next, armed: state.pending.rules.armed });
  });
  return { effectiveFrom: today, delayed: false };
}

/** Switches real money on, starting tomorrow (today's session can't cost anything retroactively). */
export async function arm(db: Db, today: Ymd): Promise<Ymd> {
  const state = await ruleState(db, today);
  if (state.locked) throw new RuleError("Already armed.");
  if (state.pending) throw new RuleError("Arming is already planned.");
  const r = state.current.rules;
  if (!r.friendName) throw new RuleError("Add your friend's name first.");
  if (r.collection === "bank" && !r.friendIban) throw new RuleError("Add your friend's IBAN first: bunq needs it to send the money.");
  const problems = validateRules(r);
  if (problems.length) throw new RuleError(problems.join(" "));
  const from = addDays(today, 1);
  await insertVersion(db, from, { ...r, armed: true });
  return from;
}

/** Switches real money off, LOCK_DAYS from now. */
export async function disarm(db: Db, today: Ymd): Promise<Ymd> {
  const state = await ruleState(db, today);
  if (!state.locked) throw new RuleError("Not armed.");
  if (state.pending) throw new RuleError("A change is already waiting. Cancel it before making another one.");
  const from = addDays(today, LOCK_DAYS);
  await insertVersion(db, from, { ...state.current.rules, armed: false });
  return from;
}

/** Drops a waiting change, so things stay as they are today. */
export async function cancelPending(db: Db, today: Ymd): Promise<void> {
  await db.query("DELETE FROM rules WHERE effective_from > $1", [today]);
}

const FIELD_LABELS: Record<string, string> = {
  armed: "real money",
  schedule: "training days",
  minRunKm: "minimum run distance",
  minStrengthMin: "minimum workout length",
  baseCents: "first-miss cost",
  multiplier: "multiplier",
  capPerMissCents: "cap per miss",
  capPerWeekCents: "weekly cap",
  holdDays: "hold time",
  sickDaysPerMonth: "number of sick days",
  collection: "way of collecting the money",
  friendKeepsPercent: "share the friend keeps",
  friendName: "friend's name",
  friendIban: "friend's IBAN",
};

/** Plain-language list of what differs between two rule sets. */
export function describeChanges(from: Rules, to: Rules): string[] {
  const out: string[] = [];
  for (const key of Object.keys(FIELD_LABELS) as (keyof Rules)[]) {
    if (JSON.stringify(from[key]) === JSON.stringify(to[key])) continue;
    if (key === "armed") out.push(to.armed ? "Real money switches on" : "Real money switches off");
    else out.push(`New ${FIELD_LABELS[key]}`);
  }
  return out;
}
