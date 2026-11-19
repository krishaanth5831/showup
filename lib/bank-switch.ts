// What happens to the books when a different bank key is connected.
//
// A bunq key that starts with "sandbox_" moves play money. Everything recorded while such a
// key was connected is a rehearsal, and none of it may end up in the real books:
//
//   test key -> real key   the rehearsal ends: test penalties are dropped, the days so far
//                          count as practice, and real money is off until it is switched on again.
//   real key -> test key   refused while real money is on (it would be a way out of paying),
//                          and refused for good once real transfers are on record.
//
// "ledger_env" remembers which kind of money the books are in. It survives disconnecting
// the bank, so disconnecting and reconnecting can't mix the two either.

import type { Db } from "./db";
import { kvDelete, kvGet, kvSet, logEvent } from "./kv";
import { ruleState } from "./rules";
import { type Ymd, localDate } from "./time";

export type BankEnv = "sandbox" | "production";

export type SwitchPlan =
  | { kind: "fine" }
  | { kind: "end-test" }
  | { kind: "refuse"; why: string };

/** Decides what connecting a key of the given kind would mean. Changes nothing. */
export async function planBankSwitch(db: Db, today: Ymd, next: BankEnv): Promise<SwitchPlan> {
  const ledger = await kvGet<BankEnv>(db, "ledger_env");
  if (!ledger || ledger === next) return { kind: "fine" };
  if (next === "production") return { kind: "end-test" };

  const state = await ruleState(db, today);
  if (state.locked || state.pending?.rules.armed) {
    return { kind: "refuse", why: "Real money is on, so a test key can't take the place of the real bank." };
  }
  const rows = await db.query<{ n: number }>("SELECT COUNT(*)::int AS n FROM penalties");
  if (rows[0].n > 0) {
    return {
      kind: "refuse",
      why: "Real transfers are on record here, so this copy can't go back to test money. Use a second copy of the app (or npm run demo) to try things out.",
    };
  }
  return { kind: "fine" };
}

/**
 * Carries out a plan and notes which kind of money the books are in from now on.
 * Call it only after the new key was proven to work.
 */
export async function applyBankSwitch(db: Db, now: Date, next: BankEnv, plan: SwitchPlan): Promise<void> {
  if (plan.kind === "refuse") throw new Error(plan.why);
  await db.tx(async (t) => {
    if (plan.kind === "end-test") {
      await t.query("DELETE FROM penalties");
      await t.query("DELETE FROM incoming");
      await t.query("UPDATE sessions SET practice = true WHERE practice = false");
      // Real money off, as if it had never been on: days that are not judged yet must not
      // turn into real penalties either. Waiting changes are dropped.
      await t.query("DELETE FROM rules WHERE effective_from > $1", [localDate(now)]);
      await t.query(`UPDATE rules SET config = jsonb_set(config, '{armed}', 'false'::jsonb)`);
      await logEvent(t, now, "bank", "test with play money ended: test penalties dropped, real money switched off");
    }
    await kvSet(t, "ledger_env", next);
    // The new account has its own list of payments.
    await kvDelete(t, "bank_seen_id");
    await kvDelete(t, "bank_check");
  });
}
