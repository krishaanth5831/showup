// Strava: link the account once (OAuth), then read recent activities.
//
// Strava's API terms shape two things here:
//  - activity details are only kept for a few days (see pruneActivities in settle.ts)
//  - they are only ever shown to the account owner, never on the friend's page

import type { Db } from "./db";
import type { Activity } from "./engine";
import { type FetchLike, httpFetch } from "./http";
import { acquireLock, releaseLock, secretGet, secretSet } from "./kv";
import { StravaError, type StravaPort } from "./ports";

export interface StravaState {
  clientId: string;
  clientSecret: string;
  accessToken: string;
  refreshToken: string;
  /** Seconds since 1970 at which the access token stops working. */
  expiresAt: number;
  athleteName: string;
  connectedAt: string;
}

const KEY = "strava";
const TOKEN_URL = "https://www.strava.com/oauth/token";
const API = "https://www.strava.com/api/v3";

export async function loadStrava(db: Db): Promise<StravaState | null> {
  return secretGet<StravaState>(db, KEY);
}

export async function saveStrava(db: Db, state: StravaState): Promise<void> {
  await secretSet(db, KEY, state);
}

export function stravaLinked(s: StravaState | null): boolean {
  return !!s && !!s.refreshToken;
}

/** Where to send the browser so the user can approve access. */
export function authorizeUrl(clientId: string, redirectUri: string, state: string): string {
  const q = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    approval_prompt: "auto",
    // read_all so that activities set to "Only you" are seen as well
    scope: "activity:read_all",
    state,
  });
  return `https://www.strava.com/oauth/authorize?${q}`;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_at?: number;
  athlete?: { firstname?: string; lastname?: string };
  message?: string;
}

async function tokenCall(fetchImpl: FetchLike, body: Record<string, string>): Promise<TokenResponse> {
  let res: Response;
  try {
    res = await fetchImpl(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(body).toString(),
    });
  } catch (e) {
    throw new StravaError(`No answer from Strava (${(e as Error).message}).`);
  }
  const json = (await res.json().catch(() => ({}))) as TokenResponse;
  if (!res.ok || !json.access_token || !json.refresh_token) {
    const kind = res.status === 400 || res.status === 401 ? "auth" : "unknown";
    throw new StravaError(`Strava refused the login (${json.message || `HTTP ${res.status}`}).`, kind);
  }
  return json;
}

/** Second half of linking: swap the one-time code from the redirect for tokens. */
export async function finishStravaLink(
  db: Db,
  code: string,
  grantedScope: string,
  fetchImpl: FetchLike = httpFetch,
): Promise<StravaState> {
  const saved = await loadStrava(db);
  if (!saved?.clientId || !saved.clientSecret) throw new StravaError("Enter the Strava client ID and secret first.", "auth");
  if (!grantedScope.split(",").some((s) => s.startsWith("activity:read"))) {
    throw new StravaError("Strava was not given permission to read activities. Connect again and leave the box ticked.", "auth");
  }
  const t = await tokenCall(fetchImpl, {
    client_id: saved.clientId,
    client_secret: saved.clientSecret,
    code,
    grant_type: "authorization_code",
  });
  const next: StravaState = {
    ...saved,
    accessToken: t.access_token as string,
    refreshToken: t.refresh_token as string,
    expiresAt: t.expires_at ?? 0,
    athleteName: [t.athlete?.firstname, t.athlete?.lastname].filter(Boolean).join(" "),
    connectedAt: new Date().toISOString(),
  };
  await saveStrava(db, next);
  return next;
}

interface RawActivity {
  id: number;
  name?: string;
  sport_type?: string;
  type?: string;
  distance?: number;
  moving_time?: number;
  elapsed_time?: number;
  manual?: boolean;
  start_date_local?: string;
}

/**
 * Strava writes the local start time as if it were UTC ("2026-11-23T18:30:00Z" means
 * 18:30 on the athlete's clock), so the day and time are read straight from the text.
 */
