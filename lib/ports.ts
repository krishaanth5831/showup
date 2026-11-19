// The outside services, described by what the app needs from them. The real
// implementations live in strava.ts, bunq.ts and claude.ts; the tests plug in fakes.

import type { Activity, Kind, PhotoReading } from "./engine";
import type { Ymd } from "./time";

export interface StravaPort {
  /** true when an account is linked. */
  connected(): Promise<boolean>;
  /** Every activity that started between the two instants (seconds since 1970). */
  fetchActivities(afterEpoch: number, beforeEpoch: number): Promise<Activity[]>;
}

export interface BankPayment {
  id: string;
  /** When the bank booked it. */
  created: Date;
  /** Negative = money left the account, positive = money came in. */
  amountCents: number;
  counterpartyIban: string;
  counterpartyName: string;
  description: string;
}

export interface PayRequest {
  amountCents: number;
  iban: string;
  name: string;
  description: string;
}

export interface BankPort {
  connected(): Promise<boolean>;
  /** Sends money. Resolves with the bank's payment id once the bank has accepted it. */
  pay(req: PayRequest): Promise<{ id: string }>;
  /**
   * Recent payments, newest first. Always includes the newest page; when sinceId is given
   * it keeps reading older pages until it reaches that payment.
   */
  listPayments(sinceId?: string | null): Promise<BankPayment[]>;
}

export type BankErrorKind = "auth" | "funds" | "rejected" | "rate" | "unknown";

/**
 * definite = the bank answered and said no, so nothing was sent and trying again is safe.
 * Not definite = we never got a clear answer (timeout, network, server error): the payment
 * may or may not exist, so it must be looked up before anyone tries again.
 */
export class BankError extends Error {
  constructor(
    message: string,
    public readonly definite: boolean,
    public readonly kind: BankErrorKind = "unknown",
  ) {
    super(message);
  }
}

export class StravaError extends Error {
  constructor(
    message: string,
    public readonly kind: "auth" | "rate" | "unknown" = "unknown",
  ) {
    super(message);
  }
}

/** A picture handed to the photo check. */
export interface PhotoImage {
  mime: string;
  bytes: Uint8Array;
}

export interface PhotoCheckInput {
  /** The training day the photo is meant to prove, and what was due. */
  day: Ymd;
  kind: Kind;
  /** When it was uploaded, as local wall-clock text: "2026-11-24 19:40". */
  uploadedAt: string;
  image: PhotoImage;
  /** Recent accepted photos of the same kind, newest first, to compare against. */
  earlier: (PhotoImage & { day: Ymd })[];
}

export interface PhotoCheckPort {
  /** true when a Claude API key is saved, so photos can be read. */
  ready(): Promise<boolean>;
  /** Reads what the photo shows. The app applies the rules to the reading itself (engine.ts). */
  read(input: PhotoCheckInput): Promise<PhotoReading>;
}

/**
 * setup = the key is missing, wrong, out of credit or not allowed: someone has to fix it,
 *         and retrying won't help.
 * unavailable = no answer, overloaded, rate limited: try again later.
 * refused = Claude would not read this picture.
 */
export class PhotoCheckError extends Error {
  constructor(
    message: string,
    public readonly kind: "setup" | "unavailable" | "refused",
  ) {
    super(message);
  }
}

/** A message for the friend's phone. */
export interface Notice {
  title: string;
  body: string;
  /** Opened when the notification is tapped. */
  url: string;
}

export interface NotifyPort {
  /**
   * Sends to every phone the friend turned notifications on for. `subscribers` is how many
   * there are, `sent` how many took the message (fewer when a push service had a problem).
   */
  notifyFriend(notice: Notice): Promise<{ subscribers: number; sent: number }>;
}
