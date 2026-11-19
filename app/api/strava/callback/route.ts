// Step 2 of linking Strava: Strava sends the browser back here with a one-time code.

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { kvDelete, logEvent } from "@/lib/kv";
import { finishStravaLink } from "@/lib/strava";

export async function GET(req: Request) {
  const db = await requireUser();
  const url = new URL(req.url);
  const jar = await cookies();
  const expected = jar.get("showup_oauth")?.value;
  jar.delete("showup_oauth");

  let outcome = "connected";
  if (url.searchParams.get("error")) outcome = "denied";
  else if (!expected || url.searchParams.get("state") !== expected) outcome = "expired";
  else {
    try {
      await finishStravaLink(db, url.searchParams.get("code") ?? "", url.searchParams.get("scope") ?? "");
      await kvDelete(db, "strava_sync");
      await logEvent(db, new Date(), "strava", "Strava connected");
    } catch (e) {
      console.error("Strava link failed:", e);
      outcome = "failed";
    }
  }
  redirect(`/settings?strava=${outcome}#strava`);
}
