// Serves an uploaded workout screenshot to the owner, or to the friend when the
// request carries the secret token from the friend's link.

import crypto from "node:crypto";
import type { NextRequest } from "next/server";
import { isLoggedIn } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { kvGet } from "@/lib/kv";
import { loadProof } from "@/lib/proofs";

function same(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

export async function GET(req: NextRequest, ctx: RouteContext<"/api/proof/[id]">) {
  const { id } = await ctx.params;
  const db = await getDb();
  const token = req.nextUrl.searchParams.get("t");
  const friendToken = await kvGet<string>(db, "friend_token");
  const viaFriend = !!token && !!friendToken && same(token, friendToken);
  if (!viaFriend && !(await isLoggedIn(db))) return new Response("Not allowed.", { status: 401 });
  const proof = /^\d+$/.test(id) ? await loadProof(db, Number(id)) : null;
  if (!proof) return new Response("Not found.", { status: 404 });
  return new Response(Buffer.from(proof.image), {
    headers: { "Content-Type": proof.mime, "Cache-Control": "private, max-age=3600", "X-Content-Type-Options": "nosniff" },
  });
}
