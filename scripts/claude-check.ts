// Runs the real photo check on a picture, without touching the app's database: Claude reads
// it, and the app's rules say whether it would count. Each run costs a few cents.
//
//   ANTHROPIC_API_KEY=sk-ant-... npm run check:claude -- <photo> <run|strength> [YYYY-MM-DD] [earlier.jpg@YYYY-MM-DD ...]
//
// The day defaults to today. Earlier photos (newest first, each with the day it proved) are
// what the new one is compared with.

import fs from "node:fs";
import { ClaudePhotoCheck, connectClaude } from "../lib/claude";
import { openMemoryDb } from "../lib/db";
import { DEFAULT_RULES, type Kind, judgePhoto } from "../lib/engine";
import { sniffImage } from "../lib/proofs";
import { localDate, localParts } from "../lib/time";

process.env.APP_SECRET ??= "claude-check-only-secret-not-used-for-anything-else";

async function main() {
  const [photo, kindArg, dayArg, ...earlierPaths] = process.argv.slice(2);
  const key = process.env.ANTHROPIC_API_KEY ?? "";
  if (!photo || (kindArg !== "run" && kindArg !== "strength") || !key) {
    console.error("Usage: ANTHROPIC_API_KEY=sk-ant-... npm run check:claude -- <photo> <run|strength> [YYYY-MM-DD] [earlier.jpg@YYYY-MM-DD ...]");
    process.exit(2);
  }
  const kind = kindArg as Kind;
  const now = new Date();
  const day = dayArg && /^\d{4}-\d{2}-\d{2}$/.test(dayArg) ? dayArg : localDate(now);
  const load = (file: string) => {
    const bytes = new Uint8Array(fs.readFileSync(file));
    const mime = sniffImage(bytes);
    if (!mime) throw new Error(`${file} is not a JPEG, PNG or WebP picture.`);
    return { mime, bytes };
  };

  const db = await openMemoryDb();
  await connectClaude(db, key);
  console.log("Key accepted.");
  const p = localParts(now);
  const started = Date.now();
  const reading = await new ClaudePhotoCheck(db).read({
    day,
    kind,
    uploadedAt: `${p.ymd} ${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`,
    image: load(photo),
    earlier: earlierPaths.map((arg) => {
      const [file, on] = arg.split("@");
      return { ...load(file), day: on ?? "2000-01-01" };
    }),
  });
  console.log(`Claude read (${((Date.now() - started) / 1000).toFixed(1)} s):`, reading);
  const verdict = judgePhoto(reading, day, kind, DEFAULT_RULES, []);
  console.log(verdict.ok ? `Counts for the ${kind} on ${day}.` : `Does not count: ${verdict.why}`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
