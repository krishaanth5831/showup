// Step 1 of linking Strava: send the browser to Strava's approval screen.

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { originOf } from "@/lib/origin";
import { randomToken } from "@/lib/secrets";
import { authorizeUrl, loadStrava } from "@/lib/strava";

export async function GET(req: Request) {
  const db = await requireUser();
  const app = await loadStrava(db);
  if (!app?.clientId) redirect("/settings?strava=missing#strava");
  // A one-time value that must come back unchanged, so nobody else can finish this link.
  const state = randomToken(16);
  (await cookies()).set("showup_oauth", state, { httpOnly: true, sameSite: "lax", path: "/", maxAge: 600 });
  redirect(authorizeUrl(app.clientId, `${originOf(req.headers)}/api/strava/callback`, state));
}
