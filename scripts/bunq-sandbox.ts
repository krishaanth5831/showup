// Live check of the money path against bunq's SANDBOX (fake money, real API).
//
//   npm run check:bunq
//
// It creates two throw-away sandbox users ("me" and "friend"), then lets the real nightly
// job run a missed week: the penalties must arrive on the friend's account exactly once,
// and money the friend sends back must be recognised. Nothing here can touch a real account:
// it only ever uses API keys that bunq's sandbox hands out.

import { openMemoryDb } from "../lib/db";
import { BunqBank, BunqClient, bunqConnect, saveBunq } from "../lib/bunq";
import { DEFAULT_RULES } from "../lib/engine";
import { httpFetch } from "../lib/http";
import { BankError } from "../lib/ports";
import { arm, ensureRules, saveRules } from "../lib/rules";
import { runSettlement } from "../lib/settle";
import { addDays, localDate, weekStart } from "../lib/time";
import { FakeNotifier, FakePhotoCheck, FakeStrava } from "../tests/fakes";

process.env.APP_SECRET ||= "sandbox-check-secret-0123456789-abcdefghij";

let failed = 0;
function check(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  if (!ok) failed++;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function newSandboxKey(): Promise<string> {
  const res = await httpFetch("https://public-api.sandbox.bunq.com/v1/sandbox-user-person", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-cache",
      "User-Agent": "showup/1.0",
      "X-Bunq-Client-Request-Id": crypto.randomUUID(),
      "X-Bunq-Geolocation": "0 0 0 0 000",
      "X-Bunq-Language": "en_US",
      "X-Bunq-Region": "nl_NL",
    },
    body: "{}",
  });
  const json = (await res.json()) as { Response: { ApiKey?: { api_key: string } }[] };
  const key = json.Response.find((x) => x.ApiKey)?.ApiKey?.api_key;
  if (!key) throw new Error("The sandbox did not hand out an API key.");
  return key;
}

async function connect(label: string): Promise<BunqClient> {
  const state = await bunqConnect(await newSandboxKey());
  const client = new BunqClient(state);
  const accounts = await client.listAccounts();
  client.useAccount(accounts[0]);
  console.log(`      ${label}: ${accounts[0].name}, ${accounts[0].iban}`);
  return client;
}

