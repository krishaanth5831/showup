"use server";

import { applyBankSwitch, planBankSwitch } from "@/lib/bank-switch";
import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { createPassword, login, logout, requireUser } from "@/lib/auth";
import { BunqClient, bunqClient, bunqConnect, loadBunq, saveBunq } from "@/lib/bunq";
import { ClaudePhotoCheck, connectClaude, loadClaude } from "@/lib/claude";
import { getDb } from "@/lib/db";
import { type Kind, type Rules, isValidIban, normalizeIban } from "@/lib/engine";
import { kvDelete, kvSet, logEvent } from "@/lib/kv";
import { BankError, PhotoCheckError, StravaError } from "@/lib/ports";
import { ProofError, saveProof } from "@/lib/proofs";
import { RuleError, arm, cancelPending, disarm, ruleState, saveRules } from "@/lib/rules";
import { allocateReturns, runSettlement } from "@/lib/settle";
import { SickError, claimSick, unclaimSick } from "@/lib/sick";
import { randomToken } from "@/lib/secrets";
import { loadStrava, saveStrava } from "@/lib/strava";
import { WEEKDAYS, localDate, longDate, monthName, shortDate } from "@/lib/time";
import { checksOn, realPorts, summarize } from "@/lib/work";

export interface FormState {
  ok?: string;
  error?: string;
}

/** Turns anything thrown into a message a person can act on. */
function fail(e: unknown): FormState {
  if (
    e instanceof RuleError ||
    e instanceof ProofError ||
    e instanceof SickError ||
    e instanceof BankError ||
    e instanceof StravaError ||
    e instanceof PhotoCheckError
  ) {
    return { error: e.message };
  }
  console.error(e);
  return { error: "Something went wrong. Nothing was changed." };
}

// ---------- signing in ----------

export async function setupAction(_prev: FormState, form: FormData): Promise<FormState> {
  const password = String(form.get("password") ?? "");
  if (password !== String(form.get("again") ?? "")) return { error: "The two passwords are not the same." };
  const problem = await createPassword(await getDb(), password);
  if (problem) return { error: problem };
  redirect("/");
}

export async function loginAction(_prev: FormState, form: FormData): Promise<FormState> {
  const problem = await login(await getDb(), String(form.get("password") ?? ""));
  if (problem) return { error: problem };
  redirect("/");
}

export async function logoutAction(): Promise<void> {
  await logout();
  redirect("/login");
}

// ---------- today ----------

/** A workout photo for one training day. The day comes from the button and is checked again on the server. */
export async function uploadProofAction(day: string, _prev: FormState, form: FormData): Promise<FormState> {
  const db = await requireUser();
  const file = form.get("image");
  if (!(file instanceof File) || file.size === 0) return { error: "Choose a picture first." };
  try {
    const saved = await saveProof(db, new Date(), day, new Uint8Array(await file.arrayBuffer()), new ClaudePhotoCheck(db));
    refresh();
    if (saved.status === "waiting") {
      return { ok: `Saved for ${shortDate(saved.date)}, but Claude can't be reached right now. It is checked again shortly, and the day waits for it.` };
    }
    return { ok: `Counted for ${shortDate(saved.date)}.${saved.summary ? ` ${saved.summary}` : ""}` };
  } catch (e) {
    return fail(e);
  }
}

/** Marks a training day as a sick day. The day comes from the button, and is checked again on the server. */
export async function sickDayAction(day: string, _prev: FormState): Promise<FormState> {
  const db = await requireUser();
  try {
    const used = await claimSick(db, new Date(), day, await checksOn(db));
    refresh();
    return { ok: `Sick day used for ${shortDate(used.date)}. ${used.left} of ${used.limit} left in ${monthName(used.date)}.` };
  } catch (e) {
    return fail(e);
  }
}

export async function undoSickDayAction(day: string, _prev: FormState): Promise<FormState> {
  const db = await requireUser();
  try {
    await unclaimSick(db, new Date(), day, await checksOn(db));
    refresh();
    return { ok: "Sick day taken back." };
  } catch (e) {
    return fail(e);
  }
}

export async function checkNowAction(_prev: FormState): Promise<FormState> {
  const db = await requireUser();
  try {
    const report = await runSettlement(db, realPorts(db), new Date());
    refresh();
    return { ok: summarize(report) };
  } catch (e) {
    return fail(e);
  }
}

