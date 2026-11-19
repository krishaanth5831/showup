// The nightly job's entry point. Vercel Cron calls it once a day (see vercel.json) and
// sends "Authorization: Bearer <CRON_SECRET>". Anyone without the secret is turned away.

import crypto from "node:crypto";
import { getDb } from "@/lib/db";
import { runSettlement } from "@/lib/settle";
import { realPorts } from "@/lib/work";

export const maxDuration = 60;

function allowed(header: string | null): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret || !header) return false;
  const want = Buffer.from(`Bearer ${secret}`);
  const got = Buffer.from(header);
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}

export async function GET(req: Request) {
  if (!process.env.CRON_SECRET) return Response.json({ error: "CRON_SECRET is not set." }, { status: 500 });
  if (!allowed(req.headers.get("authorization"))) return Response.json({ error: "Not allowed." }, { status: 401 });
  try {
    const db = await getDb();
    const report = await runSettlement(db, realPorts(db), new Date());
    return Response.json(report);
  } catch (e) {
    console.error("nightly job failed:", e);
    return Response.json({ error: (e as Error).message }, { status: 500 });
  }
}
