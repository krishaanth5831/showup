"use server";

// What the friend can do from their page. The page is reached through a secret link and
// has no login, so every action checks the link's token itself.

import { refresh } from "next/cache";
import type { FormState } from "@/app/actions";
import { CollectError, isFriendToken, markCollected, markReturned } from "@/lib/collect";
import { getDb } from "@/lib/db";
import { euros } from "@/lib/engine";
import { isSubscription, saveSubscription, WebPushNotifier } from "@/lib/push";
import { longDate } from "@/lib/time";

const NOT_ALLOWED: FormState = { error: "This link no longer works. Ask for the new one." };

export async function collectedAction(token: string, id: number, _prev: FormState): Promise<FormState> {
  const db = await getDb();
  if (!(await isFriendToken(db, token))) return NOT_ALLOWED;
  try {
    const p = await markCollected(db, new Date(), id, new WebPushNotifier(db));
    refresh();
    return { ok: `Marked as collected. Hold it until ${p.release_on ? longDate(p.release_on) : "the hold time is over"}.` };
  } catch (e) {
    if (e instanceof CollectError) return { error: e.message };
    console.error(e);
    return { error: "Something went wrong. Nothing was changed." };
  }
}

export async function givenBackAction(token: string, id: number, _prev: FormState): Promise<FormState> {
  const db = await getDb();
  if (!(await isFriendToken(db, token))) return NOT_ALLOWED;
  try {
    const p = await markReturned(db, new Date(), id, new WebPushNotifier(db));
    refresh();
    return { ok: `Marked as given back. ${euros(p.keep_cents)} is yours to keep.` };
  } catch (e) {
    if (e instanceof CollectError) return { error: e.message };
    console.error(e);
    return { error: "Something went wrong. Nothing was changed." };
  }
}

/** Stores the phone's push subscription and sends a first notification to show it works. */
export async function subscribeAction(token: string, subscription: unknown): Promise<FormState> {
  const db = await getDb();
  if (!(await isFriendToken(db, token))) return NOT_ALLOWED;
  if (!isSubscription(subscription)) return { error: "The phone sent something unexpected. Try again." };
  await saveSubscription(db, subscription, new Date());
  const r = await new WebPushNotifier(db).notifyFriend({
    title: "Notifications are on",
    body: "You will hear here when a workout is skipped and when money is due back.",
    url: `/f/${token}`,
  });
  refresh();
  return r.sent > 0 ? { ok: "Notifications are on. A test message is on its way." } : { error: "Saved, but the test message did not arrive. Try again later." };
}