// ---------- Strava ----------

export async function saveStravaAppAction(_prev: FormState, form: FormData): Promise<FormState> {
  const db = await requireUser();
  const clientId = String(form.get("clientId") ?? "").trim();
  const clientSecret = String(form.get("clientSecret") ?? "").trim();
  if (!/^\d+$/.test(clientId)) return { error: "The client ID is a number. Copy it from your Strava API page." };
  if (clientSecret.length < 20) return { error: "The client secret looks too short." };
  const old = await loadStrava(db);
  const same = old?.clientId === clientId && old.clientSecret === clientSecret;
  await saveStrava(db, {
    clientId,
    clientSecret,
    accessToken: same ? old.accessToken : "",
    refreshToken: same ? old.refreshToken : "",
    expiresAt: same ? old.expiresAt : 0,
    athleteName: same ? old.athleteName : "",
    connectedAt: same ? old.connectedAt : "",
  });
  refresh();
  return { ok: "Saved. Now press Connect Strava." };
}

async function lockedOrPlanned(): Promise<boolean> {
  const db = await getDb();
  const state = await ruleState(db, localDate(new Date()));
  return state.locked || !!state.pending?.rules.armed;
}

export async function disconnectStravaAction(_prev: FormState): Promise<FormState> {
  const db = await requireUser();
  // Strava is an extra way to prove a session, next to photos, so it can go at any time.
  await kvDelete(db, "strava");
  await kvDelete(db, "strava_sync");
  refresh();
  return { ok: "Strava disconnected." };
}

// ---------- photo check ----------

export async function connectClaudeAction(_prev: FormState, form: FormData): Promise<FormState> {
  const db = await requireUser();
  const apiKey = String(form.get("apiKey") ?? "").trim();
  if (!apiKey.startsWith("sk-ant-")) return { error: "That does not look like a Claude API key. They start with sk-ant-." };
  try {
    await connectClaude(db, apiKey);
    await logEvent(db, new Date(), "photos", "Claude API key saved");
    refresh();
    return { ok: "Saved. Workout photos are now checked by Claude." };
  } catch (e) {
    return fail(e);
  }
}

export async function disconnectClaudeAction(_prev: FormState): Promise<FormState> {
  const db = await requireUser();
  if (await lockedOrPlanned()) return { error: "The Claude key can't be removed while real money is on: photos couldn't be checked." };
  await kvDelete(db, "claude");
  refresh();
  return { ok: "Claude key removed." };
}

// ---------- bank ----------

export async function connectBunqAction(_prev: FormState, form: FormData): Promise<FormState> {
  const db = await requireUser();
  const apiKey = String(form.get("apiKey") ?? "").trim();
  if (!apiKey) return { error: "Paste the API key first." };
  try {
    const state = await bunqConnect(apiKey);
    const client = new BunqClient(state);
    const accounts = await client.listAccounts();
    if (accounts.length === 0) return { error: "bunq connected, but no active account with an IBAN was found." };
    // Test money and real money never share the books: see lib/bank-switch.ts.
    const now = new Date();
    const plan = await planBankSwitch(db, localDate(now), state.env);
    if (plan.kind === "refuse") return { error: plan.why };
    await applyBankSwitch(db, now, state.env, plan);
    await saveBunq(db, client.useAccount(accounts[0]));
    await logEvent(db, now, "bank", `bunq connected (${state.env})`);
    refresh();
    const from = `Penalties leave from ${accounts[0].label} (${accounts[0].iban}).`;
    if (plan.kind === "end-test") {
      return { ok: `Connected. The test with play money is over: the days so far count as practice and real money is off until you switch it on. ${from}` };
    }
    return { ok: `Connected. ${from}` };
  } catch (e) {
    return fail(e);
  }
}

export async function disconnectBunqAction(_prev: FormState): Promise<FormState> {
  const db = await requireUser();
  if (await lockedOrPlanned()) return { error: "The bank can't be disconnected while real money is on." };
  await kvDelete(db, "bunq");
  await kvDelete(db, "bank_seen_id");
  await kvDelete(db, "bank_check");
  refresh();
  return { ok: "bunq disconnected." };
}

