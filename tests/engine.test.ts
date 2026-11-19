import { describe, expect, it } from "vitest";
import {
  type Activity,
  DEFAULT_RULES,
  bankAmount,
  centsFromBank,
  chargeFor,
  euros,
  isValidIban,
  missCost,
  qualifyingActivity,
  validateRules,
  whyNot,
} from "../lib/engine";
import {
  addDays,
  diffDays,
  lastSettleableDay,
  localDate,
  localParts,
  settleAfter,
  weekStart,
  weekdayOf,
  zonedToUtc,
} from "../lib/time";

const R = DEFAULT_RULES;

function act(over: Partial<Activity>): Activity {
  return {
    id: "1",
    sportType: "Run",
    name: "Morning Run",
    localDate: "2026-11-23",
    startTime: "07:30",
    distanceM: 5000,
    movingS: 1700,
    elapsedS: 1800,
    manual: false,
    ...over,
  };
}

describe("miss cost", () => {
  it("doubles from €10 and stops at €80", () => {
    expect([1, 2, 3, 4, 5, 6, 40].map((n) => missCost(n, R))).toEqual([1000, 2000, 4000, 8000, 8000, 8000, 8000]);
  });
  it("is zero without a miss", () => {
    expect(missCost(0, R)).toBe(0);
  });
  it("never overflows on absurd streaks", () => {
    expect(missCost(5000, R)).toBe(8000);
  });
  it("follows a different multiplier", () => {
    expect([1, 2, 3].map((n) => missCost(n, { ...R, multiplier: 1.5 }))).toEqual([1000, 1500, 2250]);
  });
});

describe("weekly cap", () => {
  it("lets a full week of five misses cost exactly €150", () => {
    let week = 0;
    const charged: number[] = [];
    for (let streak = 1; streak <= 5; streak++) {
      const c = chargeFor(streak, week, R);
      charged.push(c.cents);
      week += c.cents;
    }
    expect(charged).toEqual([1000, 2000, 4000, 8000, 0]);
    expect(week).toBe(15000);
  });
  it("keeps the raw cost even when the charge is cut", () => {
    expect(chargeFor(5, 15000, R)).toEqual({ rawCents: 8000, cents: 0 });
    expect(chargeFor(6, 8000, R)).toEqual({ rawCents: 8000, cents: 7000 });
  });
});

describe("what counts as a run", () => {
  const day = "2026-11-23";
  it("accepts a recorded run of 3.5 km or more", () => {
    expect(qualifyingActivity([act({ distanceM: 3500 })], day, "run", R)?.id).toBe("1");
  });
  it("rejects a run that is a few metres short", () => {
    expect(qualifyingActivity([act({ distanceM: 3499 })], day, "run", R)).toBeNull();
  });
  it("rejects manual entries", () => {
    expect(qualifyingActivity([act({ manual: true })], day, "run", R)).toBeNull();
  });
  it("rejects other sports", () => {
    expect(qualifyingActivity([act({ sportType: "Ride", distanceM: 20000 })], day, "run", R)).toBeNull();
    expect(qualifyingActivity([act({ sportType: "Walk" })], day, "run", R)).toBeNull();
  });
  it("rejects a run on another day", () => {
    expect(qualifyingActivity([act({ localDate: "2026-11-22" })], day, "run", R)).toBeNull();
  });
  it("does not add two short runs together", () => {
    const two = [act({ id: "a", distanceM: 2000 }), act({ id: "b", distanceM: 2000 })];
    expect(qualifyingActivity(two, day, "run", R)).toBeNull();
  });
  it("accepts trail and treadmill runs and picks the longest", () => {
    const acts = [act({ id: "a", sportType: "TrailRun", distanceM: 4000 }), act({ id: "b", sportType: "VirtualRun", distanceM: 6000 })];
    expect(qualifyingActivity(acts, day, "run", R)?.id).toBe("b");
  });
  it("explains a near miss", () => {
    expect(whyNot([act({ distanceM: 2990 })], day, "run", R)).toContain("2.99 km");
    expect(whyNot([act({ manual: true })], day, "run", R)).toContain("typed in by hand");
    expect(whyNot([], day, "run", R)).toBeNull();
  });
});

