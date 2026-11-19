import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { applyBankSwitch, planBankSwitch } from "../lib/bank-switch";
import { type Db, openTestDb } from "../lib/db";
import { DEFAULT_RULES } from "../lib/engine";
import { kvGet, kvSet } from "../lib/kv";
import { ProofError, proofTarget, saveProof } from "../lib/proofs";
import { LOCK_DAYS, RuleError, arm, cancelPending, disarm, ensureRules, ruleState, rulesFor, saveRules } from "../lib/rules";
import { activitiesOn, penaltyRef, runSettlement, settlementDue } from "../lib/settle";
import { SickError, claimSick, sickDaysUsed, sickState, unclaimSick } from "../lib/sick";
import { type Ymd, addDays, datesBetween } from "../lib/time";
import { dashboard, history } from "../lib/views";
import { FakeBank, FakeStrava, at } from "./fakes";

process.env.APP_SECRET = "test-secret-that-is-long-enough-0123456789";

// Calendar used throughout: Monday 2026-11-23 starts a week.
//   Mon 23 run · Tue 24 strength · Wed 25 run · Thu 26 rest · Fri 27 strength · Sat 28 run · Sun 29 rest
const FRIEND = { friendName: "Sam Friend", friendIban: "NL91ABNA0417164300" };

let db: Db;
let strava: FakeStrava;
let bank: FakeBank;
let clock: Date;

beforeAll(async () => {
  db = await openTestDb();
});

beforeEach(async () => {
  await db.exec(
    "TRUNCATE kv, locks, rules, activities, proofs, penalties, sessions, incoming, events, sick_days RESTART IDENTITY CASCADE",
  );
  strava = new FakeStrava();
  bank = new FakeBank();
  clock = at("2026-11-22", "10:00");
  bank.now = () => clock;
});

/** One run of the nightly job at the given moment. */
async function settleAt(day: Ymd, time = "03:30") {
  clock = at(day, time);
  return runSettlement(db, { strava, bank }, clock);
}

/** Runs the nightly job after each day in the range (at 03:30 the next morning). */
async function nightly(from: Ymd, to: Ymd) {
  for (const d of datesBetween(from, to)) await settleAt(addDays(d, 1));
}

/** Opens the app on Sunday 22 Nov (a rest day), sets the friend and arms: real money from Monday 23 Nov. */
async function armed(over: Partial<typeof DEFAULT_RULES> = {}) {
  await ensureRules(db, "2026-11-22");
  await saveRules(db, "2026-11-22", { ...DEFAULT_RULES, ...FRIEND, ...over });
  await arm(db, "2026-11-22");
}

/** Opens the app in practice mode. */
async function practice() {
  await ensureRules(db, "2026-11-22");
}

interface S {
  date: string;
  kind: string;
  status: string;
  practice: boolean;
  source: string | null;
  streak: number;
  raw_cents: number;
  charge_cents: number;
  note: string | null;
}
const sessions = () => db.query<S>("SELECT * FROM sessions ORDER BY date");
const session = async (d: Ymd) => (await db.query<S>("SELECT * FROM sessions WHERE date = $1", [d]))[0];
interface P {
  session_date: string;
  amount_cents: number;
  status: string;
  bank_payment_id: string | null;
  release_on: string | null;
  returned_cents: number;
  attempts: number;
  last_error: string | null;
  friend_iban: string;
}
const penalties = () => db.query<P>("SELECT * FROM penalties ORDER BY session_date");
const jpeg = (seed: number) => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, seed, seed >> 8, 1, 2, 3, 4, 5, 6, 7, 8]);

