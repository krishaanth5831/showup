// Calendar helpers. All "days" in this app are calendar days in one fixed time zone
// (Europe/Amsterdam by default), written as 'YYYY-MM-DD' strings so they sort and
// compare as plain text and never drift with the server's own time zone.

export const TZ = process.env.SHOWUP_TZ || "Europe/Amsterdam";

/** Hours after local midnight before a day gets judged. Gives a late watch sync time to arrive. */
export const GRACE_HOURS = 3;

export type Ymd = string;

export const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    formatters.set(tz, f);
  }
  return f;
}

export interface LocalParts {
  ymd: Ymd;
  hour: number;
  minute: number;
  second: number;
}

/** Wall-clock date and time of an instant in the app's time zone. */
export function localParts(at: Date, tz: string = TZ): LocalParts {
  const parts: Record<string, string> = {};
  for (const p of formatter(tz).formatToParts(at)) parts[p.type] = p.value;
  return {
    ymd: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

export function localDate(at: Date, tz: string = TZ): Ymd {
  return localParts(at, tz).ymd;
}

export function isYmd(s: unknown): s is Ymd {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function toUtcMs(ymd: Ymd): number {
  const [y, m, d] = ymd.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

export function addDays(ymd: Ymd, n: number): Ymd {
  return new Date(toUtcMs(ymd) + n * 86_400_000).toISOString().slice(0, 10);
}

/** Whole days from a to b (positive when b is later). */
export function diffDays(a: Ymd, b: Ymd): number {
  return Math.round((toUtcMs(b) - toUtcMs(a)) / 86_400_000);
}

export function weekdayOf(ymd: Ymd): Weekday {
  const js = new Date(toUtcMs(ymd)).getUTCDay(); // 0 = Sunday
  return WEEKDAYS[(js + 6) % 7];
}

/** Monday of the Mon-Sun week that contains the day. */
export function weekStart(ymd: Ymd): Ymd {
  return addDays(ymd, -WEEKDAYS.indexOf(weekdayOf(ymd)));
}

export function datesBetween(from: Ymd, to: Ymd): Ymd[] {
  const out: Ymd[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

/** The instant at which a wall-clock time happens in the app's time zone (DST-safe). */
export function zonedToUtc(ymd: Ymd, hour = 0, minute = 0, tz: string = TZ): Date {
  const want = toUtcMs(ymd) + hour * 3_600_000 + minute * 60_000;
  let guess = want;
  for (let i = 0; i < 3; i++) {
    const p = localParts(new Date(guess), tz);
    const shown = toUtcMs(p.ymd) + p.hour * 3_600_000 + p.minute * 60_000;
    const delta = want - shown;
    if (delta === 0) break;
    guess += delta;
  }
  return new Date(guess);
}

/** A day can be judged once this instant has passed: 03:00 the next morning. */
export function settleAfter(ymd: Ymd, tz: string = TZ): Date {
  return zonedToUtc(addDays(ymd, 1), GRACE_HOURS, 0, tz);
}

/** The latest day whose judging time has passed. */
export function lastSettleableDay(now: Date, tz: string = TZ): Ymd {
  const today = localDate(now, tz);
  const yesterday = addDays(today, -1);
  return now.getTime() >= settleAfter(yesterday, tz).getTime() ? yesterday : addDays(today, -2);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAY_NAMES: Record<Weekday, string> = {
  mon: "Monday",
  tue: "Tuesday",
  wed: "Wednesday",
  thu: "Thursday",
  fri: "Friday",
  sat: "Saturday",
  sun: "Sunday",
};

export function dayName(ymd: Ymd): string {
  return DAY_NAMES[weekdayOf(ymd)];
}

export function weekdayLabel(w: Weekday): string {
  return DAY_NAMES[w];
}

/** "Mon 23 Nov" */
export function shortDate(ymd: Ymd): string {
  const [, m, d] = ymd.split("-").map(Number);
  return `${DAY_NAMES[weekdayOf(ymd)].slice(0, 3)} ${d} ${MONTHS[m - 1]}`;
}

/** "23 Nov 2026" */
export function longDate(ymd: Ymd): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

/** "November", for a day in that month. */
export function monthName(ymd: Ymd): string {
  const names = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  return names[Number(ymd.slice(5, 7)) - 1];
}
