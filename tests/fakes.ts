// Stand-ins for Strava, the bank and the photo check, used by the tests and by the demo
// data script. The fakes can be told to fail in the ways the real services do.

import type { Activity, PhotoReading } from "../lib/engine";
import {
  BankError,
  type BankPayment,
  type BankPort,
  type PayRequest,
  PhotoCheckError,
  type PhotoCheckInput,
  type PhotoCheckPort,
  StravaError,
  type StravaPort,
} from "../lib/ports";
import { type Ymd, zonedToUtc } from "../lib/time";

/** The instant of a local Amsterdam wall-clock time. */
export function at(day: Ymd, time = "12:00"): Date {
  const [h, m] = time.split(":").map(Number);
  return zonedToUtc(day, h, m);
}

export class FakeStrava implements StravaPort {
  linked = true;
  down = false;
  calls = 0;
  private acts: (Activity & { startEpoch: number })[] = [];
  private nextId = 1000;

  add(day: Ymd, time: string, over: Partial<Activity> = {}): Activity {
    const a: Activity = {
      id: String(this.nextId++),
      sportType: "Run",
      name: "Run",
      localDate: day,
      startTime: time,
      distanceM: 5000,
      movingS: 1700,
      elapsedS: 1800,
      manual: false,
      ...over,
    };
    this.acts.push({ ...a, startEpoch: Math.floor(at(day, time).getTime() / 1000) });
    return a;
  }

  run(day: Ymd, km = 5, time = "18:00"): Activity {
    return this.add(day, time, { distanceM: Math.round(km * 1000) });
  }

  lift(day: Ymd, minutes = 45, time = "18:00"): Activity {
    return this.add(day, time, { sportType: "WeightTraining", name: "Weights", distanceM: 0, movingS: minutes * 60, elapsedS: minutes * 60 });
  }

  remove(id: string): void {
    this.acts = this.acts.filter((a) => a.id !== id);
  }

  async connected(): Promise<boolean> {
    return this.linked;
  }

  async fetchActivities(afterEpoch: number, beforeEpoch: number): Promise<Activity[]> {
    this.calls++;
    if (this.down) throw new StravaError("Strava is down.");
    return this.acts
      .filter((a) => a.startEpoch > afterEpoch && a.startEpoch < beforeEpoch)
      .map((a) => ({
        id: a.id,
        sportType: a.sportType,
        name: a.name,
        localDate: a.localDate,
        startTime: a.startTime,
        distanceM: a.distanceM,
        movingS: a.movingS,
        elapsedS: a.elapsedS,
        manual: a.manual,
      }));
  }
}

export type PayMode =
  | "ok"
  | "refuse" // the bank says no; nothing is sent
  | "timeout-sent" // the money goes out, but we never hear back
  | "timeout-lost"; // the request never arrives

export class FakeBank implements BankPort {
  linked = true;
  balanceCents = 100_000;
  payMode: PayMode = "ok";
  listDown = false;
  /** The clock the bank stamps payments with. */
  now: () => Date = () => new Date();
  ledger: BankPayment[] = [];
  payCalls = 0;
  listCalls = 0;
  private nextId = 5000;

  async connected(): Promise<boolean> {
    return this.linked;
  }

  private book(amountCents: number, iban: string, name: string, description: string): BankPayment {
    const p: BankPayment = { id: String(this.nextId++), created: this.now(), amountCents, counterpartyIban: iban, counterpartyName: name, description };
    this.ledger.push(p);
    this.balanceCents += amountCents;
    return p;
  }

  async pay(req: PayRequest): Promise<{ id: string }> {
    this.payCalls++;
    if (this.payMode === "refuse") throw new BankError("bunq said no: test refusal", true, "rejected");
    if (this.payMode === "timeout-lost") throw new BankError("No answer from bunq (timeout).", false);
    if (req.amountCents > this.balanceCents) throw new BankError("Not enough money in the bunq account.", true, "funds");
    const p = this.book(-req.amountCents, req.iban, req.name, req.description);
    if (this.payMode === "timeout-sent") throw new BankError("No answer from bunq (timeout).", false);
    return { id: p.id };
  }

  /** Someone sends money to the account. */
  receive(amountCents: number, iban: string, name: string, description: string): BankPayment {
    return this.book(amountCents, iban, name, description);
  }

  async listPayments(): Promise<BankPayment[]> {
    this.listCalls++;
    if (this.listDown) throw new BankError("No answer from bunq (timeout).", false);
    return [...this.ledger].sort((a, b) => Number(b.id) - Number(a.id));
  }

  /** Everything that left the account, oldest first. */
  get sent(): BankPayment[] {
    return this.ledger.filter((p) => p.amountCents < 0);
  }

  get sentTotal(): number {
    return -this.sent.reduce((s, p) => s + p.amountCents, 0);
  }
}

/**
 * Reads every photo as a good workout of the kind that was due, on the day it was due,
 * unless told otherwise: `show` overrides what the next photos "show", `down` and
 * `failWith` make it fail like the real service.
 */
export class FakePhotoCheck implements PhotoCheckPort {
  linked = true;
  down = false;
  failWith: PhotoCheckError | null = null;
  show: Partial<PhotoReading> | ((input: PhotoCheckInput) => Partial<PhotoReading>) = {};
  calls: PhotoCheckInput[] = [];

  async ready(): Promise<boolean> {
    return this.linked;
  }

  async read(input: PhotoCheckInput): Promise<PhotoReading> {
    this.calls.push(input);
    if (this.down) throw new PhotoCheckError("No answer from Claude.", "unavailable");
    if (this.failWith) throw this.failWith;
    const over = typeof this.show === "function" ? this.show(input) : this.show;
    // Different figures for every photo, so the same-figures rule only fires when a test wants it.
    const n = this.calls.length;
    return {
      isWorkoutRecord: true,
      activity: input.kind,
      dateShown: input.day,
      startTime: "18:00",
      distanceKm: input.kind === "run" ? 5 + n / 100 : null,
      durationS: 1800 + n * 7,
      calories: 300 + n,
      sameAsDay: null,
      summary: input.kind === "run" ? `Run, ${(5 + n / 100).toFixed(2)} km` : "Strength workout, 30 min",
      ...over,
    };
  }
}