describe("judging days", () => {
  it("charges a full missed week 10, 20, 40, 80 and then nothing: 150 in total", async () => {
    await armed();
    await nightly("2026-11-22", "2026-11-29");
    const s = await sessions();
    expect(s.map((x) => x.date)).toEqual(["2026-11-23", "2026-11-24", "2026-11-25", "2026-11-27", "2026-11-28"]);
    expect(s.map((x) => x.kind)).toEqual(["run", "strength", "run", "strength", "run"]);
    expect(s.every((x) => x.status === "missed" && !x.practice)).toBe(true);
    expect(s.map((x) => x.streak)).toEqual([1, 2, 3, 4, 5]);
    expect(s.map((x) => x.charge_cents)).toEqual([1000, 2000, 4000, 8000, 0]);
    expect(s[4].raw_cents).toBe(8000);
    expect(bank.sent.map((p) => -p.amountCents)).toEqual([1000, 2000, 4000, 8000]);
    expect(bank.sentTotal).toBe(15000);
    expect(bank.sent.every((p) => p.counterpartyIban === FRIEND.friendIban && p.counterpartyName === FRIEND.friendName)).toBe(true);
    expect(bank.sent[0].description).toContain(penaltyRef("2026-11-23"));
  });

  it("carries the streak into the next week while the weekly cap starts fresh", async () => {
    await armed();
    await nightly("2026-11-22", "2026-12-06");
    const s = await sessions();
    expect(s.map((x) => x.charge_cents)).toEqual([1000, 2000, 4000, 8000, 0, 8000, 7000, 0, 0, 0]);
    expect(s.map((x) => x.streak)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(bank.sentTotal).toBe(30000);
  });

  it("costs nothing when every session is done", async () => {
    await armed();
    strava.run("2026-11-23");
    strava.lift("2026-11-24");
    strava.run("2026-11-25", 3.5);
    await saveProofOn("2026-11-27");
    strava.run("2026-11-28", 12);
    await nightly("2026-11-22", "2026-11-29");
    const s = await sessions();
    expect(s.map((x) => x.status)).toEqual(["done", "done", "done", "done", "done"]);
    expect(s.map((x) => x.source)).toEqual(["strava", "strava", "strava", "proof", "strava"]);
    expect(await penalties()).toEqual([]);
    expect(bank.payCalls).toBe(0);
  });

  it("resets the multiplier after a completed session, across weeks and session types", async () => {
    await armed();
    strava.run("2026-11-23");
    strava.lift("2026-11-24");
    strava.run("2026-11-25");
    strava.lift("2026-11-27");
    // misses Sat 28 (run) and Mon 30 (run), does Tue 1 Dec (strength), misses Wed 2 Dec (run)
    strava.lift("2026-12-01");
    await nightly("2026-11-22", "2026-12-03");
    expect((await session("2026-11-28")).charge_cents).toBe(1000);
    expect((await session("2026-11-30")).charge_cents).toBe(2000);
    expect((await session("2026-12-01")).streak).toBe(0);
    expect((await session("2026-12-02")).charge_cents).toBe(1000);
  });

  it("only counts the right kind of session on its own day", async () => {
    await armed();
    strava.lift("2026-11-23"); // weights on a run day
    strava.run("2026-11-24"); // run on a strength day
    strava.run("2026-11-26"); // run on a rest day
    await nightly("2026-11-22", "2026-11-26");
    expect((await session("2026-11-23")).status).toBe("missed");
    expect((await session("2026-11-24")).status).toBe("missed");
    expect((await session("2026-11-25")).status).toBe("missed");
    expect(await session("2026-11-26")).toBeUndefined();
    expect((await session("2026-11-25")).streak).toBe(3);
  });

  it("rejects short runs, manual entries and other sports", async () => {
    await armed();
    strava.run("2026-11-23", 3.49);
    strava.add("2026-11-25", "18:00", { manual: true, distanceM: 10000 });
    strava.add("2026-11-28", "18:00", { sportType: "Ride", distanceM: 30000 });
    await nightly("2026-11-22", "2026-11-28");
    const s = await sessions();
    expect(s.filter((x) => x.kind === "run").map((x) => x.status)).toEqual(["missed", "missed", "missed"]);
  });

  it("counts a run late on the day even when it reaches Strava after midnight, but not a run after midnight", async () => {
    await armed();
    const res1 = await settleAt("2026-11-24", "01:00"); // Monday not judged yet: grace runs until 03:00
    expect(res1.judged).toEqual([]);
    strava.run("2026-11-23", 4, "23:40"); // synced at 02:00
    strava.run("2026-11-26", 6, "00:10"); // Thursday 00:10 is not Wednesday
    await nightly("2026-11-23", "2026-11-25");
    expect((await session("2026-11-23")).status).toBe("done");
    expect((await session("2026-11-25")).status).toBe("missed");
  });

  it("never judges days before the app was opened, or today", async () => {
    await armed();
    await settleAt("2026-11-25", "22:00"); // Wednesday evening
    const s = await sessions();
    expect(s.map((x) => x.date)).toEqual(["2026-11-23", "2026-11-24"]);
    expect(await kvGet(db, "cursor")).toBe("2026-11-24");
  });

  it("is practice until armed: tracked, would-be cost shown, nothing owed", async () => {
    await practice();
    strava.run("2026-11-23");
    await nightly("2026-11-22", "2026-11-25");
    const s = await sessions();
    expect(s.map((x) => [x.status, x.practice, x.charge_cents])).toEqual([
      ["done", true, 0],
      ["missed", true, 1000],
      ["missed", true, 2000],
    ]);
    expect(await penalties()).toEqual([]);
    expect(bank.payCalls).toBe(0);
  });

  it("records nothing in practice when Strava isn't linked", async () => {
    await practice();
    strava.linked = false;
    await nightly("2026-11-22", "2026-11-25");
    expect(await sessions()).toEqual([]);
    expect(await kvGet(db, "cursor")).toBe("2026-11-25");
  });

  it("starts a fresh streak when practice turns into real money", async () => {
    await practice();
    await saveRules(db, "2026-11-22", { ...DEFAULT_RULES, ...FRIEND });
    await nightly("2026-11-22", "2026-11-24"); // two practice misses
    await arm(db, "2026-11-25"); // armed from Thursday 26
    await nightly("2026-11-25", "2026-11-28");
    const s = await sessions();
    expect(s.map((x) => [x.date.slice(8), x.practice, x.streak, x.charge_cents])).toEqual([
      ["23", true, 1, 1000],
      ["24", true, 2, 2000],
      ["25", true, 3, 4000],
      ["27", false, 1, 1000],
      ["28", false, 2, 2000],
    ]);
    expect(bank.sentTotal).toBe(3000);
  });
});

async function saveProofOn(day: Ymd, time = "20:00", seed = Number(day.slice(8))) {
  return saveProof(db, at(day, time), jpeg(seed));
}

describe("catching up and running twice", () => {
  it("settles a whole backlog in one go and changes nothing on a second run", async () => {
    await armed();
    strava.run("2026-11-25");
    const first = await settleAt("2026-12-01");
    expect(first.judged.map((j) => j.date)).toEqual(["2026-11-23", "2026-11-24", "2026-11-25", "2026-11-27", "2026-11-28", "2026-11-30"]);
    const before = JSON.stringify([await sessions(), await penalties(), bank.ledger]);
    const second = await settleAt("2026-12-01", "03:45");
    expect(second.judged).toEqual([]);
    expect(second.paid).toEqual([]);
    expect(JSON.stringify([await sessions(), await penalties(), bank.ledger])).toBe(before);
    expect((await session("2026-11-27")).charge_cents).toBe(1000); // streak reset by Wednesday's run
  });

  it("lets only one of two simultaneous runs do the work", async () => {
    await armed();
    clock = at("2026-11-29", "03:30");
    const [a, b] = await Promise.all([runSettlement(db, { strava, bank }, clock), runSettlement(db, { strava, bank }, clock)]);
    expect([a.busy, b.busy].sort()).toEqual([false, true]);
    expect(bank.sent).toHaveLength(4);
    expect(bank.sentTotal).toBe(15000);
  });

  it("knows when there is work to do", async () => {
    await armed();
    await settleAt("2026-11-23"); // steps over Sunday, a rest day
    expect(await settlementDue(db, at("2026-11-23", "23:00"))).toBe(false);
    expect(await settlementDue(db, at("2026-11-24", "02:59"))).toBe(false);
    expect(await settlementDue(db, at("2026-11-24", "03:00"))).toBe(true);
    await settleAt("2026-11-24");
    expect(await settlementDue(db, at("2026-11-24", "04:00"))).toBe(false);
  });
});

describe("when Strava can't be reached", () => {
  it("waits instead of charging, then judges fairly once Strava is back", async () => {
    await armed();
    strava.run("2026-11-23");
    strava.down = true;
    const r1 = await settleAt("2026-11-24");
    expect(r1.judged).toEqual([]);
    expect(r1.waiting).toContain("2026-11-23");
    await settleAt("2026-11-25");
    expect(await sessions()).toEqual([]);
    strava.down = false;
    await settleAt("2026-11-26");
    const s = await sessions();
    expect(s.map((x) => [x.date, x.status])).toEqual([
      ["2026-11-23", "done"],
      ["2026-11-24", "missed"],
      ["2026-11-25", "missed"],
    ]);
    expect(bank.sentTotal).toBe(3000);
  });

  it("gives up waiting after 72 hours and says so", async () => {
    await armed();
    strava.down = true;
    await nightly("2026-11-23", "2026-11-25");
    expect(await sessions()).toEqual([]);
    await settleAt("2026-11-27", "03:30"); // Monday's deadline + 72 h has passed
    const mon = await session("2026-11-23");
    expect(mon.status).toBe("missed");
    expect(mon.note).toContain("without Strava");
    expect(await session("2026-11-24")).toBeUndefined(); // Tuesday is still inside its 72 hours
  });

  it("still accepts a screenshot for a strength day judged without Strava", async () => {
    await armed();
    strava.down = true;
    strava.run("2026-11-23");
    await saveProofOn("2026-11-24");
    await settleAt("2026-11-28", "03:30");
    expect((await session("2026-11-24")).status).toBe("done");
  });
});

describe("sending the money", () => {
  it("keeps a penalty owed when the bank refuses, and pays once it works", async () => {
    await armed();
    bank.payMode = "refuse";
    await settleAt("2026-11-24");
    let p = (await penalties())[0];
    expect(p.status).toBe("owed");
    expect(p.last_error).toContain("said no");
    expect(bank.sent).toHaveLength(0);
    bank.payMode = "ok";
    await settleAt("2026-11-24", "09:00");
    p = (await penalties())[0];
    expect(p.status).toBe("held");
    expect(p.release_on).toBe("2026-12-08");
    expect(p.attempts).toBe(2);
    expect(bank.sent).toHaveLength(1);
  });

  it("waits for money when the account is empty, then pays everything that piled up", async () => {
    await armed();
    bank.balanceCents = 500;
    await nightly("2026-11-23", "2026-11-25");
    expect((await penalties()).map((p) => p.status)).toEqual(["owed", "owed", "owed"]);
    expect(bank.sent).toHaveLength(0);
    bank.balanceCents = 100_000;
    await settleAt("2026-11-26", "12:00");
    expect((await penalties()).map((p) => p.status)).toEqual(["held", "held", "held"]);
    expect(bank.sent.map((p) => -p.amountCents)).toEqual([1000, 2000, 4000]);
  });

  it("does not pay twice when the transfer went out but the answer got lost", async () => {
    await armed();
    bank.payMode = "timeout-sent";
    await settleAt("2026-11-24");
    expect((await penalties())[0].status).toBe("sending");
    expect(bank.sent).toHaveLength(1);
    bank.payMode = "ok";
    await settleAt("2026-11-24", "03:35"); // finds the transfer in the bank by its reference
    const p = (await penalties())[0];
    expect(p.status).toBe("held");
    expect(p.bank_payment_id).toBe(bank.sent[0].id);
    await settleAt("2026-11-24", "12:00");
    expect(bank.sent).toHaveLength(1);
    expect(bank.payCalls).toBe(1);
  });

  it("retries a transfer that never arrived, but only after checking the bank", async () => {
    await armed();
    bank.payMode = "timeout-lost";
    await settleAt("2026-11-24");
    expect((await penalties())[0].status).toBe("sending");
    bank.payMode = "ok";
    await settleAt("2026-11-24", "03:35"); // too soon to conclude anything
    expect((await penalties())[0].status).toBe("sending");
    expect(bank.sent).toHaveLength(0);
    await settleAt("2026-11-24", "03:50");
    expect((await penalties())[0].status).toBe("held");
    expect(bank.sent).toHaveLength(1);
  });

  it("sends nothing while the bank's payment list can't be read", async () => {
    await armed();
    bank.listDown = true;
    const r = await settleAt("2026-11-24");
    expect(r.payProblems[0]).toContain("could not be read");
    expect(bank.payCalls).toBe(0);
    expect((await penalties())[0].status).toBe("owed");
  });

  it("holds penalties as owed while no bank is connected and pays when one is", async () => {
    await armed();
    bank.linked = false;
    await nightly("2026-11-23", "2026-11-24");
    expect((await penalties()).map((p) => p.status)).toEqual(["owed", "owed"]);
    bank.linked = true;
    await settleAt("2026-11-25", "15:00");
    expect(bank.sentTotal).toBe(3000);
  });

  it("uses the friend that was in force on the day of the miss", async () => {
    await armed();
    await nightly("2026-11-23", "2026-11-23");
    await saveRules(db, "2026-11-24", { ...DEFAULT_RULES, ...FRIEND, armed: true, friendName: "New Person", friendIban: "DE89370400440532013000" });
    await nightly("2026-11-24", "2026-12-02");
    const ibans = (await penalties()).map((p) => [p.session_date, p.friend_iban]);
    expect(ibans.find((x) => x[0] === "2026-11-30")?.[1]).toBe(FRIEND.friendIban); // change not active yet
    expect(ibans.find((x) => x[0] === "2026-12-01")?.[1]).toBe("DE89370400440532013000"); // 7 days later
  });
});

describe("getting the money back from the friend", () => {
  it("marks transfers as returned, oldest first, when the friend sends money that mentions showup", async () => {
    await armed();
    await nightly("2026-11-23", "2026-11-25"); // friend holds 10 + 20 + 40
    clock = at("2026-12-08", "12:00");
    bank.receive(1000, FRIEND.friendIban, FRIEND.friendName, "Showup return");
    bank.receive(2500, FRIEND.friendIban, FRIEND.friendName, "showup back");
    await settleAt("2026-12-08", "13:00");
    const p = await db.query<P>("SELECT * FROM penalties WHERE session_date <= '2026-11-25' ORDER BY session_date");
    expect(p.map((x) => [x.status, x.returned_cents])).toEqual([
      ["returned", 1000],
      ["returned", 2000],
      ["held", 500],
    ]);
  });

  it("ignores other money from the friend until it is marked as a return", async () => {
    await armed();
    await nightly("2026-11-23", "2026-11-23");
    clock = at("2026-11-26", "12:00");
    const dinner = bank.receive(1000, FRIEND.friendIban, FRIEND.friendName, "pizza friday");
    bank.receive(1000, "NL20INGB0001234567", "Someone Else", "showup"); // not the friend
    await settleAt("2026-11-26", "13:00");
    const first = (await penalties())[0];
    expect(first.status).toBe("held");
    const inc = await db.query<{ bank_payment_id: string; is_return: boolean }>("SELECT * FROM incoming");
    expect(inc).toHaveLength(1);
    expect(inc[0].is_return).toBe(false);
    await db.query("UPDATE incoming SET is_return = true, decided_by = 'user' WHERE bank_payment_id = $1", [dinner.id]);
    await settleAt("2026-11-26", "14:00");
    expect((await penalties())[0].status).toBe("returned");
  });

  it("ignores money the friend sent before they held anything", async () => {
    await armed();
    clock = at("2026-11-22", "12:00");
    bank.receive(5000, FRIEND.friendIban, FRIEND.friendName, "showup test");
    await nightly("2026-11-23", "2026-11-24");
    expect(await db.query("SELECT * FROM incoming")).toEqual([]);
    expect((await penalties()).every((p) => p.status === "held")).toBe(true);
  });
});

describe("rule changes", () => {
  it("apply at once in practice mode", async () => {
    await practice();
    const res = await saveRules(db, "2026-11-22", { ...DEFAULT_RULES, baseCents: 2000 });
    expect(res.delayed).toBe(false);
    expect((await rulesFor(db, "2026-11-22"))?.rules.baseCents).toBe(2000);
  });

  it("arming starts tomorrow, and can be called off before then", async () => {
    await practice();
    await expect(arm(db, "2026-11-22")).rejects.toThrow(RuleError); // no friend yet
    await saveRules(db, "2026-11-22", { ...DEFAULT_RULES, ...FRIEND });
    expect(await arm(db, "2026-11-22")).toBe("2026-11-23");
    expect((await rulesFor(db, "2026-11-22"))?.rules.armed).toBe(false);
    expect((await rulesFor(db, "2026-11-23"))?.rules.armed).toBe(true);
    // an edit while arming is planned reaches the planned version too
    await saveRules(db, "2026-11-22", { ...DEFAULT_RULES, ...FRIEND, minRunKm: 4 });
    expect((await rulesFor(db, "2026-11-22"))?.rules).toMatchObject({ armed: false, minRunKm: 4 });
    expect((await rulesFor(db, "2026-11-23"))?.rules).toMatchObject({ armed: true, minRunKm: 4 });
    await cancelPending(db, "2026-11-22");
    expect((await rulesFor(db, "2026-11-23"))?.rules.armed).toBe(false);
  });

  it("wait a week once armed, including switching off and a cheaper penalty", async () => {
    await armed();
    const today = "2026-11-23";
    const res = await saveRules(db, today, { ...DEFAULT_RULES, ...FRIEND, baseCents: 100 });
    expect(res).toEqual({ effectiveFrom: addDays(today, LOCK_DAYS), delayed: true });
    expect((await rulesFor(db, "2026-11-29"))?.rules.baseCents).toBe(1000);
    expect((await rulesFor(db, "2026-11-30"))?.rules.baseCents).toBe(100);
    expect((await rulesFor(db, "2026-11-30"))?.rules.armed).toBe(true); // an edit can't switch it off
    await expect(disarm(db, today)).rejects.toThrow("already waiting");
    await cancelPending(db, today);
    expect(await disarm(db, today)).toBe("2026-11-30");
    const state = await ruleState(db, today);
    expect(state.locked).toBe(true);
    expect(state.pending?.rules.armed).toBe(false);
    await nightly("2026-11-23", "2026-12-01");
    const s = await sessions();
    expect(s.filter((x) => !x.practice).map((x) => x.date)).toEqual(["2026-11-23", "2026-11-24", "2026-11-25", "2026-11-27", "2026-11-28"]);
    expect(s.filter((x) => x.practice).map((x) => x.date)).toEqual(["2026-11-30", "2026-12-01"]);
  });

  it("refuse an empty friend while armed and invalid values always", async () => {
    await armed();
    await expect(saveRules(db, "2026-11-23", { ...DEFAULT_RULES, friendName: "", friendIban: "" })).rejects.toThrow("can't be empty");
    await expect(saveRules(db, "2026-11-23", { ...DEFAULT_RULES, ...FRIEND, friendIban: "NL00NOPE" })).rejects.toThrow("valid IBAN");
    await expect(saveRules(db, "2026-11-23", { ...DEFAULT_RULES, ...FRIEND, capPerWeekCents: 100 })).rejects.toThrow();
  });

  it("use the schedule that was in force on each day", async () => {
    await practice();
    await saveRules(db, "2026-11-22", { ...DEFAULT_RULES, schedule: { thu: "run" } });
    await nightly("2026-11-22", "2026-11-27");
    expect((await sessions()).map((x) => x.date)).toEqual(["2026-11-26"]);
  });
});

describe("workout screenshots", () => {
  it("count for today's strength session and can be replaced until the day is judged", async () => {
    await armed();
    expect(await proofTarget(db, at("2026-11-24", "19:00"))).toBe("2026-11-24");
    const a = await saveProofOn("2026-11-24", "19:00", 1);
    const b = await saveProofOn("2026-11-24", "19:05", 2);
    expect(a.date).toBe("2026-11-24");
    expect(b.id).not.toBe(a.id);
    expect(await db.query("SELECT id FROM proofs")).toHaveLength(1);
  });

  it("count for yesterday when uploaded just after midnight, but not after 03:00", async () => {
    await armed();
    expect(await proofTarget(db, at("2026-11-25", "00:30"))).toBe("2026-11-24");
    expect(await proofTarget(db, at("2026-11-25", "03:00"))).toBeNull();
    await saveProofOn("2026-11-25", "00:30");
    await settleAt("2026-11-25");
    expect((await session("2026-11-24")).status).toBe("done");
  });

  it("are refused on run days, rest days, and after the day was judged", async () => {
    await armed();
    await expect(saveProofOn("2026-11-23")).rejects.toThrow(ProofError);
    await expect(saveProofOn("2026-11-26")).rejects.toThrow("no strength session");
    await settleAt("2026-11-25");
    await expect(saveProof(db, at("2026-11-25", "04:00"), jpeg(9))).rejects.toThrow("no strength session");
  });

  it("can't be reused on another day, and must be real pictures", async () => {
    await armed();
    await saveProofOn("2026-11-24", "19:00", 7);
    await expect(saveProofOn("2026-11-27", "19:00", 7)).rejects.toThrow("already used");
    await expect(saveProof(db, at("2026-11-27", "19:00"), new Uint8Array([1, 2, 3, 4, 5]))).rejects.toThrow("not a JPEG");
    await expect(saveProof(db, at("2026-11-27", "19:00"), new Uint8Array())).rejects.toThrow("empty");
  });
});

describe("Strava copy", () => {
  it("mirrors deletions and forgets details after 7 days", async () => {
    await armed();
    const run = strava.run("2026-11-23");
    await settleAt("2026-11-24");
    expect(await activitiesOn(db, "2026-11-23")).toHaveLength(1);
    strava.remove(run.id);
    await settleAt("2026-11-26"); // re-reads only days not judged yet
    expect((await session("2026-11-23")).status).toBe("done"); // a verdict is final
    await settleAt("2026-12-02");
    expect(await activitiesOn(db, "2026-11-01", "2026-11-24")).toEqual([]);
  });
});

describe("clock changes", () => {
  it("judges each day once through the autumn and spring switches", async () => {
    await ensureRules(db, "2027-03-21");
    await saveRules(db, "2027-03-21", { ...DEFAULT_RULES, ...FRIEND });
    await arm(db, "2027-03-21");
    strava.run("2027-03-27", 5, "23:30"); // Saturday before the clocks go forward
    await nightly("2027-03-23", "2027-03-29");
    const s = await sessions();
    expect(s.map((x) => x.date)).toEqual(["2027-03-22", "2027-03-23", "2027-03-24", "2027-03-26", "2027-03-27", "2027-03-29"]);
    expect((await session("2027-03-27")).status).toBe("done");
  });
});

describe("test money and real money", () => {
  it("ends a rehearsal when a real key replaces a test key, and nothing from it becomes real", async () => {
    await kvSet(db, "ledger_env", "sandbox");
    await armed();
    await nightly("2026-11-23", "2026-11-24"); // two misses paid with play money
    expect((await penalties()).map((p) => p.status)).toEqual(["held", "held"]);
    bank.receive(1000, FRIEND.friendIban, FRIEND.friendName, "showup back");

    // Wednesday 25 Nov, before that day is judged: the real key goes in.
    const now = at("2026-11-25", "12:00");
    const plan = await planBankSwitch(db, "2026-11-25", "production");
    expect(plan.kind).toBe("end-test");
    await applyBankSwitch(db, now, "production", plan);

    expect(await penalties()).toEqual([]);
    expect((await sessions()).map((s) => [s.date, s.practice])).toEqual([
      ["2026-11-23", true],
      ["2026-11-24", true],
    ]);
    expect(await kvGet(db, "ledger_env")).toBe("production");
    const state = await ruleState(db, "2026-11-25");
    expect(state.locked).toBe(false);
    expect(state.pending).toBeNull();

    // Days judged afterwards are practice: no transfer leaves the real account.
    const real = new FakeBank();
    real.now = () => clock;
    clock = at("2026-11-28", "03:30");
    await runSettlement(db, { strava, bank: real }, clock);
    expect(await penalties()).toEqual([]);
    expect(real.sent).toEqual([]);
    expect((await session("2026-11-25")).practice).toBe(true);
  });

  it("drops a planned switch-on together with the rehearsal", async () => {
    await kvSet(db, "ledger_env", "sandbox");
    await armed(); // planned for Monday, asked on Sunday
    const plan = await planBankSwitch(db, "2026-11-22", "production");
    await applyBankSwitch(db, at("2026-11-22", "18:00"), "production", plan);
    const state = await ruleState(db, "2026-11-22");
    expect(state.pending).toBeNull();
    expect((await ruleState(db, "2026-11-23")).locked).toBe(false);
    expect(state.current.rules.friendIban).toBe(FRIEND.friendIban);
  });

  it("refuses a test key while real money is on, and for good once real transfers exist", async () => {
    await kvSet(db, "ledger_env", "production");
    await armed();
    expect((await planBankSwitch(db, "2026-11-22", "sandbox")).kind).toBe("refuse"); // switch-on planned
    await nightly("2026-11-23", "2026-11-23");
    expect((await planBankSwitch(db, "2026-11-24", "sandbox")).kind).toBe("refuse"); // armed

    await disarm(db, "2026-11-24");
    const later = addDays("2026-11-24", LOCK_DAYS + 1);
    expect((await ruleState(db, later)).locked).toBe(false);
    const plan = await planBankSwitch(db, later, "sandbox");
    expect(plan.kind).toBe("refuse"); // the real penalty is still on record
    await expect(applyBankSwitch(db, at(later, "12:00"), "sandbox", plan)).rejects.toThrow(/test money/);
  });

  it("accepts the first key of either kind, a new key of the same kind, and a test key before any real transfer", async () => {
    await practice();
    expect((await planBankSwitch(db, "2026-11-22", "sandbox")).kind).toBe("fine");
    expect((await planBankSwitch(db, "2026-11-22", "production")).kind).toBe("fine");
    await applyBankSwitch(db, at("2026-11-22", "12:00"), "production", { kind: "fine" });
    expect((await planBankSwitch(db, "2026-11-22", "production")).kind).toBe("fine");
    expect((await planBankSwitch(db, "2026-11-22", "sandbox")).kind).toBe("fine");
  });
});

describe("sick days", () => {
  /** Uses a sick day for a day, at 09:00 on that day unless another moment is given. */
  const sick = (day: Ymd, when: Date = at(day, "09:00")) => claimSick(db, when, day, true);

  it("cost nothing and leave the multiplier where it was: miss, sick, miss is 10, 0, 20", async () => {
    await armed();
    await nightly("2026-11-23", "2026-11-23"); // Monday missed
    await sick("2026-11-24");
    await nightly("2026-11-24", "2026-11-25"); // Tuesday sick, Wednesday missed

    expect((await sessions()).map((s) => [s.date, s.status, s.streak, s.charge_cents])).toEqual([
      ["2026-11-23", "missed", 1, 1000],
      ["2026-11-24", "sick", 1, 0],
      ["2026-11-25", "missed", 2, 2000],
    ]);
    expect((await penalties()).map((p) => [p.session_date, p.amount_cents])).toEqual([
      ["2026-11-23", 1000],
      ["2026-11-25", 2000],
    ]);
  });

  it("do not count as a completed session either: the next miss after a clean run of days still costs 10", async () => {
    await armed();
    strava.run("2026-11-23", 5);
    await sick("2026-11-24");
    await nightly("2026-11-23", "2026-11-25"); // done, sick, missed
    expect((await sessions()).map((s) => [s.status, s.streak, s.charge_cents])).toEqual([
      ["done", 0, 0],
      ["sick", 0, 0],
      ["missed", 1, 1000],
    ]);
  });

  it("are limited to three per calendar month, and a new month starts fresh", async () => {
    await armed();
    await sick("2026-11-23");
    await sick("2026-11-24");
    const third = await sick("2026-11-25");
    expect([third.left, third.limit]).toEqual([0, 3]);
    await expect(sick("2026-11-27")).rejects.toThrow("All 3 sick days for November are used");
    expect(await sickDaysUsed(db, "2026-11-27")).toBe(3);

    await nightly("2026-11-23", "2026-11-30");
    // Friday 27 and Saturday 28 could not be covered, so they are ordinary misses.
    expect((await sessions()).map((s) => s.status)).toEqual(["sick", "sick", "sick", "missed", "missed", "missed"]);

    const december = await sick("2026-12-01");
    expect([december.left, december.limit]).toEqual([2, 3]);
  });

  it("are handed back when the session is done after all", async () => {
    await armed();
    await sick("2026-11-23"); // run day
    strava.run("2026-11-23", 4.2, "19:00");
    await sick("2026-11-24"); // strength day
    await saveProof(db, at("2026-11-24", "20:00"), jpeg(1));
    expect(await sickDaysUsed(db, "2026-11-24")).toBe(2);

    await nightly("2026-11-23", "2026-11-24");
    expect((await sessions()).map((s) => [s.status, s.source])).toEqual([
      ["done", "strava"],
      ["done", "proof"],
    ]);
    expect(await sickDaysUsed(db, "2026-11-24")).toBe(0);
    expect(await penalties()).toEqual([]);
  });

  it("can be used until 03:00 the next morning, and not a minute later even when judging runs late", async () => {
    await armed();
    const late = await sick("2026-11-23", at("2026-11-24", "02:30"));
    expect(late.claimed).toBe(true);

    // Tuesday is not judged yet at 03:10 on Wednesday, but its window is closed.
    await expect(sick("2026-11-24", at("2026-11-25", "03:10"))).rejects.toThrow("until 03:00");
    await nightly("2026-11-23", "2026-11-24");
    expect((await sessions()).map((s) => s.status)).toEqual(["sick", "missed"]);
    // And never for a day that has been judged.
    await expect(sick("2026-11-24", at("2026-11-25", "09:00"))).rejects.toBeInstanceOf(SickError);
  });

  it("only exist for today's training day: not for rest days, later days, or twice", async () => {
    await armed();
    await expect(sick("2026-11-26")).rejects.toThrow("training day"); // Thursday is a rest day
    await expect(sick("2026-11-27", at("2026-11-25", "09:00"))).rejects.toThrow("training day"); // not yet
    await expect(claimSick(db, at("2026-11-23", "09:00"), "yesterday", true)).rejects.toThrow("not a day");
    await sick("2026-11-23");
    await expect(sick("2026-11-23")).rejects.toThrow("already a sick day");
    expect(await sickDaysUsed(db, "2026-11-23")).toBe(1);
  });

  it("can be taken back until the day is judged, and then the miss counts", async () => {
    await armed();
    await sick("2026-11-23");
    await unclaimSick(db, at("2026-11-23", "21:00"), "2026-11-23", true);
    expect(await sickDaysUsed(db, "2026-11-23")).toBe(0);
    await nightly("2026-11-23", "2026-11-23");
    expect((await session("2026-11-23")).status).toBe("missed");
    expect((await penalties()).map((p) => p.amount_cents)).toEqual([1000]);

    await sick("2026-11-24");
    await nightly("2026-11-24", "2026-11-24");
    await expect(unclaimSick(db, at("2026-11-25", "09:00"), "2026-11-24", true)).rejects.toThrow("can't be taken back");
    expect((await session("2026-11-24")).status).toBe("sick");
  });

  it("work in practice mode, but are not offered while no day is judged at all", async () => {
    await practice();
    // Practice without Strava: nothing is judged, so a sick day would be used up for nothing.
    await expect(claimSick(db, at("2026-11-23", "09:00"), "2026-11-23", false)).rejects.toThrow("training day");
    expect((await sickState(db, at("2026-11-23", "09:00"), false)).open).toEqual([]);

    await sick("2026-11-23");
    await nightly("2026-11-23", "2026-11-23");
    const s = await session("2026-11-23");
    expect([s.status, s.practice, s.charge_cents]).toEqual(["sick", true, 0]);
  });

  it("follow the rules: 0 switches them off, and a lower number applies a week later once armed", async () => {
    await armed({ sickDaysPerMonth: 0 });
    await expect(sick("2026-11-23")).rejects.toThrow("switched off");

    const current = (await ruleState(db, "2026-11-23")).current.rules;
    const res = await saveRules(db, "2026-11-23", { ...current, sickDaysPerMonth: 5 });
    expect(res.delayed).toBe(true);
    await expect(sick("2026-11-24")).rejects.toThrow("switched off");
    const later = await sick("2026-11-30"); // the change is in force from Monday 30 November
    expect(later.limit).toBe(5);
    await expect(saveRules(db, "2026-11-30", { ...current, sickDaysPerMonth: 2.5 })).rejects.toThrow("Sick days per month");
  });

  it("show up on the screens as a sick day, not as a miss in a row", async () => {
    await armed();
    await nightly("2026-11-23", "2026-11-23"); // Monday missed
    await sick("2026-11-24");

    const open = await dashboard(db, at("2026-11-24", "12:00"));
    expect(open.today.state).toBe("sick");
    expect(open.sick.month).toEqual({ name: "November", used: 1, limit: 3, left: 2 });
    expect(open.sick.open.map((o) => [o.date, o.claimed])).toEqual([["2026-11-24", true]]);
    expect(open.nextMissCents).toBe(2000); // Monday's miss still counts

    await nightly("2026-11-24", "2026-11-24");
    const after = await dashboard(db, at("2026-11-25", "12:00"));
    expect(after.week.slice(0, 3).map((d) => d.state)).toEqual(["missed", "sick", "due"]);
    expect(after.nextMissCents).toBe(2000);
    const rows = (await history(db, at("2026-11-25", "12:00"))).weeks[0].rows;
    expect(rows.map((r) => [r.date, r.status, r.chargeCents])).toEqual([
      ["2026-11-24", "sick", 0],
      ["2026-11-23", "missed", 1000],
    ]);
  });
});
