// Push notifications to the friend's phone, through the browser's own push service
// (Web Push). No account anywhere is needed: the app makes its own key pair once.
//
// The friend opens their page, taps "Turn on notifications", and their browser hands over
// a subscription (an address at Google's, Apple's or Mozilla's push service). On an iPhone
// this only works after the page was added to the Home Screen.

import { generateVAPIDKeys, sendNotification } from "web-push";
import type { Db } from "./db";
import { secretGet, secretSet } from "./kv";
import type { Notice, NotifyPort } from "./ports";

interface Vapid {
  publicKey: string;
  privateKey: string;
}

/** Push services want a way to reach whoever sends. A neutral address, never the owner's own. */
const CONTACT = process.env.PUSH_CONTACT || "mailto:showup@example.com";

/** The app's key pair, made on first use. */
export async function vapidKeys(db: Db): Promise<Vapid> {
  const saved = await secretGet<Vapid>(db, "vapid");
  if (saved) return saved;
  const made = generateVAPIDKeys();
  await secretSet(db, "vapid", made);
  return made;
}

export interface PushSubscriptionJson {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export function isSubscription(v: unknown): v is PushSubscriptionJson {
  const s = v as PushSubscriptionJson;
  return (
    !!s &&
    typeof s.endpoint === "string" &&
    /^https:\/\/[^\s]+$/.test(s.endpoint) &&
    s.endpoint.length < 1000 &&
    typeof s.keys?.p256dh === "string" &&
    typeof s.keys?.auth === "string" &&
    s.keys.p256dh.length < 200 &&
    s.keys.auth.length < 100
  );
}

export async function saveSubscription(db: Db, sub: PushSubscriptionJson, now: Date): Promise<void> {
  await db.query(
    `INSERT INTO push_subscriptions (endpoint, keys, created_at) VALUES ($1, $2::jsonb, $3)
     ON CONFLICT (endpoint) DO UPDATE SET keys = EXCLUDED.keys`,
    [sub.endpoint, JSON.stringify(sub.keys), now],
  );
}

export async function removeSubscription(db: Db, endpoint: string): Promise<void> {
  await db.query("DELETE FROM push_subscriptions WHERE endpoint = $1", [endpoint]);
}

export async function subscriptionCount(db: Db): Promise<number> {
  const rows = await db.query<{ n: number }>("SELECT COUNT(*)::int AS n FROM push_subscriptions");
  return rows[0].n;
}

export class WebPushNotifier implements NotifyPort {
  constructor(private db: Db) {}

  async notifyFriend(notice: Notice): Promise<{ subscribers: number; sent: number }> {
    const subs = await this.db.query<{ endpoint: string; keys: PushSubscriptionJson["keys"] | string }>(
      "SELECT endpoint, keys FROM push_subscriptions",
    );
    if (subs.length === 0) return { subscribers: 0, sent: 0 };
    const vapid = await vapidKeys(this.db);
    const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || undefined;
    let sent = 0;
    for (const s of subs) {
      const keys = typeof s.keys === "string" ? JSON.parse(s.keys) : s.keys;
      try {
        await sendNotification({ endpoint: s.endpoint, keys }, JSON.stringify(notice), {
          vapidDetails: { subject: CONTACT, publicKey: vapid.publicKey, privateKey: vapid.privateKey },
          TTL: 3 * 86_400,
          urgency: "high",
          timeout: 15_000,
          ...(proxy ? { proxy } : {}),
        });
        sent++;
        await this.db.query("UPDATE push_subscriptions SET last_ok_at = now() WHERE endpoint = $1", [s.endpoint]);
      } catch (e) {
        const status = (e as { statusCode?: number }).statusCode;
        // 404/410: the phone dropped the subscription (app removed, permission taken back).
        if (status === 404 || status === 410) await removeSubscription(this.db, s.endpoint);
        else console.error("push failed:", status ?? (e as Error).message);
      }
    }
    return { subscribers: subs.length, sent };
  }
}
