// The two outside services, described by what the app needs from them. The real
// implementations live in strava.ts and bunq.ts; the tests plug in fakes.

import type { Activity } from "./engine";

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