async function main() {
  console.log("Connecting two sandbox users...");
  const me = await connect("me");
  const friend = await connect("friend");
  check("handshake gives a sandbox session", me.current.env === "sandbox" && me.current.sessionToken.length > 10);

  await me.sandboxTopUp(50_000);
  await sleep(2500);
  check("top-up arrived", (await me.balanceCents()) === 50_000, `balance ${await me.balanceCents()}`);

  // The app's own database, with my bunq connection stored the way the app stores it.
  const db = await openMemoryDb();
  await saveBunq(db, me.current);
  const bank = new BunqBank(db);
  const strava = new FakeStrava(); // linked, and no activities at all: every session is a miss
  const photos = new FakePhotoCheck(); // and no photos are uploaded either
  const notify = new FakeNotifier();

  // Arm at the start of last week, then run the nightly job once, now.
  const now = new Date();
  const today = localDate(now);
  const monday = weekStart(addDays(today, -7));
  const opened = addDays(monday, -1);
  await ensureRules(db, opened);
  // bunq sends the money here: that is what this check is for.
  await saveRules(db, opened, { ...DEFAULT_RULES, collection: "bank", friendKeepsPercent: 0, friendName: friend.current.accountName, friendIban: friend.current.accountIban });
  await arm(db, opened);

  const report = await runSettlement(db, { strava, bank, photos, notify }, now);
  const lastWeek = report.judged.filter((j) => j.date < addDays(monday, 7));
  check("last week judged as five misses", lastWeek.length === 5 && lastWeek.every((j) => j.status === "missed"));
  check("charges are 10, 20, 40, 80, 0", JSON.stringify(lastWeek.map((j) => j.chargeCents)) === "[1000,2000,4000,8000,0]");
  check("no payment problems", report.payProblems.length === 0, report.payProblems.join("; "));

  await sleep(1500);
  const got = (await friend.listPayments()).filter((p) => p.amountCents > 0 && p.description.includes("SHOWUP-"));
  const total = got.reduce((s, p) => s + p.amountCents, 0);
  const expected = report.judged.reduce((s, j) => s + j.chargeCents, 0);
  check("friend received every penalty", total === expected && got.length === report.paid.length, `${got.length} transfers, ${total} cents, expected ${expected}`);
  check("transfers came from my IBAN", got.every((p) => p.counterpartyIban === me.current.accountIban));

  const again = await runSettlement(db, { strava, bank, photos, notify }, new Date());
  await sleep(1000);
  const after = (await friend.listPayments()).filter((p) => p.amountCents > 0 && p.description.includes("SHOWUP-"));
  check("a second run sends nothing more", again.paid.length === 0 && after.length === got.length);

  // A "lost answer": pretend the app never heard back about a payment that did go out.
  await db.query("UPDATE penalties SET status = 'sending', bank_payment_id = NULL, sent_at = NULL, sending_at = now() WHERE id = (SELECT MIN(id) FROM penalties)");
  await runSettlement(db, { strava, bank, photos, notify }, new Date());
  const recovered = await db.query<{ status: string; bank_payment_id: string | null }>("SELECT status, bank_payment_id FROM penalties ORDER BY id LIMIT 1");
  await sleep(1000);
  const afterLost = (await friend.listPayments()).filter((p) => p.amountCents > 0 && p.description.includes("SHOWUP-"));
  check("a payment with a lost answer is found in the bank, not sent again", recovered[0].status === "held" && !!recovered[0].bank_payment_id && afterLost.length === got.length);

  // The friend gives the first two penalties back.
  await friend.pay({ amountCents: 3000, iban: me.current.accountIban, name: me.current.accountName, description: "Showup return" });
  await friend.pay({ amountCents: 700, iban: me.current.accountIban, name: me.current.accountName, description: "lunch" });
  await sleep(1500);
  const back = await runSettlement(db, { strava, bank, photos, notify }, new Date());
  const rows = await db.query<{ status: string; returned_cents: number }>("SELECT status, returned_cents FROM penalties ORDER BY session_date");
  check("returned money is matched oldest first", back.returnedCents === 3000 && rows[0].status === "returned" && rows[1].status === "returned" && rows[2].status === "held", JSON.stringify(rows));
  const inc = await db.query<{ is_return: boolean; description: string }>("SELECT is_return, description FROM incoming ORDER BY amount_cents");
  check("other money from the friend is not counted as a return", inc.length === 2 && inc[0].is_return === false && inc[1].is_return === true);

  // Refusals must be reported as definite, so they are safe to retry.
  try {
    await me.pay({ amountCents: 9_000_000, iban: friend.current.accountIban, name: friend.current.accountName, description: "too much" });
    check("an oversized payment is refused", false);
  } catch (e) {
    check("an empty account is a clear refusal", e instanceof BankError && e.definite && e.kind === "funds", (e as Error).message);
  }

  // An expired session must renew itself. (bunq allows one new session per 30 seconds.)
  console.log("      waiting 31 s for bunq's session limit...");
  await sleep(31_000);
  let saved = 0;
  const stale = new BunqClient({ ...me.current, sessionToken: "0000000000000000000000000000000000000000000000000000000000000000" }, async () => {
    saved++;
  });
  const balance = await stale.balanceCents();
  check("an expired session renews itself", saved === 1 && balance > 0, `balance ${balance}`);

  console.log(failed ? `\n${failed} check(s) FAILED` : "\nAll checks passed against the bunq sandbox.");
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error("FAILED:", e);
  process.exit(1);
});
