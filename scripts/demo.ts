// Fills a separate demo database with five weeks of made-up history, so every screen
// has something to show. Your real local data (.data) is not touched.
//
//   npm run demo            -> seeds .data-demo and starts the app on http://localhost:3210
//   DEMO_TODAY=run|strength|done|rest npm run demo   -> choose what today looks like
//
// Sign in with the password printed at the end. No bank or Strava is connected in the
// demo, so nothing here can move money.

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const DIR = path.join(process.cwd(), ".data-demo");
process.env.SHOWUP_DATA_DIR = DIR;
delete process.env.DATABASE_URL;
delete process.env.POSTGRES_URL;

const PASSWORD = "demo-password";

/** A plain PNG picture, standing in for a watch screenshot. */
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
  const { saveProof } = await import("../lib/proofs");
  const { arm, ensureRules, rulesFor, saveRules } = await import("../lib/rules");
  const { hashPassword } = await import("../lib/secrets");
  const { runSettlement, syncActivities } = await import("../lib/settle");
  const { claimSick } = await import("../lib/sick");
  const { addDays, datesBetween, localDate, weekStart, weekdayOf } = await import("../lib/time");
  const { FakeBank, FakeStrava, at } = await import("../tests/fakes");

  const db = await getDb();
  const strava = new FakeStrava();
  const bank = new FakeBank();
  let clock = new Date();
  bank.now = () => clock;

  const realNow = new Date();
  const today = localDate(realNow);
  const thisMonday = weekStart(today);
  const start = addDays(thisMonday, -35);
  const opened = addDays(start, -1);
  const friend = { friendName: "Sam de Vries", friendIban: "NL91ABNA0417164300" };

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
      if (kind === "run") strava.run(day, 3.6 + ((shot * 37) % 50) / 10, "07:1" + (shot % 10));
      else if (shot % 3 === 0) strava.lift(day, 48, "18:30");
      else await saveProof(db, at(day, "19:40"), fakeScreenshot(shot));
      shot++;
    }
    // The friend gives the first penalty back three weeks in, and pays for pizza once.
    if (day === addDays(start, 24)) {
      clock = at(day, "12:00");
      bank.receive(1000, friend.friendIban, friend.friendName, "Showup, here you go");
      bank.receive(1250, friend.friendIban, friend.friendName, "pizza");
    }
    clock = at(addDays(day, 1), "03:30");
    await runSettlement(db, { strava, bank }, clock);
  }

  if (want === "done") strava.run(today, 5.2, "07:42");
  // Leave the last week of activities in the local copy, as a real sync would.
  await syncActivities(db, strava, addDays(today, -6), today, realNow);
  await kvSet(db, "strava_sync", { at: realNow.toISOString(), ok: true, error: null });
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