describe("what counts as strength", () => {
  const day = "2026-11-24";
  const lift = (over: Partial<Activity>) =>
    act({ sportType: "WeightTraining", localDate: day, distanceM: 0, movingS: 2400, elapsedS: 2700, ...over });
  it("accepts a recorded weight session of 20 minutes or more", () => {
    expect(qualifyingActivity([lift({})], day, "strength", R)).not.toBeNull();
  });
  it("rejects a 10 minute session and manual entries", () => {
    expect(qualifyingActivity([lift({ movingS: 500, elapsedS: 600 })], day, "strength", R)).toBeNull();
    expect(qualifyingActivity([lift({ manual: true })], day, "strength", R)).toBeNull();
  });
  it("does not accept a run as strength or strength as a run", () => {
    expect(qualifyingActivity([act({ localDate: day })], day, "strength", R)).toBeNull();
    expect(qualifyingActivity([lift({})], day, "run", R)).toBeNull();
  });
});

describe("money formatting", () => {
  it("formats euros", () => {
    expect(euros(1000)).toBe("€10");
    expect(euros(1250)).toBe("€12.50");
    expect(euros(5)).toBe("€0.05");
  });
  it("round-trips bank amounts", () => {
    expect(bankAmount(1000)).toBe("10.00");
    expect(bankAmount(1)).toBe("0.01");
    expect(centsFromBank("10.00")).toBe(1000);
    expect(centsFromBank("-0.10")).toBe(-10);
    expect(centsFromBank("19.99")).toBe(1999);
    expect(centsFromBank("7")).toBe(700);
  });
});

describe("IBAN", () => {
  it("accepts valid IBANs with or without spaces", () => {
    expect(isValidIban("NL91ABNA0417164300")).toBe(true);
    expect(isValidIban("nl91 abna 0417 1643 00")).toBe(true);
    expect(isValidIban("DE89370400440532013000")).toBe(true);
  });
  it("rejects typos", () => {
    expect(isValidIban("NL91ABNA0417164301")).toBe(false);
    expect(isValidIban("NL91")).toBe(false);
    expect(isValidIban("")).toBe(false);
  });
});

describe("rule validation", () => {
  it("accepts the defaults", () => {
    expect(validateRules(R)).toEqual([]);
  });
  it("catches caps that contradict each other", () => {
    expect(validateRules({ ...R, capPerMissCents: 500 })).toHaveLength(1);
    expect(validateRules({ ...R, capPerWeekCents: 1000 })).toHaveLength(1);
    expect(validateRules({ ...R, schedule: {} })).toHaveLength(1);
    expect(validateRules({ ...R, friendIban: "NL00NOPE" })).toHaveLength(1);
  });
});

describe("calendar", () => {
  it("knows weekdays and week starts", () => {
    expect(weekdayOf("2026-11-23")).toBe("mon");
    expect(weekdayOf("2026-11-29")).toBe("sun");
    expect(weekStart("2026-11-29")).toBe("2026-11-23");
    expect(weekStart("2026-11-23")).toBe("2026-11-23");
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(diffDays("2026-11-23", "2026-12-07")).toBe(14);
  });
  it("uses Amsterdam's date, not UTC's", () => {
    expect(localDate(new Date("2026-11-23T23:30:00Z"))).toBe("2026-11-24"); // 00:30 in winter
    expect(localDate(new Date("2026-07-01T21:59:00Z"))).toBe("2026-07-01"); // 23:59 in summer
    expect(localDate(new Date("2026-07-01T22:00:00Z"))).toBe("2026-07-02");
  });
  it("converts local wall time to the right instant in winter and summer", () => {
    expect(zonedToUtc("2026-11-24", 3).toISOString()).toBe("2026-11-24T02:00:00.000Z");
    expect(zonedToUtc("2026-07-02", 3).toISOString()).toBe("2026-07-02T01:00:00.000Z");
    expect(localParts(zonedToUtc("2026-07-02", 23, 59)).hour).toBe(23);
  });
  it("judges a day at 03:00 the next morning, also across clock changes", () => {
    expect(settleAfter("2026-11-23").toISOString()).toBe("2026-11-24T02:00:00.000Z");
    // Clocks go forward on Sunday 2027-03-28 and back on Sunday 2026-10-25.
    expect(settleAfter("2027-03-27").toISOString()).toBe("2027-03-28T01:00:00.000Z");
    expect(settleAfter("2026-10-24").toISOString()).toBe("2026-10-25T02:00:00.000Z");
    expect(localParts(settleAfter("2027-03-27")).hour).toBe(3);
    expect(localParts(settleAfter("2026-10-24")).hour).toBe(3);
  });
  it("only calls yesterday judgeable after the grace hours", () => {
    expect(lastSettleableDay(new Date("2026-11-24T01:59:00Z"))).toBe("2026-11-22");
    expect(lastSettleableDay(new Date("2026-11-24T02:00:00Z"))).toBe("2026-11-23");
    expect(lastSettleableDay(new Date("2026-11-24T22:00:00Z"))).toBe("2026-11-23");
  });
});
