// Fills a separate demo database with five weeks of made-up history, so every screen
// has something to show. Your real local data (.data) is not touched.
//
//   npm run demo            -> seeds .data-demo and starts the app on http://localhost:3210
//   DEMO_TODAY=run|strength|done|rest npm run demo   -> choose what today looks like
//
// Sign in with the password printed at the end. No bank, Strava or Claude is connected in
// the demo: a stand-in reads the made-up photos, the made-up friend collects and gives back
// by hand, and nothing here can move money or send a notification.

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const DIR = path.join(process.cwd(), ".data-demo");
process.env.SHOWUP_DATA_DIR = DIR;
delete process.env.DATABASE_URL;
delete process.env.POSTGRES_URL;

const PASSWORD = "demo-password";

/** A plain PNG picture, standing in for a workout screenshot. */
function fakeScreenshot(seed: number): Uint8Array {
  const w = 240;
  const h = 320;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const i = y * (w * 3 + 1) + 1 + x * 3;
      const band = Math.floor(y / 40) % 2 === 0;
      const v = band ? 28 + ((seed * 7) % 20) : 40 + ((seed * 13) % 30);
      raw[i] = v;
      raw[i + 1] = v + (x < (w * ((seed % 5) + 3)) / 9 && !band ? 120 : 0);
      raw[i + 2] = v + 6;
    }
  }
  // Stamp the seed into the first pixel, so no two made-up pictures are byte-identical.
  raw[1] = seed & 255;
  raw[2] = (seed >> 8) & 255;
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const head = Buffer.alloc(13);
  head.writeUInt32BE(w, 0);
  head.writeUInt32BE(h, 4);
  head.set([8, 2, 0, 0, 0], 8);
  return new Uint8Array(
    Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", head), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]),
  );
}

async function main() {
  fs.rmSync(DIR, { recursive: true, force: true });
  const { getDb } = await import("../lib/db");
  const { DEFAULT_RULES } = await import("../lib/engine");
  const { kvSet } = await import("../lib/kv");
  const { markCollected, markReturned, saveOwnerDetails } = await import("../lib/collect");
  const { saveProof } = await import("../lib/proofs");
  const { arm, ensureRules, rulesFor, saveRules } = await import("../lib/rules");
  const { hashPassword } = await import("../lib/secrets");
  const { runSettlement } = await import("../lib/settle");
  const { claimSick } = await import("../lib/sick");
  const { addDays, datesBetween, localDate, weekStart, weekdayOf } = await import("../lib/time");
  const { FakeBank, FakeNotifier, FakePhotoCheck, FakeStrava, at } = await import("../tests/fakes");

  const db = await getDb();
  const strava = new FakeStrava();
  strava.linked = false;
  const bank = new FakeBank();
  bank.linked = false;
  const notify = new FakeNotifier();
  const photos = new FakePhotoCheck();
  photos.show = (input) => {
    if (input.kind === "strength") return { durationS: 48 * 60 + Number(input.day.slice(8)), summary: "Traditional strength training, 48 min (made-up demo photo)" };
    const km = 3.6 + (Number(input.day.slice(8)) % 25) / 10;
    return { distanceKm: km, summary: `Outdoor run, ${km.toFixed(2)} km (made-up demo photo)` };
  };
  let clock = new Date();
  bank.now = () => clock;

  const realNow = new Date();
  const today = localDate(realNow);
  const thisMonday = weekStart(today);
  const start = addDays(thisMonday, -35);
  const opened = addDays(start, -1);
  const friend = { friendName: "Sam de Vries", friendIban: "" };
  await saveOwnerDetails(db, { name: "Alex", iban: "NL91ABNA0417164300" });

  // What today should look like (optional).
  const want = process.env.DEMO_TODAY;
  const schedule = { ...DEFAULT_RULES.schedule };
  if (want === "run" || want === "done") schedule[weekdayOf(today)] = "run";
  if (want === "strength") schedule[weekdayOf(today)] = "strength";
  if (want === "rest") delete schedule[weekdayOf(today)];

  await ensureRules(db, opened);
  await saveRules(db, opened, { ...DEFAULT_RULES, ...friend, schedule });
  await arm(db, opened);

  // Days that get skipped, counted from the first Monday.
  const skipped = new Set([addDays(start, 9), addDays(start, 18), addDays(start, 19)].concat(today > addDays(thisMonday, 1) ? [addDays(thisMonday, 1)] : []));
  // One sick day, on last week's Tuesday.
  const sickDay = addDays(thisMonday, -6);
  let shot = 1;

  for (const day of datesBetween(start, addDays(today, -1))) {
    const kind = (await rulesFor(db, day))?.rules.schedule[weekdayOf(day)];
    if (kind && day === sickDay) {
      await claimSick(db, at(day, "09:00"), day, true);
    } else if (kind && !skipped.has(day)) {
      await saveProof(db, at(day, "19:40"), day, fakeScreenshot(shot), photos);
      shot++;
    }
    clock = at(addDays(day, 1), "03:30");
    await runSettlement(db, { strava, bank, photos, notify }, clock);
    // The friend collects each penalty the evening after the miss (except the latest one, so
    // there is something left to collect), and gives back whatever is due a few days late.
    const owed = await db.query<{ id: number; session_date: string }>("SELECT id, session_date FROM penalties WHERE status = 'owed'");
    for (const p of owed) if (p.session_date < addDays(today, -3)) await markCollected(db, at(addDays(p.session_date, 1), "20:00"), p.id, notify);
    const due = await db.query<{ id: number }>("SELECT id FROM penalties WHERE status = 'held' AND release_on <= $1", [addDays(day, -3)]);
    for (const p of due) await markReturned(db, at(day, "18:00"), p.id, notify);
  }

  if (want === "done") await saveProof(db, realNow, today, fakeScreenshot(99), photos);
  await kvSet(db, "last_run", { at: clock.toISOString(), judged: 1, problems: 0 });
  await kvSet(db, "password", hashPassword(PASSWORD));

  const sessions = await db.query<{ n: number }>("SELECT COUNT(*)::int AS n FROM sessions");
  const pens = await db.query<{ n: number; total: number }>("SELECT COUNT(*)::int AS n, COALESCE(SUM(amount_cents),0)::int AS total FROM penalties");
  console.log(`\nDemo data ready in .data-demo: ${sessions[0].n} judged days, ${pens[0].n} penalties (${pens[0].total / 100} euro).`);
  console.log(`Sign in with the password:  ${PASSWORD}\n`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