export function mapActivity(a: RawActivity): Activity | null {
  const local = a.start_date_local ?? "";
  if (!a.id || local.length < 16) return null;
  return {
    id: String(a.id),
    sportType: a.sport_type || a.type || "Unknown",
    name: a.name ?? "",
    localDate: local.slice(0, 10),
    startTime: local.slice(11, 16),
    // Rounded down: 3499.6 m must not pass as 3.5 km.
    distanceM: Math.floor(a.distance ?? 0),
    movingS: Math.floor(a.moving_time ?? 0),
    elapsedS: Math.floor(a.elapsed_time ?? 0),
    manual: a.manual === true,
  };
}

export class StravaClient implements StravaPort {
  constructor(
    private db: Db,
    private fetchImpl: FetchLike = httpFetch,
    private nowSeconds: () => number = () => Math.floor(Date.now() / 1000),
  ) {}

  async connected(): Promise<boolean> {
    return stravaLinked(await loadStrava(this.db));
  }

  /**
   * A working access token. They last six hours; renewing one also replaces the refresh
   * token, and the old one dies at once, so the new pair is saved before anything else happens.
   */
  private async accessToken(force = false): Promise<string> {
    let s = await loadStrava(this.db);
    if (!s || !stravaLinked(s)) throw new StravaError("Strava is not connected.", "auth");
    if (!force && s.expiresAt - 120 > this.nowSeconds()) return s.accessToken;

    // Only one renewal at a time: two at once would invalidate each other's refresh token.
    const mine = await acquireLock(this.db, "strava-refresh", 20);
    try {
      if (!mine) {
        await new Promise((r) => setTimeout(r, 1500));
        s = (await loadStrava(this.db)) as StravaState;
        if (s.expiresAt - 120 > this.nowSeconds()) return s.accessToken;
      }
      const t = await tokenCall(this.fetchImpl, {
        client_id: s.clientId,
        client_secret: s.clientSecret,
        grant_type: "refresh_token",
        refresh_token: s.refreshToken,
      });
      const next: StravaState = {
        ...s,
        accessToken: t.access_token as string,
        refreshToken: t.refresh_token as string,
        expiresAt: t.expires_at ?? 0,
      };
      await saveStrava(this.db, next);
      return next.accessToken;
    } finally {
      if (mine) await releaseLock(this.db, "strava-refresh");
    }
  }

  async fetchActivities(afterEpoch: number, beforeEpoch: number): Promise<Activity[]> {
    let token = await this.accessToken();
    const out: Activity[] = [];
    for (let page = 1; page <= 20; page++) {
      const url = `${API}/athlete/activities?after=${afterEpoch}&before=${beforeEpoch}&per_page=200&page=${page}`;
      let res: Response;
      try {
        res = await this.fetchImpl(url, { headers: { Authorization: `Bearer ${token}` } });
        if (res.status === 401 && page === 1) {
          token = await this.accessToken(true);
          res = await this.fetchImpl(url, { headers: { Authorization: `Bearer ${token}` } });
        }
      } catch (e) {
        if (e instanceof StravaError) throw e;
        throw new StravaError(`No answer from Strava (${(e as Error).message}).`);
      }
      if (res.status === 401) throw new StravaError("Strava no longer accepts the connection. Connect Strava again.", "auth");
      if (res.status === 429) throw new StravaError("Strava's request limit was reached. It will work again shortly.", "rate");
      if (!res.ok) throw new StravaError(`Strava answered with HTTP ${res.status}.`);
      const items = (await res.json()) as RawActivity[];
      if (!Array.isArray(items)) throw new StravaError("Strava sent something unexpected.");
      for (const raw of items) {
        const a = mapActivity(raw);
        if (a) out.push(a);
      }
      if (items.length < 200) break;
    }
    return out;
  }
}
