// The friend's own app: installing the friend page on a phone opens the friend page,
// not the owner's login.

import { isFriendToken } from "@/lib/collect";
import { getDb } from "@/lib/db";

export async function GET(_req: Request, ctx: RouteContext<"/f/[token]/manifest.webmanifest">) {
  const { token } = await ctx.params;
  const db = await getDb();
  if (!(await isFriendToken(db, token))) return new Response("Not found.", { status: 404 });
  const start = `/f/${token}`;
  return Response.json(
    {
      name: "Showup (friend)",
      short_name: "Showup",
      description: "Collect the money when a workout is skipped.",
      id: start,
      start_url: start,
      scope: start,
      display: "standalone",
      background_color: "#0f0f11",
      theme_color: "#0f0f11",
      icons: [
        { src: "/icon.svg", sizes: "any", type: "image/svg+xml" },
        { src: "/apple-icon", sizes: "180x180", type: "image/png" },
      ],
    },
    { headers: { "Content-Type": "application/manifest+json", "Cache-Control": "private, no-store" } },
  );
}
