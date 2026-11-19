// The rules of the game, as pure functions: what counts as a session, and what a miss costs.
// Nothing in here touches the database, the clock or the network, so it can be tested exhaustively.

import type { Weekday, Ymd } from "./time";

export type Kind = "run" | "strength";

export interface Rules {
  /** false = practice mode: everything is tracked, nothing is charged. */
  armed: boolean;
  /** Which session is due on which weekday. A missing day is a rest day. */
  schedule: Partial<Record<Weekday, Kind>>;
  /** A run only counts from this distance. */
  minRunKm: number;
  /** A strength session found on Strava only counts from this length. */
  minStrengthMin: number;
  /** Cost of the first miss, in cents. */
  baseCents: number;
  /** Each further miss in a row multiplies the cost by this. */
  multiplier: number;
  /** A single miss never costs more than this. */
  capPerMissCents: number;
  /** One Monday-to-Sunday week never costs more than this in total. */
  capPerWeekCents: number;
  /** How long the friend holds each transfer. */
  holdDays: number;
  friendName: string;
  friendIban: string;
}

export const DEFAULT_RULES: Rules = {
  armed: false,
  schedule: { mon: "run", tue: "strength", wed: "run", fri: "strength", sat: "run" },
  minRunKm: 3.5,
  minStrengthMin: 20,
  baseCents: 1000,
  multiplier: 2,
  capPerMissCents: 8000,
  capPerWeekCents: 15000,
  holdDays: 14,
  friendName: "",
  friendIban: "",
};

/** One Strava activity, reduced to what the rules need. */
export interface Activity {
  id: string;
  sportType: string;
  name: string;
  /** The calendar day the activity started on, by the clock where it was recorded. */
  localDate: Ymd;
  /** Local start time, 'HH:MM'. */
  startTime: string;
  distanceM: number;
  movingS: number;
  elapsedS: number;
  /** true when it was typed in by hand instead of recorded. */
  manual: boolean;
}

export const RUN_TYPES = new Set(["Run", "TrailRun", "VirtualRun"]);
export const STRENGTH_TYPES = new Set(["WeightTraining", "Workout", "Crossfit", "HighIntensityIntervalTraining"]);

export function isRunType(a: Activity): boolean {
  return RUN_TYPES.has(a.sportType);
}

export function isStrengthType(a: Activity): boolean {
  return STRENGTH_TYPES.has(a.sportType);
}

export function minRunMetres(rules: Rules): number {
  return Math.round(rules.minRunKm * 1000);
}

function runCounts(a: Activity, day: Ymd, rules: Rules): boolean {
  return a.localDate === day && isRunType(a) && !a.manual && a.distanceM >= minRunMetres(rules);
}

function strengthCounts(a: Activity, day: Ymd, rules: Rules): boolean {
  const seconds = Math.max(a.movingS, a.elapsedS);
  return a.localDate === day && isStrengthType(a) && !a.manual && seconds >= rules.minStrengthMin * 60;
}

/** The activity that proves the day's session, or null. For runs the longest one wins. */
export function qualifyingActivity(acts: Activity[], day: Ymd, kind: Kind, rules: Rules): Activity | null {
  const ok = acts.filter((a) => (kind === "run" ? runCounts(a, day, rules) : strengthCounts(a, day, rules)));
  if (ok.length === 0) return null;
  return ok.reduce((best, a) =>
    kind === "run" ? (a.distanceM > best.distanceM ? a : best) : a.elapsedS > best.elapsedS ? a : best,
  );
}

export function km(metres: number): string {
  return (Math.floor(metres / 10) / 100).toFixed(2);
}

/**
 * When something was recorded that day but does not count, say why in plain words.
 * Returns null when there is nothing relevant to explain.
 */
export function whyNot(acts: Activity[], day: Ymd, kind: Kind, rules: Rules): string | null {
  const sameDay = acts.filter((a) => a.localDate === day);
  if (kind === "run") {
    const runs = sameDay.filter(isRunType);
    if (runs.length === 0) return null;
    const recorded = runs.filter((a) => !a.manual);
    if (recorded.length === 0) return "A run was typed in by hand. Only recorded runs count.";
    const longest = recorded.reduce((b, a) => (a.distanceM > b.distanceM ? a : b));
    return `Longest run is ${km(longest.distanceM)} km. It needs ${rules.minRunKm} km in one go.`;
  }
  const lifts = sameDay.filter(isStrengthType);
  if (lifts.length === 0) return null;
  const recorded = lifts.filter((a) => !a.manual);
  if (recorded.length === 0) return "A workout was typed in by hand. Only recorded workouts count.";
  const longest = recorded.reduce((b, a) => (a.elapsedS > b.elapsedS ? a : b));
  return `Workout on Strava is ${Math.floor(Math.max(longest.movingS, longest.elapsedS) / 60)} min. It needs ${rules.minStrengthMin} min, or upload the watch screenshot.`;
}