export async function testPaymentAction(_prev: FormState): Promise<FormState> {
  const db = await requireUser();
  try {
    const rules = (await ruleState(db, localDate(new Date()))).current.rules;
    if (!rules.friendIban || !rules.friendName) return { error: "Save your friend's name and IBAN first." };
    const client = await bunqClient(db);
    if (!client?.current.accountId) return { error: "Connect bunq first." };
    await client.pay({ amountCents: 1, iban: rules.friendIban, name: rules.friendName, description: "Showup test payment" });
    await logEvent(db, new Date(), "bank", `test payment of 1 cent to ${rules.friendName}`);
    return { ok: `€0.01 sent to ${rules.friendName}. Ask if it arrived.` };
  } catch (e) {
    return fail(e);
  }
}

// ---------- rules ----------

function euro(form: FormData, name: string): number {
  return Math.round(Number(String(form.get(name) ?? "").replace(",", ".")) * 100);
}

function num(form: FormData, name: string): number {
  return Number(String(form.get(name) ?? "").replace(",", "."));
}

export async function saveRulesAction(_prev: FormState, form: FormData): Promise<FormState> {
  const db = await requireUser();
  const today = localDate(new Date());
  const schedule: Rules["schedule"] = {};
  for (const day of WEEKDAYS) {
    const v = String(form.get(`day_${day}`) ?? "rest");
    if (v === "run" || v === "strength") schedule[day] = v as Kind;
  }
  const friendIban = normalizeIban(String(form.get("friendIban") ?? ""));
  if (friendIban && !isValidIban(friendIban)) return { error: "That IBAN is not valid. Check it for typos." };
  try {
    const current = (await ruleState(db, today)).current.rules;
    const res = await saveRules(db, today, {
      ...current,
      schedule,
      minRunKm: num(form, "minRunKm"),
      minStrengthMin: Math.round(num(form, "minStrengthMin")),
      baseCents: euro(form, "base"),
      multiplier: num(form, "multiplier"),
      capPerMissCents: euro(form, "capMiss"),
      capPerWeekCents: euro(form, "capWeek"),
      holdDays: Math.round(num(form, "holdDays")),
      // A page that was open before this field existed sends nothing: keep the current value then.
      sickDaysPerMonth: form.has("sickDays") ? Math.round(num(form, "sickDays")) : current.sickDaysPerMonth,
      friendName: String(form.get("friendName") ?? ""),
      friendIban,
    });
    refresh();
    return { ok: res.delayed ? `Saved. Because real money is on, this starts on ${longDate(res.effectiveFrom)}.` : "Saved." };
  } catch (e) {
    return fail(e);
  }
}

export async function armAction(_prev: FormState): Promise<FormState> {
  const db = await requireUser();
  try {
    const claude = await loadClaude(db);
    const bunq = await loadBunq(db);
    if (!claude?.apiKey) return { error: "Add a Claude API key first, so photos can be checked." };
    if (!bunq?.accountId) return { error: "Connect bunq first." };
    const from = await arm(db, localDate(new Date()));
    await logEvent(db, new Date(), "rules", `armed from ${from}`);
    refresh();
    return { ok: `Real money starts on ${longDate(from)}.` };
  } catch (e) {
    return fail(e);
  }
}

export async function disarmAction(_prev: FormState): Promise<FormState> {
  const db = await requireUser();
  try {
    const from = await disarm(db, localDate(new Date()));
    await logEvent(db, new Date(), "rules", `disarm planned for ${from}`);
    refresh();
    return { ok: `Real money stops on ${longDate(from)}. Until then every miss still counts.` };
  } catch (e) {
    return fail(e);
  }
}

export async function cancelPendingAction(_prev: FormState): Promise<FormState> {
  const db = await requireUser();
  await cancelPending(db, localDate(new Date()));
  refresh();
  return { ok: "The waiting change was dropped." };
}

// ---------- history ----------

export async function markIncomingAction(_prev: FormState, form: FormData): Promise<FormState> {
  const db = await requireUser();
  const id = String(form.get("id") ?? "");
  const isReturn = form.get("isReturn") === "yes";
  await db.query("UPDATE incoming SET is_return = $2, decided_by = 'user' WHERE bank_payment_id = $1", [id, isReturn]);
  await allocateReturns(db, new Date());
  refresh();
  return { ok: "Updated." };
}

export async function newFriendLinkAction(_prev: FormState): Promise<FormState> {
  const db = await requireUser();
  await kvSet(db, "friend_token", randomToken(18));
  refresh();
  return { ok: "New link made. The old one no longer works." };
}
