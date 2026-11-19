// Glue between the screens and the nightly job: the real outside services, and the
// "keep things fresh while someone is looking" step that runs when the app is opened.

import { BunqBank } from "./bunq";
import type { Db } from "./db";
import { kvGet, kvSet } from "./kv";
import { type Ports, type SettleReport, runSettlement, settlementDue, syncActivities } from "./settle";
import { StravaClient } from "./strava";
import { type Ymd, addDays, localDate } from "./time";

export function realPorts(db: Db): Ports {
  return { strava: new StravaClient(db), bank: new BunqBank(db) };
}

const RUN_EVERY_MS = 10 * 60_000;
const SYNC_EVERY_MS = 3 * 60_000;

/**
 * Called when the Today screen is opened. If the nightly job is behind (the scheduler
 * failed, or the app was offline) it runs now; otherwise Strava is re-read so a run
 * that just finished shows up. Both are rate limited and neither may break the page.
 */
export async function freshen(db: Db, now: Date): Promise<void> {
  try {
    const lastRun = await kvGet<{ at: string }>(db, "last_run");
    const runAge = lastRun ? now.getTime() - new Date(lastRun.at).getTime() : Infinity;
    if (runAge > RUN_EVERY_MS && (await settlementDue(db, now))) {
      await runSettlement(db, realPorts(db), now);
      return;
    }
    const ports = realPorts(db);
    if (!(await ports.strava.connected())) return;
    const sync = await kvGet<{ at: string }>(db, "strava_sync");
    const syncAge = sync ? now.getTime() - new Date(sync.at).getTime() : Infinity;
    if (syncAge < SYNC_EVERY_MS) return;
    const today = localDate(now);
    const cursor = (await kvGet<Ymd>(db, "cursor")) ?? addDays(today, -1);
    const from = addDays(cursor, 1) < addDays(today, -6) ? addDays(today, -6) : addDays(cursor, 1);
    try {
      await syncActivities(db, ports.strava, from > today ? today : from, today, now);
    } catch (e) {
      await kvSet(db, "strava_sync", { at: now.toISOString(), ok: false, error: (e as Error).message });
    }
  } catch (e) {
    console.error("freshen failed:", e);
  }
}

export function summarize(r: SettleReport): string {
  if (r.busy) return "A check is already running.";
  const parts: string[] = [];
  const misses = r.judged.filter((j) => j.status === "missed").length;
  if (r.judged.length) parts.push(`${r.judged.length} day${r.judged.length === 1 ? "" : "s"} judged, ${misses} missed`);
  if (r.paid.length) parts.push(`${r.paid.length} transfer${r.paid.length === 1 ? "" : "s"} sent`);
  if (r.waiting.length) parts.push("waiting for Strava");
  if (r.payProblems.length) parts.push(r.payProblems[0]);
  if (r.notes.length) parts.push(r.notes[0]);
  return parts.length ? `${parts.join(". ")}.` : "Everything is up to date.";
}