/**
 * Cost of the n-th miss in a row before the weekly cap: base x multiplier^(n-1),
 * never more than the per-miss cap.
 */
export function missCost(streak: number, rules: Rules): number {
  if (streak < 1) return 0;
  let cost = rules.baseCents;
  for (let i = 1; i < streak && cost < rules.capPerMissCents; i++) cost *= rules.multiplier;
  return Math.min(Math.round(cost), rules.capPerMissCents);
}

export interface Charge {
  /** What the miss costs by streak alone. */
  rawCents: number;
  /** What is actually charged after the weekly cap. Can be 0. */
  cents: number;
}

/**
 * What a miss is charged, given how many misses in a row this makes and how much
 * the same Monday-to-Sunday week has already cost. The streak keeps growing even
 * when the weekly cap cuts the charge down, so the next week starts expensive.
 */
export function chargeFor(streak: number, weekChargedCents: number, rules: Rules): Charge {
  const rawCents = missCost(streak, rules);
  const room = Math.max(0, rules.capPerWeekCents - weekChargedCents);
  return { rawCents, cents: Math.min(rawCents, room) };
}

export function euros(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100);
  const rest = abs % 100;
  return `${sign}€${whole}${rest === 0 ? "" : `.${String(rest).padStart(2, "0")}`}`;
}

/** Amount as the bank API wants it: "12.50". */
export function bankAmount(cents: number): string {
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

/** Bank amount string ("12.50", "-3.00") to cents, without float rounding surprises. */
export function centsFromBank(value: string): number {
  const m = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!m) throw new Error(`Unreadable amount: ${value}`);
  const cents = Number(m[2]) * 100 + Number((m[3] || "0").padEnd(2, "0"));
  return m[1] ? -cents : cents;
}

// ---- IBAN ----

export function normalizeIban(raw: string): string {
  return raw.replace(/\s+/g, "").toUpperCase();
}

export function isValidIban(raw: string): boolean {
  const iban = normalizeIban(raw);
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(iban)) return false;
  const moved = iban.slice(4) + iban.slice(0, 4);
  let rem = 0;
  for (const ch of moved) {
    const v = ch >= "A" ? (ch.charCodeAt(0) - 55).toString() : ch;
    for (const digit of v) rem = (rem * 10 + Number(digit)) % 97;
  }
  return rem === 1;
}

export function prettyIban(raw: string): string {
  return normalizeIban(raw).replace(/(.{4})/g, "$1 ").trim();
}

/** Checks a full rule set and returns a list of plain-language problems (empty = fine). */
export function validateRules(r: Rules): string[] {
  const problems: string[] = [];
  const kinds = Object.values(r.schedule);
  if (kinds.length === 0) problems.push("Pick at least one training day.");
  if (kinds.some((k) => k !== "run" && k !== "strength")) problems.push("Unknown session type in the schedule.");
  if (!(r.minRunKm > 0 && r.minRunKm <= 50)) problems.push("Minimum run distance must be between 0 and 50 km.");
  if (!(r.minStrengthMin >= 1 && r.minStrengthMin <= 240)) problems.push("Minimum workout length must be 1 to 240 minutes.");
  if (!Number.isInteger(r.baseCents) || r.baseCents < 100) problems.push("The first miss must cost at least €1.");
  if (!(r.multiplier >= 1 && r.multiplier <= 10)) problems.push("The multiplier must be between 1 and 10.");
  if (!Number.isInteger(r.capPerMissCents) || r.capPerMissCents < r.baseCents)
    problems.push("The cap per miss can't be lower than the first-miss cost.");
  if (!Number.isInteger(r.capPerWeekCents) || r.capPerWeekCents < r.capPerMissCents)
    problems.push("The weekly cap can't be lower than the cap per miss.");
  if (r.capPerWeekCents > 100_000) problems.push("The weekly cap can't be above €1000.");
  if (!Number.isInteger(r.holdDays) || r.holdDays < 1 || r.holdDays > 365) problems.push("Hold time must be 1 to 365 days.");
  if (r.friendIban && !isValidIban(r.friendIban)) problems.push("The friend's IBAN is not a valid IBAN.");
  return problems;
}
